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
    McpServer,
    NewSessionRequest,
    RequestPermissionRequest,
    RequestPermissionResponse,
    SessionConfigOption,
    SessionNotification
} from '@agentclientprotocol/sdk';
import { AcpMessages, acpPermissionEvent, acpUpdateEvents } from './acp-events.js';
import { prepareHandover } from './acp-adapters.js';
import type { Handover } from './acp-adapters.js';
import { AgentEvents, WITHDRAWN, composeText, messageFields } from './agent-events.js';
import type { AgentEventBody, AgentEventListener, AgentStatus, FleetAgent, SendOptions } from './agent-events.js';
import { commandToSpawn } from './command-line.js';
import { MCP_PATH, MCP_SERVER_NAME } from './fleet-mcp.js';
import type { FleetToolsAccess } from './fleet-mcp.js';
import { RemoteStartReader, parseTarget, remoteCommandArguments } from './ssh.js';
import type { RemotePlace, SshOptions } from './ssh.js';
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
    /**
     * The fleet tools of this run: every session gets them as the MCP server
     * `flotti`, when the agent takes MCP over HTTP. None without it.
     */
    readonly fleetTools?: FleetToolsAccess;
    /** How `ssh` is run for an agent started on another host; tests put a pretend one in. */
    readonly ssh?: SshOptions;
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
    /** Who sent it, and what it answers or sends on. */
    readonly options: SendOptions;
    /** The message went to the agent: {@link LocalAgentProcess.send} resolves. */
    readonly accepted: () => void;
    /** The message never got to the agent: {@link LocalAgentProcess.send} rejects. */
    readonly refused: (error: Error) => void;
};
/** What the agent reads for the message of the turn. */
function promptText(turn: Turn, agentId: string): string {
    const text = composeText(turn.text, turn.options, agentId);
    return turn.options.from === undefined ? text : `[from ${turn.options.from}] ${text}`;
}
/** What is run to start the agent process, and where. */
type Invocation = { command: string; arguments: string[]; cwd?: string; env: NodeJS.ProcessEnv };
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
    /** What the session was opened with: a new session, when the context is cleared, is opened the same way. */
    sessionRequest?: NewSessionRequest;
    trace?: WriteStream;
    stderrLog?: WriteStream;
    /** On an SSH host: reads where the command runs and the port of the way back, from standard error. */
    startReader?: RemoteStartReader;
    /** On an SSH host: settles once {@link startReader} knows everything, or the process is gone. */
    place?: Promise<RemotePlace>;
    settlePlace?: (place: RemotePlace | Error) => void;
};
/**
 * A local agent: flotti starts it as a child process speaking ACP over
 * stdio, holds one session with it, restarts it by its policy and turns
 * everything it says into the fleet's agent events.
 */
class LocalAgentProcess implements FleetAgent {
    readonly agent: LocalAgent;
    private readonly options: Required<Omit<LocalAgentOptions, 'env' | 'logDirectory' | 'fleetTools' | 'ssh'>>;
    private readonly fleetTools: FleetToolsAccess | undefined;
    private readonly sshOptions: SshOptions;
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
    /** Set while the context is being cleared: the messages in line wait for the new session. */
    private renewing = false;
    constructor(agent: LocalAgent, options: LocalAgentOptions = {}) {
        this.agent = agent;
        this.events = new AgentEvents(agent.id);
        this.env = options.env ?? process.env;
        this.logDirectory = options.logDirectory === undefined ? join(agent.directory, 'logs') : options.logDirectory;
        this.fleetTools = options.fleetTools;
        this.sshOptions = options.ssh ?? {};
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
            // Waiting to start again: what waits in line has nowhere to go now.
            this.dropWork(`agent "${this.agentId}" stopped`);
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
     * Opens a new ACP session with the running agent: the next message goes
     * without the conversation before it. The message in work is cancelled
     * first; the messages in line go to the new session. An agent that is not
     * running gets a new session when it starts.
     */
    async clearContext(): Promise<void> {
        const run = this.run;
        if (this.lifecycle !== 'running' || run?.connection === undefined || run.sessionRequest === undefined) {
            this.session = undefined;
            return;
        }
        this.renewing = true;
        try {
            await this.cancel();
            await this.renewSession(run, run.connection, run.sessionRequest);
        } finally {
            this.renewing = false;
        }
        this.pump();
    }
    /** The new session of {@link clearContext}; an agent that cannot open one is failed and restarted by its policy. */
    private async renewSession(run: Run, connection: acp.ClientConnection, request: NewSessionRequest): Promise<void> {
        this.session = undefined;
        try {
            await this.applyModel(run, await this.newSession(connection, request, false));
        } catch (error) {
            this.fail(run, `could not open a new session: ${message(error)}`);
            throw error;
        }
    }
    /**
     * Sends a message. While the agent works on another one, the message waits
     * in line. Resolves once the message went to the agent as `session/prompt`;
     * how it ended comes as a `turn-end` event with the ACP stop reason —
     * `end_turn`, `cancelled`, … Rejects when the message never went: the
     * agent is not running, or stopped before its turn.
     *
     * A message from another agent reaches the agent as `[from <id>] <text>`:
     * ACP has no place for a sender, and the id is what the agent answers to.
     * A reply and a forward reach it as text too, the quoted or forwarded
     * message written out.
     */
    send(text: string, options: SendOptions = {}): Promise<void> {
        if (this.lifecycle !== 'running' && this.lifecycle !== 'starting' && this.lifecycle !== 'backoff') {
            return Promise.reject(new Error(`agent "${this.agentId}" is ${this.lifecycle}; start it first`));
        }
        const turnOptions = { ...options, messageId: options.messageId ?? randomUUID() };
        return new Promise((resolve, reject) => {
            const turn: Turn = { text, options: turnOptions, accepted: resolve, refused: reject };
            this.queue.push(turn);
            this.pump();
            if (this.queue.includes(turn)) {
                this.emit({ type: 'queued', messageId: turnOptions.messageId, text, ...messageFields(turnOptions) });
            }
        });
    }
    /** Takes a message that waits in line back out of it; its `send` rejects. */
    withdraw(messageId: string): boolean {
        const index = this.queue.findIndex((turn) => turn.options.messageId === messageId);
        const [turn] = index === -1 ? [] : this.queue.splice(index, 1);
        if (turn === undefined) {
            return false;
        }
        this.emit({ type: 'unqueued', messageId, outcome: 'withdrawn' });
        turn.refused(new Error(WITHDRAWN));
        return true;
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
        const started = this.spawnRun();
        if (started === undefined) {
            return;
        }
        const { handover, run } = started;
        try {
            await this.handshake(run, handover);
        } catch (error) {
            this.onHandshakeError(run, error);
            return;
        }
        if (run !== this.run || run.stopping) {
            return;
        }
        this.setLifecycle('running', 'ready');
        this.pump();
    }
    /** Prepares the handover and starts the process; a failure here is `fatal` at once. */
    private spawnRun(): { handover: Handover; run: Run } | undefined {
        try {
            // An agent on another host gets no variable of this machine: only what its manifest sets.
            const handover = prepareHandover(
                this.agent,
                this.agent.ssh === undefined ? { ...this.env, ...this.agent.env } : this.agent.env
            );
            const run = this.spawn(handover);
            return { handover, run };
        } catch (error) {
            this.giveUp(`cannot start: ${message(error)}`);
            return undefined;
        }
    }
    private onHandshakeError(run: Run, error: unknown): void {
        if (run.connection?.signal.aborted && !isPermanent(error)) {
            // The process closed its output: its exit, due any moment, tells more than the closed connection.
            return;
        }
        if (run === this.run && !run.stopping) {
            this.fail(run, message(error), error instanceof PermanentFailure || isPermanent(error));
        }
    }
    private spawn(handover: Handover): Run {
        const how = this.command(handover);
        const child = this.spawnChild(how);
        const logs = this.openLogs();
        const exited = this.watchExit(child, how.command, () => run);
        const run = newRun(child, exited, logs);
        this.watchRemoteStart(run);
        this.run = run;
        this.watchStdio(run);
        this.showNotes(handover);
        return run;
    }
    private spawnChild(how: Invocation): ChildProcess {
        const posix = process.platform !== 'win32';
        // On Windows `npx` and `codex` are `.cmd` scripts: they go through `cmd.exe`, which
        // taskkill /T stops together with everything under it.
        const target = commandToSpawn(how.command, how.arguments, { env: how.env, ...(how.cwd === undefined ? {} : { cwd: how.cwd }) });
        return spawn(target.command, target.arguments, {
            ...(how.cwd === undefined ? {} : { cwd: how.cwd }),
            env: how.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            // Its own process group, so stopping it reaches what it started: the
            // adapter runs `claude` or `codex`, and those run MCP servers.
            detached: posix,
            windowsHide: true,
            ...(target.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {})
        });
    }
    /** Settles once the process is gone, and hands its end to {@link onExit}. */
    private watchExit(child: ChildProcess, command: string, runOf: () => Run): Promise<void> {
        return new Promise<void>((resolve) => {
            child.once('exit', (code, signal) => {
                resolve();
                this.onExit(runOf(), code, signal);
            });
            child.once('error', (error: NodeJS.ErrnoException) => {
                if (child.pid === undefined) {
                    const run = runOf();
                    // Never started: there will be no exit event.
                    resolve();
                    run.failure = error.code === 'ENOENT'
                        ? `command not found: ${command}`
                        : `cannot start ${command}: ${error.message}`;
                    run.permanent = true;
                    this.onExit(run, null, null);
                }
            });
        });
    }
    private watchStdio(run: Run): void {
        const { child } = run;
        child.stdin?.on('error', () => undefined);
        child.stdout?.on('error', () => undefined);
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => this.onStderr(run, chunk));
    }
    private showNotes(handover: Handover): void {
        for (const note of handover.notes) {
            this.emit({ type: 'log', source: 'flotti', text: note });
        }
    }
    /** On an SSH host, standard error says where the command runs: {@link Run.place} waits for it. */
    private watchRemoteStart(run: Run): void {
        if (this.agent.ssh === undefined) {
            return;
        }
        run.startReader = new RemoteStartReader(this.fleetTools !== undefined);
        run.place = new Promise((resolve, reject) => {
            run.settlePlace = (place) => place instanceof Error ? reject(place) : resolve(place);
        });
        run.place.catch(() => undefined);
    }
    /**
     * How the process is started: the manifest's command here, or `ssh` running
     * it on the host — with the environment of the manifest only, and a reverse
     * tunnel for the fleet tools.
     */
    private command(handover: Handover): Invocation {
        if (this.agent.ssh === undefined) {
            return {
                command: this.agent.command,
                arguments: [...this.agent.arguments],
                cwd: this.agent.workdir,
                env: { ...this.env, ...this.agent.env, ...handover.env }
            };
        }
        return this.remoteCommand(this.agent.ssh, handover);
    }
    private remoteCommand(target: string, handover: Handover): Invocation {
        const args = remoteCommandArguments(parseTarget(target), {
            command: this.agent.command,
            arguments: this.agent.arguments,
            env: { ...this.agent.env, ...handover.env },
            workdir: this.agent.workdir,
            ...(this.fleetTools === undefined ? {} : { reversePort: this.fleetTools.port })
        }, this.sshOptions);
        return {
            command: this.sshOptions.command ?? 'ssh',
            arguments: [...(this.sshOptions.prefix ?? []), ...args],
            env: { ...this.env }
        };
    }
    private async handshake(run: Run, handover: Handover): Promise<void> {
        const connection = this.connect(run);
        const capabilities = await connection.agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {}
        });
        run.capabilities = capabilities;
        // Not sooner: before its first answer the agent may still be downloading under npx.
        this.startHeartbeat(run);
        const place = run.place === undefined ? undefined : await this.remotePlace(run.place);
        await this.applyModel(run, await this.openSession(run, connection, capabilities, handover, place));
    }
    /** Speaks ACP over the process's stdio; the connection becomes the run's. */
    private connect(run: Run): acp.ClientConnection {
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
        return connection;
    }
    /** Waits until the host said where the command runs; a host that does not say in time is a failed start. */
    private async remotePlace(place: Promise<RemotePlace>): Promise<RemotePlace> {
        const timeoutMs = this.sshOptions.readyTimeoutMs ?? 20_000;
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(
                `${this.agent.ssh} did not say where the agent runs within ${timeoutMs} ms`
            )), timeoutMs);
        });
        try {
            return await Promise.race([place, late]);
        } finally {
            clearTimeout(timer);
        }
    }
    /**
     * The fleet tools as an MCP server of the session: over HTTP — the port here,
     * or the reverse tunnel's port on the host — with the agent's own token.
     */
    private mcpServers(capabilities: InitializeResponse, place: RemotePlace | undefined): McpServer[] {
        const tools = this.fleetTools;
        if (tools === undefined) {
            return [];
        }
        if (capabilities.agentCapabilities?.mcpCapabilities?.http !== true) {
            this.log('the fleet tools are not given: the agent takes no MCP server over HTTP');
            return [];
        }
        const port = place?.reversePort ?? tools.port;
        return [{
            type: 'http',
            name: MCP_SERVER_NAME,
            url: `http://127.0.0.1:${port}${MCP_PATH}`,
            headers: [{ name: 'Authorization', value: `Bearer ${tools.token}` }]
        }];
    }
    /**
     * Picks the previous session up when the agent can — `session/resume`, else
     * `session/load` — or opens a new one; returns the session config options.
     */
    private async openSession(
        run: Run,
        connection: acp.ClientConnection,
        capabilities: InitializeResponse,
        handover: Handover,
        place: RemotePlace | undefined
    ): Promise<SessionConfigOption[] | null | undefined> {
        const agentCapabilities = capabilities.agentCapabilities;
        const common = this.sessionParameters(capabilities, handover, place);
        run.sessionRequest = common;
        const previous = this.session;
        if (previous !== undefined && agentCapabilities?.sessionCapabilities?.resume) {
            return await this.resumeSession(connection, common, previous);
        }
        if (previous !== undefined && agentCapabilities?.loadSession) {
            return await this.loadSession(run, connection, common, previous);
        }
        return await this.newSession(connection, common, previous !== undefined);
    }
    /** What `session/new`, `session/resume` and `session/load` have in common. */
    private sessionParameters(
        capabilities: InitializeResponse,
        handover: Handover,
        place: RemotePlace | undefined
    ): NewSessionRequest {
        const directories = capabilities.agentCapabilities?.sessionCapabilities?.additionalDirectories
            ? { additionalDirectories: [...handover.additionalDirectories] }
            : {};
        return {
            cwd: place?.cwd ?? this.agent.workdir,
            mcpServers: this.mcpServers(capabilities, place),
            ...directories,
            ...(handover.meta === undefined ? {} : { _meta: { ...handover.meta } })
        };
    }
    private async resumeSession(
        connection: acp.ClientConnection,
        common: NewSessionRequest,
        previous: string
    ): Promise<SessionConfigOption[] | null | undefined> {
        const response = await connection.agent.request(
            acp.methods.agent.session.resume,
            { ...common, sessionId: previous }
        );
        return response.configOptions;
    }
    /** `session/load`: the agent replays the history, which is not news. */
    private async loadSession(
        run: Run,
        connection: acp.ClientConnection,
        common: NewSessionRequest,
        previous: string
    ): Promise<SessionConfigOption[] | null | undefined> {
        run.replaying = true;
        try {
            const response = await connection.agent.request(
                acp.methods.agent.session.load,
                { ...common, sessionId: previous }
            );
            return response.configOptions;
        } finally {
            run.replaying = false;
        }
    }
    private async newSession(
        connection: acp.ClientConnection,
        common: NewSessionRequest,
        lost: boolean
    ): Promise<SessionConfigOption[] | null | undefined> {
        if (lost) {
            this.log('the agent can neither resume nor load a session: a new one is started, the context is lost');
        }
        const response = await connection.agent.request(acp.methods.agent.session.new, common);
        this.session = response.sessionId;
        return response.configOptions;
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
            this.log(`model "${model}" is not applied: the agent offers no model option`);
            return;
        }
        await this.setModel(run.connection, this.session, option.id, model);
    }
    private async setModel(connection: acp.ClientConnection, sessionId: string, configId: string, model: string): Promise<void> {
        try {
            await connection.agent.request(acp.methods.agent.session.setConfigOption, {
                sessionId,
                configId,
                value: model
            });
        } catch (error) {
            throw new PermanentFailure(`the agent refused model "${model}": ${message(error)}`);
        }
    }
    // --- running ---------------------------------------------------------------------------------------------
    private pump(): void {
        const run = this.run;
        if (this.active !== undefined || this.renewing || this.lifecycle !== 'running' || run?.connection === undefined) {
            return;
        }
        const turn = this.queue.shift();
        if (turn === undefined || this.session === undefined) {
            return;
        }
        this.active = turn;
        this.messages.reset();
        this.showUserMessage(turn);
        turn.accepted();
        this.showStatus();
        this.prompt(run, run.connection, this.session, turn);
    }
    private showUserMessage(turn: Turn): void {
        this.emit({
            type: 'message',
            role: 'user',
            messageId: turn.options.messageId ?? randomUUID(),
            text: turn.text,
            append: false,
            ...messageFields(turn.options)
        });
    }
    /** Sends the message as `session/prompt`; its answer, or its failure, ends the turn. */
    private prompt(run: Run, connection: acp.ClientConnection, sessionId: string, turn: Turn): void {
        connection.agent.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: promptText(turn, this.agentId) }]
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
        const reader = run.startReader;
        const lines = reader === undefined ? chunk.split(/\r?\n/) : reader.read(chunk);
        const place = reader?.place;
        if (place !== undefined) {
            run.settlePlace?.(place);
        }
        for (const line of lines) {
            if (line.trim() !== '') {
                this.emit({ type: 'log', source: 'agent', text: line });
            }
        }
    }
    /** Sees every message both ways: for the trace file, and as a sign of life. */
    private tap(run: Run, stream: acp.Stream): acp.Stream {
        const record = (direction: 'in' | 'out', message: AnyMessage): void => traceMessage(run, direction, message);
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
        this.closeRun(run);
        if (run !== this.run) {
            return;
        }
        this.run = undefined;
        const how = run.failure ?? (signal !== null ? `killed by ${signal}` : `exited with code ${code}`);
        this.dropWork(`agent "${this.agentId}" stopped: ${how}`);
        if (run.stopping) {
            return;
        }
        this.afterExit(run, code, how);
    }
    /** Lets go of what the ended run held. */
    private closeRun(run: Run): void {
        if (run.heartbeat !== undefined) {
            clearInterval(run.heartbeat);
        }
        run.settlePlace?.(new Error('the process ended before the host said where it runs'));
        run.connection?.close();
        run.trace?.end();
        run.stderrLog?.end();
    }
    /** After a stop nobody asked for: gives up, leaves it `exited`, or restarts it — by its policy. */
    private afterExit(run: Run, code: number | null, how: string): void {
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
        this.scheduleRestart(run, how);
    }
    /** Waits longer after every failed start in a row, and gives up after too many. */
    private scheduleRestart(run: Run, how: string): void {
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
            this.emit({ type: 'unqueued', messageId: turn.options.messageId ?? '', outcome: 'dropped', reason });
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
        const status = this.currentStatus();
        const shown = detail ?? (status === this.shownStatus ? this.shownDetail : undefined);
        if (status === this.shownStatus && shown === this.shownDetail) {
            return;
        }
        this.shownStatus = status;
        this.shownDetail = shown;
        this.emit({ type: 'status', status, ...(shown === undefined ? {} : { reason: shown }) });
    }
    private currentStatus(): AgentStatus {
        switch (this.lifecycle) {
            case 'starting':
            case 'backoff':
                return 'starting';
            case 'running':
                return this.permissions.size > 0 ? 'waiting' : this.active !== undefined ? 'working' : 'idle';
            case 'fatal':
                return 'error';
            default:
                return 'stopped';
        }
    }
    private emit(body: AgentEventBody): void {
        this.events.emit(body);
    }
    /** A line of flotti's own in the agent's log. */
    private log(text: string): void {
        this.emit({ type: 'log', source: 'flotti', text });
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
function newRun(child: ChildProcess, exited: Promise<void>, logs: { trace?: WriteStream; stderrLog?: WriteStream }): Run {
    return {
        child,
        spawnedAt: Date.now(),
        exited,
        lastSeen: Date.now(),
        stopping: false,
        permanent: false,
        replaying: false,
        ...logs
    };
}
/** One line of `acp.jsonl`. */
function traceMessage(run: Run, direction: 'in' | 'out', message: AnyMessage): void {
    run.trace?.write(`${JSON.stringify({ time: new Date().toISOString(), direction, message })}\n`);
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
