import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type {
    AnyMessage,
    InitializeResponse,
    RequestPermissionRequest,
    RequestPermissionResponse,
    SessionConfigOption,
    SessionNotification
} from '@agentclientprotocol/sdk';
import { AcpMessages, acpPermissionEvent, acpUpdateEvents } from './acp-events.js';
import { prepareHandover } from './acp-adapters.js';
import type { Handover } from './acp-adapters.js';
import { AgentEvents } from './agent-events.js';
import type { AgentEventBody, AgentEventListener, AgentStatus, FleetAgent } from './agent-events.js';
import type { LocalAgent } from './types.js';
/**
 * Where the agent process is, after supervisord:
 * - `stopped`  — not started, or stopped by a person;
 * - `starting` — the process is up, and the ACP handshake and the session are not done yet;
 * - `running`  — the session is ready for messages;
 * - `backoff`  — it stopped when it should not have, and flotti waits before the next try;
 * - `stopping` — being stopped by a person;
 * - `exited`   — it stopped by itself, and the restart policy says to leave it so;
 * - `fatal`    — flotti gave up: it keeps failing, or fails in a way a retry cannot fix.
 */
type LifecycleState = 'stopped' | 'starting' | 'running' | 'backoff' | 'stopping' | 'exited' | 'fatal';
/** What flotti needs besides the manifest. The defaults suit people; tests pass small numbers. */
type LocalAgentOptions = {
    /** Environment the agent inherits before the manifest adds to it; defaults to `process.env`. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** A process that stops sooner than this after its start counts as a failed start. */
    readonly startSecs?: number;
    /** Failed starts in a row before flotti gives up and goes `fatal`. */
    readonly maxRetries?: number;
    /** First delay before a restart; every failed start in a row doubles it. */
    readonly backoffBaseMs?: number;
    /** The delay never grows past this. */
    readonly backoffMaxMs?: number;
    /** How long a cancelled message may take to end before the process is killed. */
    readonly cancelTimeoutMs?: number;
    /** How long the process has after SIGTERM before SIGKILL. */
    readonly stopTimeoutMs?: number;
    /**
     * Where `acp.jsonl` (every ACP message both ways) and `stderr.log` go;
     * `<agent directory>/logs` by default, `null` for no files at all.
     */
    readonly logDirectory?: string | null;
};
const DEFAULTS = {
    startSecs: 10,
    maxRetries: 3,
    backoffBaseMs: 1000,
    backoffMaxMs: 15_000,
    cancelTimeoutMs: 5000,
    stopTimeoutMs: 5000
};
/** Extension request flotti sends to see the agent is alive; any answer, an error too, will do. */
const HEARTBEAT_METHOD = '_flotti/heartbeat';
/** JSON-RPC errors a retry cannot fix: the agent wants a login, or refuses what the manifest asks for. */
const AUTH_REQUIRED = -32000;
const INVALID_PARAMS = -32602;
/** A failure that a restart would only repeat. */
class PermanentFailure extends Error {}
type Turn = {
    readonly text: string;
    /** The message went to the agent: {@link LocalAgentProcess.send} resolves. */
    readonly accepted: () => void;
    /** The message never got to the agent: {@link LocalAgentProcess.send} rejects. */
    readonly refused: (error: Error) => void;
};
/** One life of the agent process, from spawn to exit. */
type Run = {
    readonly child: ChildProcess;
    readonly spawnedAt: number;
    readonly exited: Promise<void>;
    connection?: acp.ClientConnection;
    capabilities?: InitializeResponse;
    lastSeen: number;
    heartbeat?: NodeJS.Timeout;
    /** Set when flotti itself ends the process: then its exit is no surprise. */
    stopping: boolean;
    /** Why flotti ended the process, when it did so because something went wrong. */
    failure?: string;
    permanent: boolean;
    /** While `session/load` replays the history, its updates are not news. */
    replaying: boolean;
    trace?: WriteStream;
    stderrLog?: WriteStream;
};
/**
 * A local agent: flotti starts it as a child process speaking ACP over
 * stdio, holds one session with it, restarts it by its policy and turns
 * everything it says into the fleet's agent events.
 */
class LocalAgentProcess implements FleetAgent {
    readonly agent: LocalAgent;
    private readonly options: Required<Omit<LocalAgentOptions, 'env' | 'logDirectory'>>;
    private readonly env: Readonly<Record<string, string | undefined>>;
    private readonly logDirectory: string | null;
    private readonly events: AgentEvents;
    /** Ids for the pieces of the agent's answers. */
    private readonly messages = new AcpMessages();
    private lifecycle: LifecycleState = 'stopped';
    private shownStatus: AgentStatus = 'stopped';
    private shownDetail: string | undefined;
    private run: Run | undefined;
    private session: string | undefined;
    private retries = 0;
    private backoffTimer: NodeJS.Timeout | undefined;
    private readonly queue: Turn[] = [];
    private active: Turn | undefined;
    private readonly permissions = new Map<string, (response: RequestPermissionResponse) => void>();
    private permissionCount = 0;
    private waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
    constructor(agent: LocalAgent, options: LocalAgentOptions = {}) {
        this.agent = agent;
        this.events = new AgentEvents(agent.id);
        this.env = options.env ?? process.env;
        this.logDirectory = options.logDirectory === undefined ? join(agent.directory, 'logs') : options.logDirectory;
        this.options = {
            startSecs: options.startSecs ?? DEFAULTS.startSecs,
            maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
            backoffBaseMs: options.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
            backoffMaxMs: options.backoffMaxMs ?? DEFAULTS.backoffMaxMs,
            cancelTimeoutMs: options.cancelTimeoutMs ?? DEFAULTS.cancelTimeoutMs,
            stopTimeoutMs: options.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs
        };
    }
    get agentId(): string {
        return this.agent.id;
    }
    get state(): LifecycleState {
        return this.lifecycle;
    }
    get status(): AgentStatus {
        return this.shownStatus;
    }
    /** Id of the ACP session; kept across restarts so the agent can pick the conversation up. */
    get sessionId(): string | undefined {
        return this.session;
    }
    /** What the agent said about itself in `initialize`: capabilities, login methods, name. */
    get capabilities(): InitializeResponse | undefined {
        return this.run?.capabilities;
    }
    subscribe(listener: AgentEventListener): () => void {
        return this.events.subscribe(listener);
    }
    /**
     * Starts the agent with a new session. Resolves once it is ready for
     * messages; rejects when it ends up `exited` or `fatal` instead — after
     * the retries its policy allows.
     */
    start(): Promise<void> {
        if (this.lifecycle === 'running') {
            return Promise.resolve();
        }
        const ready = this.whenReady();
        if (this.lifecycle !== 'starting' && this.lifecycle !== 'backoff' && this.lifecycle !== 'stopping') {
            this.retries = 0;
            this.session = undefined;
            void this.launch();
        }
        return ready;
    }
    /** Stops the agent: cancels the message in work, then ends the process and its children. */
    async stop(): Promise<void> {
        this.clearBackoff();
        const run = this.run;
        if (run === undefined) {
            this.setLifecycle('stopped', 'stopped');
            return;
        }
        run.stopping = true;
        this.setLifecycle('stopping', 'stopping');
        if (this.active !== undefined && run.connection !== undefined && this.session !== undefined) {
            const turn = this.active;
            this.cancelPermissions();
            await run.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.session })
                .catch(() => undefined);
            await this.waitForTurnEnd(turn, this.options.cancelTimeoutMs);
        }
        await this.terminate(run);
        this.setLifecycle('stopped', 'stopped');
    }
    /**
     * Stops the agent and starts it again, picking the same session up when
     * the agent can: `session/resume`, else `session/load`. An agent that can
     * do neither gets a new session, and a log event says the context is lost.
     */
    async restart(): Promise<void> {
        const session = this.session;
        await this.stop();
        this.retries = 0;
        this.session = session;
        const ready = this.whenReady();
        void this.launch();
        return ready;
    }
    /**
     * Sends a message. While the agent works on another one, the message waits
     * in line. Resolves once the message went to the agent as `session/prompt`;
     * how it ended comes as a `turn-end` event with the ACP stop reason —
     * `end_turn`, `cancelled`, … Rejects when the message never went: the
     * agent is not running, or stopped before its turn.
     */
    send(text: string): Promise<void> {
        if (this.lifecycle !== 'running' && this.lifecycle !== 'starting' && this.lifecycle !== 'backoff') {
            return Promise.reject(new Error(`agent "${this.agentId}" is ${this.lifecycle}; start it first`));
        }
        return new Promise((resolve, reject) => {
            this.queue.push({ text, accepted: resolve, refused: reject });
            this.pump();
        });
    }
    /**
     * Asks the agent to drop the message it works on. Open permission requests
     * are answered `cancelled`, as ACP requires. An agent that does not end the
     * message in time is killed and restarted by its policy.
     */
    async cancel(): Promise<void> {
        const run = this.run;
        const turn = this.active;
        if (run?.connection === undefined || turn === undefined || this.session === undefined) {
            return;
        }
        this.cancelPermissions();
        await run.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.session })
            .catch(() => undefined);
        if (!await this.waitForTurnEnd(turn, this.options.cancelTimeoutMs)) {
            this.fail(run, `did not end the cancelled message within ${this.options.cancelTimeoutMs} ms`);
        }
    }
    /**
     * Answers a permission request with one of the options it offered, or
     * with `cancelled` when no option is given.
     *
     * @returns Whether such a request was waiting.
     */
    answerPermission(requestId: string, optionId?: string): boolean {
        const answer = this.permissions.get(requestId);
        if (answer === undefined) {
            return false;
        }
        this.permissions.delete(requestId);
        answer({ outcome: optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } });
        this.showStatus();
        return true;
    }
    // --- starting --------------------------------------------------------------------------------------------
    private async launch(): Promise<void> {
        this.clearBackoff();
        this.setLifecycle('starting', this.retries === 0 ? 'starting' : `starting, try ${this.retries + 1}`);
        let handover: Handover;
        let run: Run;
        try {
            handover = prepareHandover(this.agent, { ...this.env, ...this.agent.env });
            run = this.spawn(handover);
        } catch (error) {
            this.giveUp(`cannot start: ${message(error)}`);
            return;
        }
        try {
            await this.handshake(run, handover);
        } catch (error) {
            if (run.connection?.signal.aborted && !isPermanent(error)) {
                // The process closed its output: its exit, due any moment, tells more than the closed connection.
                return;
            }
            if (run === this.run && !run.stopping) {
                this.fail(run, message(error), error instanceof PermanentFailure || isPermanent(error));
            }
            return;
        }
        if (run !== this.run || run.stopping) {
            return;
        }
        this.setLifecycle('running', 'ready');
        this.pump();
    }
    private spawn(handover: Handover): Run {
        const posix = process.platform !== 'win32';
        const child = spawn(this.agent.command, [...this.agent.arguments], {
            cwd: this.agent.workdir,
            env: { ...this.env, ...this.agent.env, ...handover.env },
            stdio: ['pipe', 'pipe', 'pipe'],
            // Its own process group, so stopping it reaches what it started: the
            // adapter runs `claude` or `codex`, and those run MCP servers.
            detached: posix,
            windowsHide: true
        });
        const logs = this.openLogs();
        const exited = new Promise<void>((resolve) => {
            child.once('exit', (code, signal) => {
                resolve();
                this.onExit(run, code, signal);
            });
            child.once('error', (error: NodeJS.ErrnoException) => {
                if (child.pid === undefined) {
                    // Never started: there will be no exit event.
                    resolve();
                    run.failure = error.code === 'ENOENT'
                        ? `command not found: ${this.agent.command}`
                        : `cannot start ${this.agent.command}: ${error.message}`;
                    run.permanent = true;
                    this.onExit(run, null, null);
                }
            });
        });
        const run: Run = {
            child,
            spawnedAt: Date.now(),
            exited,
            lastSeen: Date.now(),
            stopping: false,
            permanent: false,
            replaying: false,
            ...logs
        };
        this.run = run;
        child.stdin?.on('error', () => undefined);
        child.stdout?.on('error', () => undefined);
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => this.onStderr(run, chunk));
        for (const note of handover.notes) {
            this.emit({ type: 'log', source: 'flotti', text: note });
        }
        return run;
    }
    private async handshake(run: Run, handover: Handover): Promise<void> {
        const { child } = run;
        if (child.stdin === null || child.stdout === null) {
            throw new Error('the agent process has no stdio');
        }
        const stream = this.tap(run, acp.ndJsonStream(
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
        ));
        const connection = acp.client({ name: 'flotti' })
            .onRequest(acp.methods.client.session.requestPermission, (context) => this.onPermission(run, context.params))
            .onNotification(acp.methods.client.session.update, (context) => this.onUpdate(run, context.params))
            .connect(stream);
        run.connection = connection;
        const capabilities = await connection.agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {}
        });
        run.capabilities = capabilities;
        // Not sooner: before its first answer the agent may still be downloading under npx.
        this.startHeartbeat(run);
        await this.applyModel(run, await this.openSession(run, connection, capabilities, handover));
    }
    /**
     * Picks the previous session up when the agent can — `session/resume`, else
     * `session/load` — or opens a new one; returns the session config options.
     */
    private async openSession(
        run: Run,
        connection: acp.ClientConnection,
        capabilities: InitializeResponse,
        handover: Handover
    ): Promise<SessionConfigOption[] | null | undefined> {
        const agentCapabilities = capabilities.agentCapabilities;
        const directories = agentCapabilities?.sessionCapabilities?.additionalDirectories
            ? { additionalDirectories: [...handover.additionalDirectories] }
            : {};
        const common = {
            cwd: this.agent.workdir,
            mcpServers: [],
            ...directories,
            ...(handover.meta === undefined ? {} : { _meta: { ...handover.meta } })
        };
        const previous = this.session;
        let configOptions: SessionConfigOption[] | null | undefined;
        if (previous !== undefined && agentCapabilities?.sessionCapabilities?.resume) {
            const response = await connection.agent.request(
                acp.methods.agent.session.resume,
                { ...common, sessionId: previous }
            );
            configOptions = response.configOptions;
        } else if (previous !== undefined && agentCapabilities?.loadSession) {
            run.replaying = true;
            try {
                const response = await connection.agent.request(
                    acp.methods.agent.session.load,
                    { ...common, sessionId: previous }
                );
                configOptions = response.configOptions;
            } finally {
                run.replaying = false;
            }
        } else {
            if (previous !== undefined) {
                this.emit({
                    type: 'log',
                    source: 'flotti',
                    text: 'the agent can neither resume nor load a session: a new one is started, the context is lost'
                });
            }
            const response = await connection.agent.request(acp.methods.agent.session.new, common);
            this.session = response.sessionId;
            configOptions = response.configOptions;
        }
        return configOptions;
    }
    /**
     * Asks for the manifest's model through the session's `model` config option
     * — the ACP way, the same for every agent that has one.
     */
    private async applyModel(run: Run, configOptions: SessionConfigOption[] | null | undefined): Promise<void> {
        const model = this.agent.model;
        if (model === undefined || run.connection === undefined || this.session === undefined) {
            return;
        }
        const option = configOptions?.find((candidate: SessionConfigOption) =>
            candidate.category === 'model' || candidate.id === 'model');
        if (option === undefined) {
            this.emit({
                type: 'log',
                source: 'flotti',
                text: `model "${model}" is not applied: the agent offers no model option`
            });
            return;
        }
        try {
            await run.connection.agent.request(acp.methods.agent.session.setConfigOption, {
                sessionId: this.session,
                configId: option.id,
                value: model
            });
        } catch (error) {
            throw new PermanentFailure(`the agent refused model "${model}": ${message(error)}`);
        }
    }
    // --- running ---------------------------------------------------------------------------------------------
    private pump(): void {
        const run = this.run;
        if (this.active !== undefined || this.lifecycle !== 'running' || run?.connection === undefined) {
            return;
        }
        const turn = this.queue.shift();
        if (turn === undefined || this.session === undefined) {
            return;
        }
        this.active = turn;
        this.messages.reset();
        this.emit({ type: 'message', role: 'user', messageId: randomUUID(), text: turn.text, append: false });
        turn.accepted();
        this.showStatus();
        run.connection.agent.request(acp.methods.agent.session.prompt, {
            sessionId: this.session,
            prompt: [{ type: 'text', text: turn.text }]
        }).then(
            (response) => this.endTurn(turn, response.stopReason),
            (error: unknown) => {
                // A closed connection means the process is going: its exit ends the turn with the real reason.
                if (!run.connection?.signal.aborted) {
                    this.endTurn(turn, undefined, error);
                }
            }
        );
    }
    private endTurn(turn: Turn, reason: string | undefined, error?: unknown): void {
        if (this.active !== turn) {
            return;
        }
        this.active = undefined;
        // What the agent says after the turn, on its own, is a message of its own, not more of this answer.
        this.messages.reset();
        this.cancelPermissions();
        if (reason === undefined) {
            this.emit({ type: 'log', source: 'flotti', text: `the message failed: ${message(error)}` });
            this.emit({ type: 'turn-end', reason: 'error' });
        } else {
            this.emit({ type: 'turn-end', reason });
        }
        this.showStatus();
        this.pump();
    }
    private waitForTurnEnd(turn: Turn, timeoutMs: number): Promise<boolean> {
        return new Promise((resolve) => {
            const started = Date.now();
            const check = (): void => {
                if (this.active !== turn) {
                    resolve(true);
                } else if (Date.now() - started >= timeoutMs) {
                    resolve(false);
                } else {
                    setTimeout(check, 20);
                }
            };
            check();
        });
    }
    private onUpdate(run: Run, notification: SessionNotification): void {
        if (run !== this.run || run.replaying || notification.sessionId !== this.session) {
            return;
        }
        for (const event of acpUpdateEvents(notification.update, this.messages)) {
            this.emit(event);
        }
    }
    private onPermission(run: Run, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        if (run !== this.run || run.stopping) {
            return Promise.resolve({ outcome: { outcome: 'cancelled' } });
        }
        const requestId = `${this.agentId}-${++this.permissionCount}`;
        return new Promise((resolve) => {
            this.permissions.set(requestId, resolve);
            this.emit(acpPermissionEvent(requestId, request));
            this.showStatus();
        });
    }
    private cancelPermissions(): void {
        for (const requestId of [...this.permissions.keys()]) {
            this.answerPermission(requestId);
        }
    }
    private onStderr(run: Run, chunk: string): void {
        run.stderrLog?.write(chunk);
        for (const line of chunk.split(/\r?\n/)) {
            if (line.trim() !== '') {
                this.emit({ type: 'log', source: 'agent', text: line });
            }
        }
    }
    /** Sees every message both ways: for the trace file, and as a sign of life. */
    private tap(run: Run, stream: acp.Stream): acp.Stream {
        const record = (direction: 'in' | 'out', message: AnyMessage): void => {
            run.trace?.write(`${JSON.stringify({ time: new Date().toISOString(), direction, message })}\n`);
        };
        const inbound = new TransformStream<AnyMessage, AnyMessage>({
            transform(message, controller) {
                run.lastSeen = Date.now();
                record('in', message);
                controller.enqueue(message);
            }
        });
        const outbound = new TransformStream<AnyMessage, AnyMessage>({
            transform(message, controller) {
                record('out', message);
                controller.enqueue(message);
            }
        });
        stream.readable.pipeTo(inbound.writable).catch(() => undefined);
        outbound.readable.pipeTo(stream.writable).catch(() => undefined);
        return { readable: inbound.readable, writable: outbound.writable };
    }
    /**
     * ACP has no heartbeat, so flotti asks, from the answer to `initialize`
     * on: an extension request every third of the timeout. Any message from the agent counts as a sign of life — the
     * "method not found" answer too. Silence longer than the timeout is a lost
     * agent: it is killed, and its policy decides the rest.
     */
    private startHeartbeat(run: Run): void {
        const timeoutMs = this.agent.heartbeatTimeoutSec * 1000;
        run.lastSeen = Date.now();
        run.heartbeat = setInterval(() => {
            if (Date.now() - run.lastSeen > timeoutMs) {
                this.fail(run, `no heartbeat for ${this.agent.heartbeatTimeoutSec} s`);
                return;
            }
            run.connection?.agent.request(HEARTBEAT_METHOD, {}).catch(() => undefined);
        }, Math.max(timeoutMs / 3, 10));
        run.heartbeat.unref();
    }
    // --- stopping and failing --------------------------------------------------------------------------------
    /** Ends a run that went wrong; {@link onExit} decides what comes next. */
    private fail(run: Run, reason: string, permanent = false): void {
        if (run.failure !== undefined || run.stopping) {
            return;
        }
        run.failure = reason;
        run.permanent = permanent;
        void this.terminate(run, false);
    }
    private async terminate(run: Run, wait = true): Promise<void> {
        if (run.heartbeat !== undefined) {
            clearInterval(run.heartbeat);
        }
        const { child } = run;
        if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
            child.stdin?.end();
            signalGroup(child, 'SIGTERM');
            const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), this.options.stopTimeoutMs);
            timer.unref();
            await run.exited;
            clearTimeout(timer);
        } else if (wait) {
            await run.exited;
        }
    }
    private onExit(run: Run, code: number | null, signal: NodeJS.Signals | null): void {
        if (run.heartbeat !== undefined) {
            clearInterval(run.heartbeat);
        }
        run.connection?.close();
        run.trace?.end();
        run.stderrLog?.end();
        if (run !== this.run) {
            return;
        }
        this.run = undefined;
        const how = run.failure ?? (signal !== null ? `killed by ${signal}` : `exited with code ${code}`);
        this.dropWork(`agent "${this.agentId}" stopped: ${how}`);
        if (run.stopping) {
            return;
        }
        if (run.permanent) {
            this.giveUp(how);
            return;
        }
        const failed = run.failure !== undefined || code !== 0;
        const policy = this.agent.restart;
        if (policy === 'never' || (policy === 'on-failure' && !failed)) {
            this.setLifecycle('exited', how);
            return;
        }
        const lived = Date.now() - run.spawnedAt;
        this.retries = lived < this.options.startSecs * 1000 ? this.retries + 1 : 1;
        if (this.retries > this.options.maxRetries) {
            this.giveUp(`${how}; gave up after ${this.options.maxRetries} restarts in a row`);
            return;
        }
        const delay = Math.min(
            this.options.backoffBaseMs * 2 ** (this.retries - 1),
            this.options.backoffMaxMs
        );
        this.setLifecycle('backoff', `${how}; restarting in ${delay} ms`);
        this.backoffTimer = setTimeout(() => {
            this.backoffTimer = undefined;
            void this.launch();
        }, delay);
    }
    /**
     * Messages die with the process: an answer that was on its way is gone —
     * its turn ends with `error`, and the status says why — and a queued one
     * has nowhere to go, so its `send` rejects.
     */
    private dropWork(reason: string): void {
        this.cancelPermissions();
        if (this.active !== undefined) {
            this.emit({ type: 'turn-end', reason: 'error' });
        }
        this.active = undefined;
        for (const turn of this.queue.splice(0)) {
            turn.refused(new Error(reason));
        }
    }
    private giveUp(reason: string): void {
        this.dropWork(`agent "${this.agentId}" gave up: ${reason}`);
        this.setLifecycle('fatal', reason);
    }
    private clearBackoff(): void {
        if (this.backoffTimer !== undefined) {
            clearTimeout(this.backoffTimer);
            this.backoffTimer = undefined;
        }
    }
    // --- state and events ------------------------------------------------------------------------------------
    private whenReady(): Promise<void> {
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }
    /** Moves to another state; `running` ends the wait of {@link start} well, `stopped`, `exited` and `fatal` badly. */
    private setLifecycle(state: LifecycleState, detail: string): void {
        this.lifecycle = state;
        if (state === 'running' || state === 'stopped' || state === 'exited' || state === 'fatal') {
            const waiters = this.waiters.splice(0);
            for (const waiter of waiters) {
                if (state === 'running') {
                    waiter.resolve();
                } else {
                    waiter.reject(new Error(`agent "${this.agentId}" is ${state}: ${detail}`));
                }
            }
        }
        this.showStatus(detail);
    }
    /** The status people see follows from the lifecycle and from what the agent is busy with. */
    private showStatus(detail?: string): void {
        let status: AgentStatus;
        switch (this.lifecycle) {
            case 'starting':
            case 'backoff':
                status = 'starting';
                break;
            case 'running':
                status = this.permissions.size > 0 ? 'waiting' : this.active !== undefined ? 'working' : 'idle';
                break;
            case 'fatal':
                status = 'error';
                break;
            default:
                status = 'stopped';
        }
        const shown = detail ?? (status === this.shownStatus ? this.shownDetail : undefined);
        if (status === this.shownStatus && shown === this.shownDetail) {
            return;
        }
        this.shownStatus = status;
        this.shownDetail = shown;
        this.emit({ type: 'status', status, ...(shown === undefined ? {} : { reason: shown }) });
    }
    private emit(body: AgentEventBody): void {
        this.events.emit(body);
    }
    private openLogs(): { trace?: WriteStream; stderrLog?: WriteStream } {
        if (this.logDirectory === null) {
            return {};
        }
        mkdirSync(this.logDirectory, { recursive: true });
        const trace = createWriteStream(join(this.logDirectory, 'acp.jsonl'), { flags: 'a' });
        const stderrLog = createWriteStream(join(this.logDirectory, 'stderr.log'), { flags: 'a' });
        trace.on('error', () => undefined);
        stderrLog.on('error', () => undefined);
        return { trace, stderrLog };
    }
}
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (pid === undefined) {
        return;
    }
    try {
        if (process.platform === 'win32') {
            // No process groups: taskkill walks the tree instead.
            spawn('taskkill', ['/pid', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], {
                stdio: 'ignore',
                windowsHide: true
            }).on('error', () => undefined);
        } else {
            process.kill(-pid, signal);
        }
    } catch {
        // Already gone.
    }
}
function isPermanent(error: unknown): boolean {
    return error instanceof acp.RequestError && (error.code === AUTH_REQUIRED || error.code === INVALID_PARAMS);
}
function message(error: unknown): string {
    if (error instanceof acp.RequestError) {
        const hint = error.code === AUTH_REQUIRED ? ' (the agent wants a login first)' : '';
        return `${error.message}${hint}`;
    }
    return error instanceof Error ? error.message : String(error);
}
export { LocalAgentProcess };
export type { LifecycleState, LocalAgentOptions };
