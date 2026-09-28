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
    ContentBlock,
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
import type { Handover, MemoryHandover } from './acp-adapters.js';
import { AgentEvents, WITHDRAWN, composeText, messageFields } from './agent-events.js';
import type { AgentEventBody, AgentEventListener, AgentStatus, FleetAgent, SendOptions } from './agent-events.js';
import { commandToSpawn } from './command-line.js';
import type { MemoryStatus } from './dashboard-protocol.js';
import { describeError } from './describe-error.js';
import { MCP_PATH, MCP_SERVER_NAME } from './fleet-mcp.js';
import type { FleetToolsAccess } from './fleet-mcp.js';
import { INDEX_MAX_CHARS, INDEX_MAX_NOTES, firstPromptBlocks } from './memory-contract.js';
import { MemoryStore } from './memory-store.js';
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
/** The numbers of {@link LocalAgentOptions}, each one given or its default. */
type Timing = typeof DEFAULTS;
function timing(options: LocalAgentOptions): Timing {
    const keys = Object.keys(DEFAULTS) as (keyof Timing)[];
    return Object.fromEntries(keys.map((key) => [key, options[key] ?? DEFAULTS[key]])) as Timing;
}
/** Where the logs of the agent go: `<agent directory>/logs` unless the options say otherwise. */
function logDirectoryOf(agent: LocalAgent, options: LocalAgentOptions): string | null {
    return options.logDirectory === undefined ? join(agent.directory, 'logs') : options.logDirectory;
}
/** States in which a start is already on its way: {@link LocalAgentProcess.start} only waits. */
const LAUNCHING: ReadonlySet<LifecycleState> = new Set([ 'starting', 'backoff', 'stopping' ]);
/** States in which a message may be sent: it waits in line until the agent is ready. */
const SENDABLE: ReadonlySet<LifecycleState> = new Set([ 'running', 'starting', 'backoff' ]);
/** States that end the wait of {@link LocalAgentProcess.start}: well for `running`, badly for the rest. */
const SETTLING: ReadonlySet<LifecycleState> = new Set([ 'running', 'stopped', 'exited', 'fatal' ]);
/** The status people see in a state, besides `running`, which depends on the work; `stopped` for the rest. */
const STATUS_OF: ReadonlyMap<LifecycleState, AgentStatus> = new Map([
    [ 'starting', 'starting' ],
    [ 'backoff', 'starting' ],
    [ 'fatal', 'error' ]
]);
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
/** The status line of a start: which try it is, after failed ones. */
function startingDetail(retries: number): string {
    return retries === 0 ? 'starting' : `starting, try ${retries + 1}`;
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
    /**
     * What goes before the first message of the session just opened: the rule
     * of the memory and the index of the bank (#101). Taken by that message.
     */
    primer?: readonly string[];
    trace?: WriteStream;
    stderrLog?: WriteStream;
    /** On an SSH host: reads where the command runs and the port of the way back, from standard error. */
    startReader?: RemoteStartReader;
    /** On an SSH host: settles once {@link startReader} knows everything, or the process is gone. */
    place?: Promise<RemotePlace>;
    settlePlace?: (place: RemotePlace | Error) => void;
};
/** A message and everything needed to speak about it with the agent: the run, its connection, the session. */
type Work = {
    readonly run: Run;
    readonly connection: acp.ClientConnection;
    readonly sessionId: string;
    readonly turn: Turn;
};
/** A running agent whose context can be cleared: the new session is opened as the old one was. */
type Renewal = {
    readonly run: Run;
    readonly connection: acp.ClientConnection;
    readonly request: NewSessionRequest;
};
/**
 * A local agent: flotti starts it as a child process speaking ACP over
 * stdio, holds one session with it, restarts it by its policy and turns
 * everything it says into the fleet's agent events.
 */
class LocalAgentProcess implements FleetAgent {
    readonly agent: LocalAgent;
    private readonly options: Timing;
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
    /** The memory as the last start delivered it; absent before the first. */
    private deliveredMemory: MemoryStatus | undefined;
    constructor(agent: LocalAgent, options: LocalAgentOptions = {}) {
        this.agent = agent;
        this.events = new AgentEvents(agent.id);
        this.env = options.env ?? process.env;
        this.logDirectory = logDirectoryOf(agent, options);
        this.fleetTools = options.fleetTools;
        this.sshOptions = options.ssh ?? {};
        this.options = timing(options);
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
    /**
     * The memory of the agent (#101), decided by what flotti delivered: the
     * tools mounted in the session, the policy handed over, the bank usable.
     * Before the first start, only what rules memory out is known.
     */
    get memory(): MemoryStatus | undefined {
        return this.deliveredMemory ?? memoryRuledOut(this.agent, this.fleetTools !== undefined);
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
        if (!LAUNCHING.has(this.lifecycle)) {
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
        const work = this.work();
        if (work !== undefined) {
            await this.cancelWork(work);
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
        const renewal = this.renewal();
        if (renewal === undefined) {
            this.session = undefined;
            return;
        }
        this.renewing = true;
        try {
            await this.cancel();
            await this.renewSession(renewal.run, renewal.connection, renewal.request);
        } finally {
            this.renewing = false;
        }
        this.pump();
    }
    /** What {@link clearContext} renews: only a running agent with a session opened by flotti has one. */
    private renewal(): Renewal | undefined {
        const run = this.lifecycle === 'running' ? this.run : undefined;
        return run?.connection === undefined ? undefined : renewalOf(run, run.connection);
    }
    /** The new session of {@link clearContext}; an agent that cannot open one is failed and restarted by its policy. */
    private async renewSession(run: Run, connection: acp.ClientConnection, request: NewSessionRequest): Promise<void> {
        this.session = undefined;
        try {
            await this.applyModel(run, await this.newSession(connection, request, false));
            await this.prime(run);
        } catch (error) {
            this.fail(run, `could not open a new session: ${failureText(error)}`);
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
        if (!SENDABLE.has(this.lifecycle)) {
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
        const work = this.work();
        if (work === undefined) {
            return;
        }
        if (!await this.cancelWork(work)) {
            this.fail(work.run, `did not end the cancelled message within ${this.options.cancelTimeoutMs} ms`);
        }
    }
    /** The message the agent works on, when there is one and a session to speak about it. */
    private work(): Work | undefined {
        const run = this.run;
        return run?.connection === undefined ? undefined : this.workOf(run, run.connection, this.active);
    }
    private workOf(run: Run, connection: acp.ClientConnection, turn: Turn | undefined): Work | undefined {
        const sessionId = this.session;
        if (turn === undefined || sessionId === undefined) {
            return undefined;
        }
        return { run, connection, sessionId, turn };
    }
    /**
     * Sends `session/cancel` for the message in work, open permission requests
     * answered `cancelled` first; resolves whether the message ended in time.
     */
    private async cancelWork(work: Work): Promise<boolean> {
        this.cancelPermissions();
        await work.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: work.sessionId })
            .catch(() => undefined);
        return this.waitForTurnEnd(work.turn, this.options.cancelTimeoutMs);
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
        this.setLifecycle('starting', startingDetail(this.retries));
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
        if (!this.isCurrent(run)) {
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
                this.agent.ssh === undefined ? { ...this.env, ...this.agent.env } : this.agent.env,
                this.fleetTools !== undefined
            );
            const run = this.spawn(handover);
            return { handover, run };
        } catch (error) {
            this.giveUp(`cannot start: ${failureText(error)}`);
            return undefined;
        }
    }
    private onHandshakeError(run: Run, error: unknown): void {
        // A closed output means the process is going: its exit, due any moment, tells more than the closed connection.
        if (closedQuietly(run, error) || !this.isCurrent(run)) {
            return;
        }
        this.fail(run, failureText(error), isPermanentFailure(error));
    }
    /** The run is the agent's, and nobody is stopping it. */
    private isCurrent(run: Run): boolean {
        return run === this.run && !run.stopping;
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
        ignoreErrors(child.stdin);
        ignoreErrors(child.stdout);
        this.readStderr(run, child.stderr);
    }
    private readStderr(run: Run, stderr: Readable | null): void {
        if (stderr === null) {
            return;
        }
        stderr.setEncoding('utf8');
        stderr.on('data', (chunk: string) => this.onStderr(run, chunk));
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
        this.deliveredMemory = deliveredMemory(this.agent, this.fleetTools !== undefined, handover, run.sessionRequest);
        await this.prime(run);
    }
    /**
     * Readies the rule and the index of the bank for the first message of the
     * session just opened — new, resumed or loaded — when the agent has memory.
     */
    private async prime(run: Run): Promise<void> {
        run.primer = undefined;
        if (this.deliveredMemory?.state !== 'on') {
            return;
        }
        const index = await new MemoryStore(this.agent.memoryDirectory).index(INDEX_MAX_NOTES, INDEX_MAX_CHARS);
        run.primer = firstPromptBlocks(index);
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
        if (!takesHttpMcp(capabilities)) {
            this.log('the fleet tools are not given: the agent takes no MCP server over HTTP');
            return [];
        }
        return [fleetServer(tools, place)];
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
        const common = this.sessionParameters(capabilities, handover, place);
        run.sessionRequest = common;
        const previous = this.session;
        if (previous === undefined) {
            return await this.newSession(connection, common, false);
        }
        return await this.reopenSession(run, connection, capabilities, common, previous);
    }
    /** The previous session again — `session/resume`, else `session/load` — or a new one, the context lost. */
    private async reopenSession(
        run: Run,
        connection: acp.ClientConnection,
        capabilities: InitializeResponse,
        common: NewSessionRequest,
        previous: string
    ): Promise<SessionConfigOption[] | null | undefined> {
        if (canResume(capabilities)) {
            return await this.resumeSession(connection, common, previous);
        }
        if (canLoad(capabilities)) {
            return await this.loadSession(run, connection, common, previous);
        }
        return await this.newSession(connection, common, true);
    }
    /** What `session/new`, `session/resume` and `session/load` have in common. */
    private sessionParameters(
        capabilities: InitializeResponse,
        handover: Handover,
        place: RemotePlace | undefined
    ): NewSessionRequest {
        return {
            cwd: place?.cwd ?? this.agent.workdir,
            mcpServers: this.mcpServers(capabilities, place),
            ...additionalDirectories(capabilities, handover),
            ...metaOf(handover)
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
        const target = this.modelTarget(run);
        if (target === undefined) {
            return;
        }
        const option = modelOption(configOptions);
        if (option === undefined) {
            this.log(`model "${target.model}" is not applied: the agent offers no model option`);
            return;
        }
        await this.setModel(target.connection, target.sessionId, option.id, target.model);
    }
    /** The model the manifest asks for, and the session to ask in; none without a model or a session. */
    private modelTarget(run: Run): { model: string; connection: acp.ClientConnection; sessionId: string } | undefined {
        const model = this.agent.model;
        const connection = run.connection;
        const sessionId = this.session;
        if (model === undefined || connection === undefined || sessionId === undefined) {
            return undefined;
        }
        return { model, connection, sessionId };
    }
    private async setModel(connection: acp.ClientConnection, sessionId: string, configId: string, model: string): Promise<void> {
        try {
            await connection.agent.request(acp.methods.agent.session.setConfigOption, {
                sessionId,
                configId,
                value: model
            });
        } catch (error) {
            throw new PermanentFailure(`the agent refused model "${model}": ${failureText(error)}`);
        }
    }
    // --- running ---------------------------------------------------------------------------------------------
    private pump(): void {
        const work = this.nextWork();
        if (work === undefined) {
            return;
        }
        this.active = work.turn;
        this.messages.reset();
        this.showUserMessage(work.turn);
        work.turn.accepted();
        this.showStatus();
        this.prompt(work);
    }
    /** The next message in line, taken out of it, when the agent is free to work on it. */
    private nextWork(): Work | undefined {
        const run = this.freeRun();
        return run?.connection === undefined ? undefined : this.workOf(run, run.connection, this.queue.shift());
    }
    /** The run, when it is ready and busy with nothing: no message in work, no context being cleared. */
    private freeRun(): Run | undefined {
        if (this.active !== undefined || this.renewing || this.lifecycle !== 'running') {
            return undefined;
        }
        return this.run;
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
    private prompt({ run, connection, sessionId, turn }: Work): void {
        const primer = run.primer ?? [];
        run.primer = undefined;
        connection.agent.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [...primer, promptText(turn, this.agentId)].map((text): ContentBlock => ({ type: 'text', text }))
        }).then(
            (response) => this.endTurn(turn, response.stopReason),
            (error: unknown) => {
                // A closed connection means the process is going: its exit ends the turn with the real reason.
                if (!connectionClosed(run)) {
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
            this.emit({ type: 'log', source: 'flotti', text: `the message failed: ${failureText(error)}` });
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
        if (!this.isNews(run, notification)) {
            return;
        }
        for (const event of acpUpdateEvents(notification.update, this.messages)) {
            this.emit(event);
        }
    }
    /** An update of the current session, and not a replay of its history. */
    private isNews(run: Run, notification: SessionNotification): boolean {
        return run === this.run && !run.replaying && notification.sessionId === this.session;
    }
    private onPermission(run: Run, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        if (!this.isCurrent(run)) {
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
        for (const line of stderrLines(run, chunk)) {
            this.logAgentLine(line);
        }
    }
    /** A line the agent wrote to standard error, in its log; blank lines are left out. */
    private logAgentLine(line: string): void {
        if (line.trim() !== '') {
            this.emit({ type: 'log', source: 'agent', text: line });
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
        stopHeartbeat(run);
        if (isAlive(run.child)) {
            await this.kill(run);
        } else if (wait) {
            await run.exited;
        }
    }
    /** SIGTERM to the process group, SIGKILL when it is still there after the stop timeout. */
    private async kill(run: Run): Promise<void> {
        const { child } = run;
        child.stdin?.end();
        signalGroup(child, 'SIGTERM');
        const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), this.options.stopTimeoutMs);
        timer.unref();
        await run.exited;
        clearTimeout(timer);
    }
    private onExit(run: Run, code: number | null, signal: NodeJS.Signals | null): void {
        this.closeRun(run);
        if (run !== this.run) {
            return;
        }
        this.run = undefined;
        const how = exitText(run, code, signal);
        this.dropWork(`agent "${this.agentId}" stopped: ${how}`);
        if (run.stopping) {
            return;
        }
        this.afterExit(run, code, how);
    }
    /** Lets go of what the ended run held. */
    private closeRun(run: Run): void {
        stopHeartbeat(run);
        run.settlePlace?.(new Error('the process ended before the host said where it runs'));
        run.connection?.close();
        closeLogs(run);
    }
    /** After a stop nobody asked for: gives up, leaves it `exited`, or restarts it — by its policy. */
    private afterExit(run: Run, code: number | null, how: string): void {
        if (run.permanent) {
            this.giveUp(how);
            return;
        }
        if (this.staysDown(run.failure !== undefined || code !== 0)) {
            this.setLifecycle('exited', how);
            return;
        }
        this.scheduleRestart(run, how);
    }
    /** Whether the restart policy leaves the agent `exited` after a stop that failed or not. */
    private staysDown(failed: boolean): boolean {
        const policy = this.agent.restart;
        return policy === 'never' || (policy === 'on-failure' && !failed);
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
        if (SETTLING.has(state)) {
            this.settleWaiters(state, detail);
        }
        this.showStatus(detail);
    }
    private settleWaiters(state: LifecycleState, detail: string): void {
        for (const waiter of this.waiters.splice(0)) {
            if (state === 'running') {
                waiter.resolve();
            } else {
                waiter.reject(new Error(`agent "${this.agentId}" is ${state}: ${detail}`));
            }
        }
    }
    /** The status people see follows from the lifecycle and from what the agent is busy with. */
    private showStatus(detail?: string): void {
        const status = this.currentStatus();
        const shown = detail ?? this.keptDetail(status);
        if (status === this.shownStatus && shown === this.shownDetail) {
            return;
        }
        this.shownStatus = status;
        this.shownDetail = shown;
        this.emit({ type: 'status', status, ...reasonField(shown) });
    }
    /** Without a new detail, the shown one stays while the status does. */
    private keptDetail(status: AgentStatus): string | undefined {
        return status === this.shownStatus ? this.shownDetail : undefined;
    }
    private currentStatus(): AgentStatus {
        if (this.lifecycle === 'running') {
            return this.busyStatus();
        }
        return STATUS_OF.get(this.lifecycle) ?? 'stopped';
    }
    /** A running agent waits for an answer to a permission request, works on a message, or is idle. */
    private busyStatus(): AgentStatus {
        if (this.permissions.size > 0) {
            return 'waiting';
        }
        return this.active !== undefined ? 'working' : 'idle';
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
/** The run's own log files: nothing more goes to them. */
function closeLogs(run: Run): void {
    run.trace?.end();
    run.stderrLog?.end();
}
function stopHeartbeat(run: Run): void {
    if (run.heartbeat !== undefined) {
        clearInterval(run.heartbeat);
    }
}
/** A stream whose errors mean nothing to flotti: the process's exit tells what happened. */
function ignoreErrors(stream: Readable | Writable | null): void {
    stream?.on('error', () => undefined);
}
/** The lines of a piece of standard error; on an SSH host the start reader takes its own lines out first. */
function stderrLines(run: Run, chunk: string): string[] {
    const reader = run.startReader;
    if (reader === undefined) {
        return chunk.split(/\r?\n/);
    }
    const lines = reader.read(chunk);
    settleWhenKnown(run, reader.place);
    return lines;
}
/** Ends the wait for {@link Run.place} once the host said where the command runs. */
function settleWhenKnown(run: Run, place: RemotePlace | undefined): void {
    if (place !== undefined) {
        run.settlePlace?.(place);
    }
}
/** How the process ended, in words: why flotti ended it, or its signal or exit code. */
function exitText(run: Run, code: number | null, signal: NodeJS.Signals | null): string {
    return run.failure ?? (signal !== null ? `killed by ${signal}` : `exited with code ${code}`);
}
/** The process is still there: started, and neither exited nor killed yet. */
function isAlive(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null && child.pid !== undefined;
}
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (pid === undefined) {
        return;
    }
    try {
        sendSignal(pid, signal);
    } catch {
        // Already gone.
    }
}
function sendSignal(pid: number, signal: NodeJS.Signals): void {
    if (process.platform === 'win32') {
        taskkill(pid, signal);
    } else {
        process.kill(-pid, signal);
    }
}
/** No process groups on Windows: taskkill walks the tree instead. */
function taskkill(pid: number, signal: NodeJS.Signals): void {
    spawn('taskkill', ['/pid', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], {
        stdio: 'ignore',
        windowsHide: true
    }).on('error', () => undefined);
}
/** What {@link LocalAgentProcess.clearContext} needs of a run: the request its session was opened with. */
function renewalOf(run: Run, connection: acp.ClientConnection): Renewal | undefined {
    return run.sessionRequest === undefined ? undefined : { run, connection, request: run.sessionRequest };
}
/** The process closed its output, so its exit is due any moment. */
function connectionClosed(run: Run): boolean {
    return run.connection?.signal.aborted === true;
}
/** A failure of the handshake that the exit of the process will explain better. */
function closedQuietly(run: Run, error: unknown): boolean {
    return connectionClosed(run) && !isPermanent(error);
}
function isPermanentFailure(error: unknown): boolean {
    return error instanceof PermanentFailure || isPermanent(error);
}
function isPermanent(error: unknown): boolean {
    return error instanceof acp.RequestError && (error.code === AUTH_REQUIRED || error.code === INVALID_PARAMS);
}
function takesHttpMcp(capabilities: InitializeResponse): boolean {
    return capabilities.agentCapabilities?.mcpCapabilities?.http === true;
}
/** The fleet tools over HTTP — the port here, or the reverse tunnel's port on the host — with the agent's own token. */
function fleetServer(tools: FleetToolsAccess, place: RemotePlace | undefined): McpServer {
    const port = place?.reversePort ?? tools.port;
    return {
        type: 'http',
        name: MCP_SERVER_NAME,
        url: `http://127.0.0.1:${port}${MCP_PATH}`,
        headers: [{ name: 'Authorization', value: `Bearer ${tools.token}` }]
    };
}
function canResume(capabilities: InitializeResponse): boolean {
    return Boolean(capabilities.agentCapabilities?.sessionCapabilities?.resume);
}
function canLoad(capabilities: InitializeResponse): boolean {
    return Boolean(capabilities.agentCapabilities?.loadSession);
}
/** The directories the agent may read besides its own, for an agent that takes them. */
function additionalDirectories(capabilities: InitializeResponse, handover: Handover): Partial<NewSessionRequest> {
    return capabilities.agentCapabilities?.sessionCapabilities?.additionalDirectories
        ? { additionalDirectories: [...handover.additionalDirectories] }
        : {};
}
function metaOf(handover: Handover): Partial<NewSessionRequest> {
    return handover.meta === undefined ? {} : { _meta: { ...handover.meta } };
}
/** The session config option that picks the model. */
function modelOption(configOptions: SessionConfigOption[] | null | undefined): SessionConfigOption | undefined {
    return configOptions?.find((candidate: SessionConfigOption) =>
        candidate.category === 'model' || candidate.id === 'model');
}
function reasonField(reason: string | undefined): { reason?: string } {
    return reason === undefined ? {} : { reason };
}
/** Why the agent cannot have memory whatever it delivers, or undefined when it may. */
function memoryRuledOut(agent: LocalAgent, tools: boolean): MemoryStatus | undefined {
    if (agent.ssh !== undefined) {
        return { state: 'unsupported', reason: `the agent runs on ${agent.ssh}: memory there is not tested end to end yet` };
    }
    if (agent.adapter === undefined) {
        return { state: 'unsupported', reason: 'the manifest names no adapter: there is no channel for the memory policy' };
    }
    if (!tools) {
        return { state: 'unsupported', reason: 'flotti gives this agent no tools' };
    }
    return undefined;
}
/** The memory as a start delivered it: the policy handed over, the tools mounted in the session, the bank usable. */
function deliveredMemory(
    agent: LocalAgent,
    tools: boolean,
    handover: Handover,
    session: NewSessionRequest | undefined
): MemoryStatus | undefined {
    const ruledOut = memoryRuledOut(agent, tools);
    const contract = handover.memory;
    if (ruledOut !== undefined || contract === undefined) {
        return ruledOut;
    }
    return contractMemory(contract, mountsFleetTools(session));
}
function mountsFleetTools(session: NewSessionRequest | undefined): boolean {
    return session?.mcpServers.some((server) => server.name === MCP_SERVER_NAME) === true;
}
/** The memory of a contract handed over: on, unless the tools did not reach the agent or the bank cannot be used. */
function contractMemory(contract: MemoryHandover, mounted: boolean): MemoryStatus {
    if (!mounted) {
        return { state: 'unsupported', reason: 'the agent takes no MCP server over HTTP: the memory tools do not reach it' };
    }
    if (contract.unavailable !== undefined) {
        return { state: 'unavailable', reason: contract.unavailable };
    }
    return { state: 'on', policy: contract.policy, skill: contract.skill };
}
/** What went wrong, in words, with a hint when the agent wants a login first. */
function failureText(error: unknown): string {
    return `${describeError(error)}${loginHint(error)}`;
}
function loginHint(error: unknown): string {
    return error instanceof acp.RequestError && error.code === AUTH_REQUIRED ? ' (the agent wants a login first)' : '';
}
export { LocalAgentProcess };
export type { LifecycleState, LocalAgentOptions };
