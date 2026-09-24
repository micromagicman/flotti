import { randomUUID } from 'node:crypto';
import { AGENT_CARD_PATH, Role, TaskState } from '@a2a-js/sdk';
import type { AgentCard, Message, Part, StreamResponse, Task, TaskArtifactUpdateEvent } from '@a2a-js/sdk';
import {
    ClientFactory,
    ClientFactoryOptions,
    DefaultAgentCardResolver,
    JsonRpcTransportFactory,
    RestTransportFactory,
    ServiceParameters,
    createAuthenticatingFetchWithRetry,
    withA2AExtensions
} from '@a2a-js/sdk/client';
import type { Client } from '@a2a-js/sdk/client';
import { AgentEvents, WITHDRAWN, composeText, messageFields } from './agent-events.js';
import type { AgentEventListener, AgentStatus, FleetAgent, SendOptions } from './agent-events.js';
import type { Environment } from './manifest.js';
import { HealthTracker } from './connection-health.js';
import type { ConnectionHealth, HealthListener, HealthTrackerOptions } from './connection-health.js';
import { SshConnection } from './ssh.js';
import type { RemoteConnection, RemoteEndpoint, SshOptions } from './ssh.js';
import type { RemoteAgent, RemoteAuth } from './types.js';
/**
 * A2A extension through which flotti asks a remote agent to restart itself.
 * The agent declares it in `capabilities.extensions` of its card; the contract
 * is in docs/a2a-restart.md.
 */
const RESTART_EXTENSION = 'https://github.com/micromagicman/flotti/blob/main/docs/a2a-restart.md';
/**
 * A2A extension through which a remote agent says things of its own — a message
 * nobody asked for, a line about what it is busy with — outside the turns of the
 * dashboard. The contract is in docs/a2a-inbox.md.
 */
const INBOX_EXTENSION = 'https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md';
/**
 * A2A extension through which a remote agent names the program that runs it,
 * in `params.harness` of the extension in its card. The contract is in
 * docs/a2a-ssh.md, "Which harness runs the agent".
 */
const HARNESS_EXTENSION = 'https://github.com/micromagicman/flotti/blob/main/docs/a2a-ssh.md#which-harness-runs-the-agent';
type A2AAgentOptions = {
    /** Where the secrets named by `auth` are read from; defaults to `process.env`. */
    readonly env?: Environment;
    /** HTTP client; defaults to the global `fetch`. */
    readonly fetch?: typeof fetch;
    /** How often to ask for the task of an agent that cannot stream; 2 s by default. */
    readonly pollIntervalMs?: number;
    /** How many times in a row to reconnect to a task whose stream broke off; 5 by default. */
    readonly reconnectAttempts?: number;
    /** First pause before reconnecting; doubles with every attempt. 500 ms by default. */
    readonly reconnectDelayMs?: number;
    /** Longest pause between attempts to reconnect. 5 s by default. */
    readonly reconnectDelayMaxMs?: number;
    /** How long a restarting agent may stay away before the restart counts as failed; 60 s by default. */
    readonly restartTimeoutMs?: number;
    /**
     * The way to the agent when it has to be opened first; by default an SSH
     * tunnel for an agent with `ssh` in its manifest, and none otherwise.
     */
    readonly connection?: RemoteConnection;
    /** How `ssh` is run for an agent with `ssh` in its manifest. */
    readonly ssh?: SshOptions;
    /** Longest pause between attempts to open a connection that dropped. 30 s by default. */
    readonly reopenDelayMaxMs?: number;
    /** How often the round trip to an agent behind a connection is measured; 15 s by default. */
    readonly healthIntervalMs?: number;
    /** The clock and the pace of the health of the connection; tests put their own in. */
    readonly health?: HealthTrackerOptions;
};
/** A round trip that takes longer than this is not measured: the connection says itself when it is gone. */
const PROBE_TIMEOUT_MS = 10_000;
/** What the agent card told about the agent, for the dashboard. */
type A2AAgentInfo = {
    readonly name: string;
    readonly description: string;
    /** Version of the agent itself, as its card states it. */
    readonly version: string;
    /** A2A version flotti speaks to it, sent in the `A2A-Version` header. */
    readonly protocolVersion: string;
    /** Whether answers arrive as a stream; otherwise flotti asks for the task every so often. */
    readonly streaming: boolean;
    /** Whether the agent can restart itself when asked (the flotti restart extension). */
    readonly restart: boolean;
    /** Whether the agent says things of its own through the flotti inbox extension. */
    readonly inbox: boolean;
    /** The program that runs the agent, as the harness extension of the card names it. */
    readonly harness?: string;
    /** Whether the card carries a signature. It is not verified: see README, "Talking to a remote agent". */
    readonly signed: boolean;
    /** Names of the security schemes the card declares. */
    readonly security: readonly string[];
    readonly skills: readonly { readonly id: string; readonly name: string; readonly description: string }[];
};
/** The task a conversation is at, as far as its last event told. */
type CurrentTask = {
    readonly id: string;
    readonly state: TaskState;
    /** Id of the message that came with the state, if any. */
    readonly statusMessageId: string;
};
/** What reading the streams of one turn has learned so far. */
type StreamProgress = {
    /** Whether any event came back in this turn. */
    received: boolean;
    /** Reconnects in a row that failed; an event resets it. */
    failures: number;
    lastError: unknown;
};
/** What reading the inbox has learned so far. */
type InboxProgress = {
    /** The inbox task, once the agent opened it: a broken stream goes back to it. */
    taskId: string | undefined;
    /** Attempts in a row that failed; an event resets it. */
    failures: number;
    /** The agent turned the inbox down: flotti stops asking. */
    refused: boolean;
};
/** The message of a turn on its way: shown and accepted once the agent first answers. */
type TurnDelivery = {
    /** Shows the message and settles the send; only the first call does anything. */
    readonly deliver: () => void;
    /** Ends the turn on the dashboard, when the message was delivered at all. */
    readonly end: (reason: string) => void;
};
/** An agent card kept between reads. */
type CachedCard = { body: string; etag: string | null; freshUntil: number };
/** A turn is over once the agent answered with a message, or its task stopped or paused. */
const FINAL_STATES: readonly TaskState[] = [
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED
];
const INTERRUPTED_STATES: readonly TaskState[] = [
    TaskState.TASK_STATE_INPUT_REQUIRED,
    TaskState.TASK_STATE_AUTH_REQUIRED
];
/** A promise with the way to settle it from outside: the `send` of a message that waits its turn. */
function settleable(): { delivery: Promise<void>; accepted: () => void; refused: (error: unknown) => void } {
    let accepted!: () => void;
    let refused!: (error: unknown) => void;
    const delivery = new Promise<void>((resolve, reject) => {
        accepted = resolve;
        refused = reject;
    });
    return { delivery, accepted, refused };
}
/**
 * A remote agent of the fleet, spoken to over A2A with the official SDK: the
 * card is read from the agent address, the SDK picks the transport the card
 * offers (JSON-RPC or HTTP+JSON; A2A 0.3 agents are understood too), answers
 * are streamed when the agent can stream and polled when it cannot.
 */
class A2AAgent implements FleetAgent {
    readonly agentId: string;
    private readonly agent: RemoteAgent;
    private readonly env: Environment;
    private readonly fetch: typeof fetch;
    private readonly cardFetch: typeof fetch;
    private readonly pollIntervalMs: number;
    private readonly reconnectAttempts: number;
    private readonly reconnectDelayMs: number;
    private readonly reconnectDelayMaxMs: number;
    private readonly restartTimeoutMs: number;
    private readonly reopenDelayMaxMs: number;
    /** The way to the agent that has to be opened first — an SSH tunnel — if there is one. */
    private readonly connection: RemoteConnection | undefined;
    /** What the open connection says about the way to the agent. */
    private endpoint: RemoteEndpoint | undefined;
    /** Session of the attempts to open again a connection that dropped, or never opened. */
    private retrying: AbortSignal | undefined;
    /** Health of the connection, when there is one to keep open. */
    private readonly tracker: HealthTracker | undefined;
    /** Session the round trip is being measured in. */
    private probing: AbortSignal | undefined;
    private readonly healthIntervalMs: number;
    /** HTTP client with nothing added: measures the round trip without counting it as the agent's activity. */
    private readonly plainFetch: typeof fetch;
    private readonly events: AgentEvents;
    private currentStatus: AgentStatus = 'stopped';
    private currentReason: string | undefined;
    private client: Client | undefined;
    private card: A2AAgentInfo | undefined;
    /** What the agent last said runs it; kept while it is stopped, as the manifest of a local one is. */
    private toldHarness: string | undefined;
    /** Aborted by stop and restart: ends the streams and drops the queued messages. */
    private session = new AbortController();
    /** Messages wait here while the agent is busy with the previous one. */
    private queue: Promise<void> = Promise.resolve();
    /** Turns of this session not over yet, the one in work included: a message sent now waits behind them. */
    private turns = 0;
    /** The messages that wait in line, by id: how each is refused when it leaves the line unsent. */
    private readonly waiting = new Map<string, (error: Error) => void>();
    private contextId: string | undefined;
    private task: CurrentTask | undefined;
    /** The paused task the message of the current turn answers, as it was when the message went. */
    private answering: CurrentTask | undefined;
    /** Ids of the agent messages already shown: a task snapshot repeats them. */
    private readonly shown = new Set<string>();
    /** Whether a message of a person is being worked on: the status is the turn's then. */
    private inTurn = false;
    /** Whether the agent last said, through the inbox, that it is busy on its own. */
    private busyOnItsOwn = false;
    constructor(agent: RemoteAgent, options: A2AAgentOptions = {}) {
        this.agentId = agent.id;
        this.agent = agent;
        this.events = new AgentEvents(agent.id);
        this.env = options.env ?? process.env;
        this.plainFetch = options.fetch ?? globalThis.fetch;
        this.fetch = this.authenticatingFetch(this.plainFetch);
        this.cardFetch = cachingCardFetch(this.fetch);
        this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
        this.reconnectAttempts = options.reconnectAttempts ?? 5;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 500;
        this.reconnectDelayMaxMs = options.reconnectDelayMaxMs ?? 5_000;
        this.restartTimeoutMs = options.restartTimeoutMs ?? 60_000;
        this.reopenDelayMaxMs = options.reopenDelayMaxMs ?? 30_000;
        this.connection = options.connection
            ?? (agent.ssh === undefined ? undefined : new SshConnection(agent.ssh, options.ssh));
        this.connection?.onDrop((reason: string) => this.dropped(reason));
        this.tracker = this.connection === undefined ? undefined : new HealthTracker(options.health);
        this.healthIntervalMs = options.healthIntervalMs ?? 15_000;
    }
    get status(): AgentStatus {
        return this.currentStatus;
    }
    /** Health of the connection to the agent; absent when there is no connection to keep open. */
    get health(): ConnectionHealth | undefined {
        return this.tracker?.snapshot();
    }
    onHealth(listener: HealthListener): () => void {
        return this.tracker?.onChange(listener) ?? (() => undefined);
    }
    /** What the card said; absent until the agent is connected to. */
    get info(): A2AAgentInfo | undefined {
        return this.card;
    }
    /**
     * The program that runs the agent, as the agent itself says: its published
     * file (over SSH) first, then its card. Absent until it is connected to,
     * and when it says nothing.
     */
    get harness(): string | undefined {
        return this.toldHarness;
    }
    subscribe(listener: AgentEventListener): () => void {
        return this.events.subscribe(listener);
    }
    /**
     * Reads the agent card and gets ready to talk. A card read a moment ago is
     * not read again: it is kept as long as its `Cache-Control` allows and then
     * checked with its `ETag`.
     */
    async start(): Promise<void> {
        if (this.reopening) {
            // Started by hand while it was trying again by itself: this attempt takes over.
            this.endSession();
        }
        this.setStatus('starting', this.connection === undefined ? undefined : 'opening the SSH tunnel');
        try {
            await this.connect();
        } catch (error) {
            this.setStatus('error', describeError(error));
            if (this.connection !== undefined) {
                // A tunnel is kept up: a host that is away now is tried again until it is back.
                void this.keepTrying(describeError(error), 1);
            }
            throw error;
        }
        this.setStatus('idle');
        this.openInbox();
    }
    /**
     * A message from another agent carries the sender under the inbox extension
     * URI in its metadata (docs/a2a-inbox.md); an agent that does not offer the
     * inbox gets it as `[from <id>]` in front of the text as well.
     */
    send(text: string, options: SendOptions = {}): Promise<void> {
        const client = this.client;
        if (client === undefined) {
            return Promise.reject(new Error(`Agent ${this.agentId} is not connected; start it first.`));
        }
        const signal = this.session.signal;
        const sent = { ...options, messageId: options.messageId ?? randomUUID() };
        const { delivery, accepted, refused } = settleable();
        const queued = this.enqueue(text, sent, refused);
        const turn = this.queue.then(async () => {
            // Out of the line before its turn came: it was refused then.
            if (!queued || this.waiting.delete(sent.messageId)) {
                await this.runTurn(client, text, sent, signal, accepted, refused);
            }
        }).finally(() => this.turnOver(signal));
        this.queue = turn.catch(() => undefined);
        return delivery;
    }
    /** A turn of the session is over; one of an ended session was forgotten with it. */
    private turnOver(signal: AbortSignal): void {
        if (this.session.signal === signal) {
            this.turns -= 1;
        }
    }
    /** Counts the turn in; one that waits behind another says so. Returns whether it waits. */
    private enqueue(text: string, sent: SendOptions & { messageId: string }, refused: (error: Error) => void): boolean {
        const queued = this.turns > 0;
        this.turns += 1;
        if (queued) {
            this.waiting.set(sent.messageId, refused);
            this.events.emit({ type: 'queued', messageId: sent.messageId, text, ...messageFields(sent) });
        }
        return queued;
    }
    /** Takes a message that waits in line back out of it; its `send` rejects. */
    withdraw(messageId: string): boolean {
        const refused = this.waiting.get(messageId);
        if (refused === undefined) {
            return false;
        }
        this.waiting.delete(messageId);
        this.events.emit({ type: 'unqueued', messageId, outcome: 'withdrawn' });
        refused(new Error(WITHDRAWN));
        return true;
    }
    async cancel(): Promise<void> {
        const task = this.task;
        if (this.client === undefined || task === undefined || FINAL_STATES.includes(task.state)) {
            return;
        }
        const canceled = await this.client.cancelTask({ tenant: '', id: task.id, metadata: undefined });
        if (this.task?.id === canceled.id) {
            this.apply({ payload: { $case: 'task', value: canceled } });
        }
    }
    /**
     * A2A asks a person through the task itself — `input-required`, answered by
     * the next message — so there is never a permission request to answer.
     */
    answerPermission(): boolean {
        return false;
    }
    /**
     * Restarts the agent itself when its card offers the restart extension, and
     * reconnects once it is back. An agent without the extension cannot be
     * restarted from here: its conversation starts anew instead, which is all
     * a restart means for a process flotti does not own.
     */
    async restart(): Promise<void> {
        const client = this.client;
        const unfinished = this.task !== undefined && !FINAL_STATES.includes(this.task.state) ? this.task : undefined;
        this.endSession();
        this.forgetConversation();
        if (client === undefined) {
            await this.start();
            return;
        }
        if (this.card?.restart !== true) {
            await this.startNewConversation(client, unfinished);
            return;
        }
        await this.restartRemotely(client);
    }
    /** For an agent that cannot restart: drops the unfinished task, and the conversation starts anew. */
    private async startNewConversation(client: Client, unfinished: CurrentTask | undefined): Promise<void> {
        if (unfinished !== undefined) {
            await client.cancelTask({ tenant: '', id: unfinished.id, metadata: undefined }).catch(() => undefined);
        }
        this.setStatus('idle', 'new conversation: the agent cannot be restarted remotely');
        this.openInbox();
    }
    /** Asks the agent to restart through the restart extension and reconnects once it is back. */
    private async restartRemotely(client: Client): Promise<void> {
        this.setStatus('starting', 'restarting');
        try {
            await askToRestart(client);
            await this.reconnect();
        } catch (error) {
            this.setStatus('error', describeError(error));
            throw error;
        }
        this.setStatus('idle', 'restarted');
        this.openInbox();
    }
    async stop(): Promise<void> {
        this.endSession();
        this.client = undefined;
        this.forgetConversation();
        this.setStatus('stopped');
        this.endpoint = undefined;
        await this.connection?.close();
        // The next start is another session: its reconnects are counted anew.
        this.tracker?.reset();
    }
    /** The HTTP client that proves flotti to the agent and routes requests down the tunnel. */
    private authenticatingFetch(base: typeof fetch): typeof fetch {
        const routed: typeof fetch = (input, init) => base(this.route(input), init).then((response) => {
            this.tracker?.activity();
            return response;
        });
        return createAuthenticatingFetchWithRetry(routed, {
            headers: async () => this.endpoint?.headers === undefined
                ? authHeaders(this.agent.auth, this.env)
                : { ...this.endpoint.headers },
            // A secret from the environment cannot be refreshed: a refusal is final.
            shouldRetryWithHeaders: async () => undefined
        });
    }
    /** Where a request really goes: down the tunnel, when the connection has one. */
    private route(input: string | URL | Request): string | URL | Request {
        const rewrite = this.endpoint?.rewrite;
        if (rewrite === undefined) {
            return input;
        }
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const moved = rewrite(url);
        if (moved === undefined) {
            return input;
        }
        return input instanceof Request ? new Request(moved, input) : moved.href;
    }
    /** The connection broke by itself: what was in work is lost, and the way is opened again. */
    private dropped(reason: string): void {
        this.tracker?.down();
        if (this.currentStatus === 'stopped' || this.currentStatus === 'starting' || this.reopening) {
            return;
        }
        this.endSession();
        this.client = undefined;
        void this.keepTrying(reason, 0);
    }
    /**
     * Opens the connection again and again, with growing pauses, until it is
     * back or the agent is stopped or started by hand. The status says what is
     * going on and why the last attempt failed.
     */
    private async keepTrying(reason: string, firstAttempt: number): Promise<void> {
        const signal = this.session.signal;
        if (this.retrying === signal) {
            return;
        }
        this.retrying = signal;
        try {
            await this.reopenUntilBack(reason, firstAttempt, signal);
        } finally {
            if (this.retrying === signal) {
                this.retrying = undefined;
            }
        }
    }
    /** The attempts of `keepTrying`, with growing pauses, until one succeeds or the signal is aborted. */
    private async reopenUntilBack(reason: string, firstAttempt: number, signal: AbortSignal): Promise<void> {
        let why = reason;
        for (let attempt = firstAttempt; !signal.aborted; attempt++) {
            if (attempt > 0) {
                const wait = Math.min(1_000 * 2 ** (attempt - 1), this.reopenDelayMaxMs);
                this.setStatus('error', `${why}; trying again in ${Math.ceil(wait / 1_000)} s`);
                await pause(wait, signal);
                if (signal.aborted) {
                    return;
                }
            }
            const failure = await this.reopenOnce(why, signal);
            if (failure === undefined) {
                return;
            }
            why = failure;
        }
    }
    /** One attempt to open the connection again: why it failed, or nothing once it is back. */
    private async reopenOnce(why: string, signal: AbortSignal): Promise<string | undefined> {
        this.setStatus('starting', `reconnecting: ${why}`);
        try {
            await this.connect();
        } catch (error) {
            return describeError(error);
        }
        if (!signal.aborted) {
            this.setStatus('idle', 'reconnected');
            this.openInbox();
        }
        return undefined;
    }
    /** Whether a connection that dropped, or never opened, is being tried again right now. */
    private get reopening(): boolean {
        return this.retrying !== undefined && !this.retrying.aborted;
    }
    private async connect(): Promise<void> {
        const url = await this.openConnection() ?? this.agent.url;
        if (this.endpoint?.headers === undefined) {
            authHeaders(this.agent.auth, this.env);
        }
        if (url === undefined) {
            throw new Error(`Agent ${this.agentId} has neither url nor ssh in its manifest.`);
        }
        const factory = this.clientFactory();
        const location = cardLocation(url);
        const client = await factory.createFromUrl(location.base, location.path);
        // The extended card, when the agent has one for those who proved themselves.
        const card = await client.getAgentCard({ signal: this.session.signal });
        this.client = client;
        this.card = describeCard(card, client.protocolVersion);
        this.toldHarness = this.endpoint?.harness ?? this.card.harness;
        this.measureRoundTrips();
    }
    /** Opens the connection, when there is one: the address it gives, or nothing without one. */
    private async openConnection(): Promise<string | undefined> {
        if (this.connection === undefined) {
            return undefined;
        }
        this.endpoint = await this.connection.open(this.session.signal);
        this.tracker?.up();
        return this.endpoint.url;
    }
    /**
     * Measures the round trip to an agent behind a connection now and every
     * `healthIntervalMs`, for as long as the session lasts, by asking for its
     * card: the one request every agent answers without a secret.
     */
    private measureRoundTrips(): void {
        const signal = this.session.signal;
        if (this.tracker === undefined || this.probing === signal) {
            return;
        }
        this.probing = signal;
        void (async () => {
            while (!signal.aborted) {
                await this.measureRoundTrip(signal);
                await pause(this.healthIntervalMs, signal);
            }
        })();
    }
    /** One round trip to the agent; a failed one tells nothing: a dropped connection says so itself. */
    private async measureRoundTrip(signal: AbortSignal): Promise<void> {
        const endpoint = this.endpoint;
        if (endpoint === undefined) {
            return;
        }
        const location = cardLocation(endpoint.url);
        const card = location.path === '' ? location.base : new URL(location.path, location.base).href;
        const started = performance.now();
        try {
            const response = await this.plainFetch(this.route(card), { signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) });
            await response.body?.cancel();
            if (response.ok && !signal.aborted) {
                this.tracker?.latency(performance.now() - started);
            }
        } catch {
            // Timed out, refused or cut off: the next round trip, or the drop, will say more.
        }
    }
    /** Makes clients for either transport the card may offer, A2A 0.3 agents included. */
    private clientFactory(): ClientFactory {
        const legacyCompat = { enabled: true };
        return new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
            transports: [
                new JsonRpcTransportFactory({ fetchImpl: this.fetch, legacyCompat }),
                new RestTransportFactory({ fetchImpl: this.fetch, legacyCompat })
            ],
            cardResolver: new DefaultAgentCardResolver({ fetchImpl: this.cardFetch, legacyCompat }),
            clientConfig: { polling: true }
        }));
    }
    /** Connects again and again until the restarted agent is back or the time is up. */
    private async reconnect(): Promise<void> {
        const deadline = Date.now() + this.restartTimeoutMs;
        const signal = this.session.signal;
        for (let attempt = 0; ; attempt++) {
            try {
                await this.connect();
                return;
            } catch (error) {
                if (signal.aborted || Date.now() >= deadline) {
                    throw new Error(`the agent did not come back after the restart: ${describeError(error)}`, {
                        cause: error
                    });
                }
            }
            await pause(this.backoff(attempt), signal);
        }
    }
    /** One message and everything the agent does about it, until the turn is over. */
    private async runTurn(
        client: Client,
        text: string,
        options: SendOptions,
        signal: AbortSignal,
        accepted: () => void,
        refused: (error: unknown) => void
    ): Promise<void> {
        if (signal.aborted) {
            refused(new Error(`Agent ${this.agentId} was stopped before the message was sent.`));
            return;
        }
        const message = this.userMessage(text, options);
        this.answering = message.taskId === '' ? undefined : this.task;
        const delivery = this.turnDelivery(message, text, options, accepted);
        this.inTurn = true;
        this.setStatus('working');
        await this.workOnTurn(client, message, signal, delivery, refused);
    }
    /** Shows the message of the turn and settles its send once the agent first answers. */
    private turnDelivery(message: Message, text: string, options: SendOptions, accepted: () => void): TurnDelivery {
        let delivered = false;
        return {
            deliver: () => {
                if (!delivered) {
                    delivered = true;
                    this.events.emit({ type: 'message', role: 'user', messageId: message.messageId, text, append: false, ...messageFields(options) });
                    accepted();
                }
            },
            end: (reason: string) => {
                if (delivered) {
                    this.events.emit({ type: 'turn-end', reason });
                }
            }
        };
    }
    /** Exchanges the message of the turn with the agent and ends the turn, however it went. */
    private async workOnTurn(
        client: Client,
        message: Message,
        signal: AbortSignal,
        delivery: TurnDelivery,
        refused: (error: unknown) => void
    ): Promise<void> {
        try {
            await this.exchange(client, message, signal, delivery.deliver);
            delivery.end(signal.aborted ? 'cancelled' : this.turnEndReason());
        } catch (error) {
            this.turnFailed(error, signal, delivery, refused);
        } finally {
            this.endTurn();
        }
    }
    /** The turn broke off: it ends on the dashboard, and the send is refused. */
    private turnFailed(error: unknown, signal: AbortSignal, delivery: TurnDelivery, refused: (error: unknown) => void): void {
        delivery.end(signal.aborted ? 'cancelled' : 'error');
        if (signal.aborted) {
            refused(error);
            return;
        }
        this.setStatus('error', describeError(error));
        refused(error);
    }
    /** After a turn the status goes back to what the agent is doing on its own. */
    private endTurn(): void {
        this.answering = undefined;
        this.inTurn = false;
        if (this.busyOnItsOwn && this.currentStatus === 'idle') {
            this.setStatus('working');
        }
    }
    /** Sends the message and follows the answer, streamed or polled, until the turn is over. */
    private async exchange(client: Client, message: Message, signal: AbortSignal, deliver: () => void): Promise<void> {
        if (this.card?.streaming === true) {
            await this.followStream(client, client.sendMessageStream(sendRequest(message), { signal }), signal, deliver);
            return;
        }
        const result = await client.sendMessage(sendRequest(message), { signal });
        deliver();
        const over = 'messageId' in result
            ? this.apply({ payload: { $case: 'message', value: result } })
            : this.apply({ payload: { $case: 'task', value: result } });
        if (!over) {
            await this.poll(client, signal);
        }
    }
    /**
     * Reads the stream of a turn. A stream the agent closes once the task has
     * stopped or paused is the normal end. A stream that ends while the task is
     * still going is caught up with `GetTask` and reconnected to with
     * `SubscribeToTask` — the message is never sent twice.
     */
    private async followStream(
        client: Client,
        first: AsyncGenerator<StreamResponse>,
        signal: AbortSignal,
        deliver: () => void
    ): Promise<void> {
        const progress: StreamProgress = { received: false, failures: 0, lastError: undefined };
        let stream: AsyncGenerator<StreamResponse> | undefined = first;
        while (stream !== undefined) {
            if (await this.readStream(stream, signal, deliver, progress)) {
                return;
            }
            stream = await this.nextStream(client, signal, progress);
        }
    }
    /** The stream to go on reading after one ended; nothing when the turn is over or was aborted. */
    private async nextStream(
        client: Client,
        signal: AbortSignal,
        progress: StreamProgress
    ): Promise<AsyncGenerator<StreamResponse> | undefined> {
        if (signal.aborted || this.turnIsOver()) {
            return undefined;
        }
        const task = this.task;
        if (!progress.received || task === undefined) {
            throw new Error('the agent closed the stream without answering');
        }
        return this.catchUp(client, task, signal, progress);
    }
    /** Reads one stream until it ends; true once an event finished the turn. */
    private async readStream(
        stream: AsyncGenerator<StreamResponse>,
        signal: AbortSignal,
        deliver: () => void,
        progress: StreamProgress
    ): Promise<boolean> {
        try {
            for await (const event of stream) {
                if (this.takeEvent(event, deliver, progress)) {
                    return true;
                }
            }
        } catch (error) {
            // Nothing came back yet: whether the agent got the message is unknown, and
            // guessing a task to reconnect to could pick the previous one.
            if (signal.aborted || !progress.received) {
                throw error;
            }
            progress.lastError = error;
        }
        return false;
    }
    /** One event of a turn's stream: the message counts as delivered; true once the event finished the turn. */
    private takeEvent(event: StreamResponse, deliver: () => void, progress: StreamProgress): boolean {
        progress.received = true;
        deliver();
        progress.failures = 0;
        return this.apply(event);
    }
    /**
     * Catches up with a task whose stream broke off: the stream to go on reading,
     * or nothing when the turn is over or the wait was aborted.
     */
    private async catchUp(
        client: Client,
        task: CurrentTask,
        signal: AbortSignal,
        progress: StreamProgress
    ): Promise<AsyncGenerator<StreamResponse> | undefined> {
        for (;;) {
            if (!await this.waitToCatchUp(task, signal, progress)) {
                return undefined;
            }
            try {
                return await this.resubscribe(client, task, signal);
            } catch (error) {
                if (signal.aborted) {
                    return undefined;
                }
                progress.lastError = error;
            }
        }
    }
    /** Waits before the next attempt to catch up, giving up after too many; false once the wait was aborted. */
    private async waitToCatchUp(task: CurrentTask, signal: AbortSignal, progress: StreamProgress): Promise<boolean> {
        if (progress.failures >= this.reconnectAttempts) {
            throw new Error(`lost the stream of task ${task.id}: ${describeError(progress.lastError ?? 'closed early')}`, {
                cause: progress.lastError
            });
        }
        await pause(this.backoff(progress.failures++), signal);
        return !signal.aborted;
    }
    /** Asks for the task and subscribes to it again; nothing when the task shows the turn is over. */
    private async resubscribe(
        client: Client,
        task: CurrentTask,
        signal: AbortSignal
    ): Promise<AsyncGenerator<StreamResponse> | undefined> {
        const now = await client.getTask({ tenant: '', id: task.id }, { signal });
        if (this.apply({ payload: { $case: 'task', value: now } })) {
            return undefined;
        }
        return client.resubscribeTask({ tenant: '', id: task.id }, { signal });
    }
    /**
     * How the turn ended, in the words the event model shares with ACP. A turn
     * without a task was answered with a message and is simply over.
     */
    private turnEndReason(): string {
        switch (this.task?.state) {
            case undefined:
            case TaskState.TASK_STATE_COMPLETED:
                return 'end_turn';
            case TaskState.TASK_STATE_CANCELED:
                return 'cancelled';
            case TaskState.TASK_STATE_REJECTED:
                return 'refusal';
            case TaskState.TASK_STATE_INPUT_REQUIRED:
                return 'input_required';
            case TaskState.TASK_STATE_AUTH_REQUIRED:
                return 'auth_required';
            default:
                return 'error';
        }
    }
    /** Whether the task of the turn has stopped or paused. */
    private turnIsOver(): boolean {
        const state = this.task?.state;
        return state !== undefined && (FINAL_STATES.includes(state) || INTERRUPTED_STATES.includes(state));
    }
    /** For an agent that cannot stream: asks for the task until the turn is over. */
    private async poll(client: Client, signal: AbortSignal): Promise<void> {
        let failures = 0;
        while (!signal.aborted) {
            await pause(this.pollIntervalMs, signal);
            const task = this.task;
            if (signal.aborted || task === undefined) {
                return;
            }
            try {
                if (this.apply({ payload: { $case: 'task', value: await client.getTask({ tenant: '', id: task.id }, { signal }) } })) {
                    return;
                }
                failures = 0;
            } catch (error) {
                if (signal.aborted || ++failures > this.reconnectAttempts) {
                    throw error;
                }
            }
        }
    }
    /** Turns one A2A event into dashboard events; tells whether the turn is over. */
    private apply(event: StreamResponse): boolean {
        this.tracker?.activity();
        const payload = event.payload;
        switch (payload?.$case) {
            case 'message':
                return this.applyMessage(payload.value);
            case 'task':
                return this.applyTask(payload.value);
            case 'statusUpdate': {
                this.contextId = payload.value.contextId || this.contextId;
                return this.track(payload.value.taskId, payload.value.status);
            }
            case 'artifactUpdate':
                this.showArtifactUpdate(payload.value);
                return false;
            default:
                return false;
        }
    }
    /** The agent answered with a message: the turn is over, with no task. */
    private applyMessage(message: Message): boolean {
        this.contextId = message.contextId || this.contextId;
        this.task = undefined;
        this.showMessage(message);
        this.setStatus('idle');
        return true;
    }
    /** A snapshot of the task: what it holds is shown, and its state tracked unless the snapshot is stale. */
    private applyTask(task: Task): boolean {
        this.contextId = task.contextId || this.contextId;
        const stale = this.isStale(task);
        this.showTaskContents(task, message => this.showMessage(message));
        return stale ? false : this.track(task.id, task.status);
    }
    /** Shows what a task snapshot holds: the messages of the agent, through `show`, and the artifacts. */
    private showTaskContents(task: Task, show: (message: Message) => void): void {
        for (const message of task.history) {
            if (message.role === Role.ROLE_AGENT) {
                show(message);
            }
        }
        for (const artifact of task.artifacts) {
            this.showArtifact(task.id, artifact.artifactId, artifact.parts, false);
        }
    }
    private showArtifactUpdate(update: TaskArtifactUpdateEvent): void {
        const { artifact, taskId, append } = update;
        if (artifact !== undefined) {
            this.showArtifact(taskId, artifact.artifactId, artifact.parts, append);
        }
    }
    /**
     * Whether a snapshot of the task being answered still shows it paused on the
     * very question the answer is for. Such a snapshot comes first when the answer
     * reaches the agent, before the agent has read it: it is not a new pause, and
     * taking it for one would end the turn before the agent says anything.
     */
    private isStale(task: Task): boolean {
        const answering = this.answering;
        return answering !== undefined
            && task.id === answering.id
            && task.status?.state === answering.state
            && (task.status?.message?.messageId ?? '') === answering.statusMessageId;
    }
    private track(taskId: string, status: Task['status']): boolean {
        const state = status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
        this.task = { id: taskId, state, statusMessageId: status?.message?.messageId ?? '' };
        this.answering = undefined;
        if (status?.message !== undefined) {
            this.showMessage(status.message);
        }
        const shown = statusOfTask(state);
        if (shown !== undefined) {
            this.setStatus(shown.status, shown.reason);
        }
        return FINAL_STATES.includes(state) || INTERRUPTED_STATES.includes(state);
    }
    // --- the inbox: what the agent says of its own ----------------------------------------------------------
    /**
     * Opens the inbox of an agent that offers it, and keeps it open in the
     * background until the session ends: stop and restart abort it.
     */
    private openInbox(): void {
        const client = this.client;
        if (client === undefined || this.card?.inbox !== true) {
            return;
        }
        if (!this.card.streaming) {
            this.log('the agent offers the inbox but cannot stream: what it says of its own will not show here');
            return;
        }
        void this.followInbox(client, this.session.signal);
    }
    /**
     * Reads the inbox for as long as the session lasts. A stream that breaks off
     * is caught up with `GetTask` and reconnected to with `SubscribeToTask`; an
     * inbox task the agent no longer has — it restarted — is opened anew.
     */
    private async followInbox(client: Client, signal: AbortSignal): Promise<void> {
        const progress: InboxProgress = { taskId: undefined, failures: 0, refused: false };
        let lastError: unknown;
        while (!signal.aborted && !progress.refused) {
            lastError = undefined;
            try {
                await this.readInbox(client, progress, signal);
            } catch (error) {
                lastError = error;
            }
            if (signal.aborted || progress.refused) {
                return;
            }
            if (progress.failures++ === 0) {
                this.log(`lost the inbox, reconnecting: ${describeError(lastError ?? 'closed early')}`);
            }
            await pause(this.backoff(progress.failures - 1), signal);
        }
    }
    /** Reads one stream of the inbox until it ends. */
    private async readInbox(client: Client, progress: InboxProgress, signal: AbortSignal): Promise<void> {
        const stream = await this.inboxStream(client, progress, signal);
        for await (const event of stream ?? []) {
            if (progress.failures > 0) {
                this.log('the inbox is back');
            }
            progress.failures = 0;
            this.tracker?.activity();
            this.applyInbox(event, progress);
        }
    }
    /** The stream to read the inbox from: a new inbox, or the one open before; nothing when that one is over. */
    private async inboxStream(
        client: Client,
        progress: InboxProgress,
        signal: AbortSignal
    ): Promise<AsyncGenerator<StreamResponse> | undefined> {
        const taskId = progress.taskId;
        if (taskId === undefined) {
            const request = extensionRequest(INBOX_EXTENSION, 'flotti listens for what you say of your own.', { action: 'subscribe' });
            return client.sendMessageStream(sendRequest(request), {
                signal,
                serviceParameters: ServiceParameters.create(withA2AExtensions(INBOX_EXTENSION))
            });
        }
        const task = await this.inboxTask(client, taskId, progress, signal);
        this.applyInbox({ payload: { $case: 'task', value: task } }, progress);
        return progress.taskId === undefined || progress.refused
            ? undefined
            : client.resubscribeTask({ tenant: '', id: taskId }, { signal });
    }
    /** The inbox task as the agent has it now. */
    private async inboxTask(client: Client, taskId: string, progress: InboxProgress, signal: AbortSignal): Promise<Task> {
        try {
            return await client.getTask({ tenant: '', id: taskId }, { signal });
        } catch (error) {
            // The agent does not know the task any more: it restarted. A new inbox, then.
            progress.taskId = undefined;
            throw error;
        }
    }
    /** Shows one event of the inbox, and learns from it what became of the inbox task. */
    private applyInbox(event: StreamResponse, progress: InboxProgress): void {
        const payload = event.payload;
        switch (payload?.$case) {
            case 'message':
                this.refuseInbox(payload.value, progress);
                return;
            case 'task':
                this.showTaskContents(payload.value, message => this.inboxMessage(message));
                this.trackInbox(payload.value.id, payload.value.status, progress);
                return;
            case 'statusUpdate':
                this.trackInbox(payload.value.taskId, payload.value.status, progress);
                return;
            case 'artifactUpdate':
                this.showArtifactUpdate(payload.value);
                return;
            default:
                return;
        }
    }
    /** The agent answered the inbox request with a message: it keeps no inbox. */
    private refuseInbox(message: Message, progress: InboxProgress): void {
        this.inboxMessage(message);
        this.log('the agent answered the inbox request with a message: it keeps no inbox');
        progress.refused = true;
    }
    private trackInbox(taskId: string, status: Task['status'], progress: InboxProgress): void {
        progress.taskId = taskId;
        if (status?.message !== undefined) {
            this.inboxMessage(status.message);
        }
        const state = status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
        if (state === TaskState.TASK_STATE_REJECTED || state === TaskState.TASK_STATE_FAILED) {
            const why = status?.message === undefined ? '' : `: ${partsText(status.message.parts)}`;
            this.log(`the agent turned the inbox down${why}`);
            progress.refused = true;
        } else if (FINAL_STATES.includes(state)) {
            // Closed by the agent — it is going away, say. The next inbox is a new one.
            progress.taskId = undefined;
        }
    }
    /** A message that came through the inbox: a message of the agent's own, or a line of progress. */
    private inboxMessage(message: Message): void {
        const params = inboxParams(message);
        if (params.kind === 'progress') {
            const id = message.messageId || randomUUID();
            const text = partsText(message.parts);
            if (!this.shown.has(id) && text !== '') {
                this.events.emit({ type: 'progress', text });
            }
            this.shown.add(id);
        } else {
            this.showMessage(message, params.to);
        }
        if (params.busy !== undefined) {
            this.noteBusyOnItsOwn(params.busy);
        }
    }
    /** The agent said through the inbox whether it is busy on its own: outside a turn the status follows. */
    private noteBusyOnItsOwn(busy: boolean): void {
        this.busyOnItsOwn = busy;
        if (!this.inTurn && busy && this.currentStatus === 'idle') {
            this.setStatus('working');
        } else if (!this.inTurn && !busy && this.currentStatus === 'working') {
            this.setStatus('idle');
        }
    }
    private log(text: string): void {
        this.events.emit({ type: 'log', source: 'flotti', text });
    }
    /** A message of the agent; `to` — the agent of the fleet it is for, when it is not for a person. */
    private showMessage(message: Message, to?: string): void {
        const id = message.messageId || randomUUID();
        if (this.shown.has(id)) {
            return;
        }
        this.shown.add(id);
        const text = partsText(message.parts);
        if (text !== '') {
            this.events.emit({ type: 'message', role: 'agent', messageId: id, text, append: false, ...(to === undefined ? {} : { to }) });
        }
    }
    private showArtifact(taskId: string, artifactId: string, parts: readonly Part[], append: boolean): void {
        const text = partsText(parts);
        if (text !== '' || !append) {
            this.events.emit({ type: 'message', role: 'agent', messageId: `${taskId}/${artifactId}`, text, append });
        }
    }
    /**
     * A message from a person, or from another agent of the fleet when `from`
     * names it; it answers the task when the task is waiting for one.
     */
    private userMessage(text: string, options: SendOptions): Message {
        const task = this.task;
        const waiting = task !== undefined && INTERRUPTED_STATES.includes(task.state);
        const { from } = options;
        const body = composeText(text, options, this.agentId);
        const told = from === undefined || this.card?.inbox === true ? body : `[from ${from}] ${body}`;
        return {
            messageId: options.messageId ?? randomUUID(),
            contextId: this.contextId ?? '',
            taskId: waiting ? task.id : '',
            role: Role.ROLE_USER,
            parts: [textPart(told)],
            metadata: from === undefined ? undefined : { [INBOX_EXTENSION]: { from } },
            extensions: from === undefined ? [] : [INBOX_EXTENSION],
            referenceTaskIds: []
        };
    }
    private setStatus(status: AgentStatus, reason?: string): void {
        if (status === this.currentStatus && reason === this.currentReason) {
            return;
        }
        this.currentStatus = status;
        this.currentReason = reason;
        this.events.emit(reason === undefined ? { type: 'status', status } : { type: 'status', status, reason });
    }
    private endSession(): void {
        this.session.abort();
        this.session = new AbortController();
        this.queue = Promise.resolve();
        this.turns = 0;
        const reason = `Agent ${this.agentId} was stopped before the message was sent.`;
        for (const [messageId, refused] of [...this.waiting]) {
            this.waiting.delete(messageId);
            this.events.emit({ type: 'unqueued', messageId, outcome: 'dropped', reason });
            refused(new Error(reason));
        }
    }
    private forgetConversation(): void {
        this.contextId = undefined;
        this.task = undefined;
        this.busyOnItsOwn = false;
        this.shown.clear();
    }
    private backoff(attempt: number): number {
        return Math.min(this.reconnectDelayMs * 2 ** attempt, this.reconnectDelayMaxMs);
    }
}
/**
 * Where the card is: `<url>/.well-known/agent-card.json`, or the url itself
 * when it names a `.json` file — for agents that keep their card elsewhere.
 */
function cardLocation(url: string): { readonly base: string; readonly path: string } {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('.json')) {
        return { base: parsed.href, path: '' };
    }
    if (!parsed.pathname.endsWith('/')) {
        parsed.pathname += '/';
    }
    return { base: parsed.href, path: AGENT_CARD_PATH };
}
/**
 * Headers that prove flotti to the agent. The secret is read from the
 * environment variable the manifest names, on every request, and never kept.
 */
function authHeaders(auth: RemoteAuth, env: Environment): Record<string, string> {
    switch (auth.type) {
        case 'none':
            return {};
        case 'bearer':
            return { Authorization: `Bearer ${secret(auth.tokenEnv, env)}` };
        case 'api-key':
            return { [auth.header]: secret(auth.valueEnv, env) };
    }
}
function secret(variable: string, env: Environment): string {
    const value = env[variable];
    if (value === undefined || value === '') {
        throw new Error(`The environment variable ${variable} named by the manifest is not set.`);
    }
    return value;
}
/**
 * Keeps the agent card between reads: while `Cache-Control: max-age` says it
 * is fresh it is not asked for at all, and after that it is asked for with
 * `If-None-Match`, so an unchanged card costs a `304`.
 */
function cachingCardFetch(base: typeof fetch): typeof fetch {
    let cached: CachedCard | undefined;
    return async (input, init) => {
        if (cached !== undefined && Date.now() < cached.freshUntil) {
            return replayCard(cached.body);
        }
        const response = await base(input, { ...init, headers: revalidatingHeaders(init, cached) });
        if (response.status === 304 && cached !== undefined) {
            cached.freshUntil = Date.now() + freshFor(response.headers.get('Cache-Control'));
            return replayCard(cached.body);
        }
        if (!response.ok) {
            return response;
        }
        const body = await response.text();
        cached = cacheEntry(body, response.headers);
        return replayCard(body);
    };
}
/** A kept card, answered as if the agent sent it. */
function replayCard(body: string): Response {
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}
/** Headers of a card request; `If-None-Match` when the kept card has an `ETag`. */
function revalidatingHeaders(init: RequestInit | undefined, cached: CachedCard | undefined): Headers {
    const headers = new Headers(init?.headers);
    if (cached?.etag != null) {
        headers.set('If-None-Match', cached.etag);
    }
    return headers;
}
/** What to keep of a card just read; nothing when its `Cache-Control` says `no-store`. */
function cacheEntry(body: string, headers: Headers): CachedCard | undefined {
    const cacheControl = headers.get('Cache-Control');
    return /\bno-store\b/i.test(cacheControl ?? '')
        ? undefined
        : { body, etag: headers.get('ETag'), freshUntil: Date.now() + freshFor(cacheControl) };
}
/** Milliseconds a response stays fresh by its `Cache-Control`; 0 means "check every time". */
function freshFor(cacheControl: string | null): number {
    if (cacheControl === null || /\bno-cache\b/i.test(cacheControl)) {
        return 0;
    }
    const maxAge = /\bmax-age=(\d+)/i.exec(cacheControl);
    return maxAge === null ? 0 : Number(maxAge[1]) * 1_000;
}
function describeCard(card: AgentCard, protocolVersion: string): A2AAgentInfo {
    const harness = cardHarness(card);
    return {
        name: card.name,
        description: card.description,
        version: card.version,
        protocolVersion,
        streaming: card.capabilities?.streaming === true,
        restart: (card.capabilities?.extensions ?? []).some(extension => extension.uri === RESTART_EXTENSION),
        inbox: (card.capabilities?.extensions ?? []).some(extension => extension.uri === INBOX_EXTENSION),
        ...(harness === undefined ? {} : { harness }),
        signed: (card.signatures ?? []).length > 0,
        security: Object.keys(card.securitySchemes ?? {}),
        skills: (card.skills ?? []).map(skill => ({ id: skill.id, name: skill.name, description: skill.description }))
    };
}
/** The harness the card names in the harness extension; a missing or empty name is no name. */
function cardHarness(card: AgentCard): string | undefined {
    const extension = (card.capabilities?.extensions ?? []).find(item => item.uri === HARNESS_EXTENSION);
    const harness: unknown = extension?.params?.['harness'];
    return typeof harness === 'string' && harness.trim() !== '' ? harness : undefined;
}
/**
 * Asks the agent to restart itself through the restart extension. Any answer
 * but a failed or rejected task means the agent took the request.
 */
async function askToRestart(client: Client): Promise<void> {
    const request = extensionRequest(RESTART_EXTENSION, 'Restart requested by flotti.', { action: 'restart' });
    const result = await client.sendMessage(sendRequest(request), {
        serviceParameters: ServiceParameters.create(withA2AExtensions(RESTART_EXTENSION))
    });
    if ('messageId' in result) {
        return;
    }
    const state = result.status?.state;
    if (state === TaskState.TASK_STATE_FAILED || state === TaskState.TASK_STATE_REJECTED) {
        const why = result.status?.message === undefined ? '' : `: ${partsText(result.status.message.parts)}`;
        throw new Error(`the agent refused to restart${why}`);
    }
}
/**
 * A message that belongs to no conversation and asks something of an extension:
 * the request is in the metadata, under the extension URI; the text is for
 * agents and logs that show messages to people.
 */
function extensionRequest(uri: string, text: string, params: Record<string, unknown>): Message {
    return {
        messageId: randomUUID(),
        contextId: '',
        taskId: '',
        role: Role.ROLE_USER,
        parts: [textPart(text)],
        metadata: { [uri]: params },
        extensions: [uri],
        referenceTaskIds: []
    };
}
/** What an inbox message says of itself under the extension URI; anything else there is ignored. */
function inboxParams(message: Message): { readonly kind: 'message' | 'progress'; readonly busy?: boolean; readonly to?: string } {
    const params: unknown = message.metadata?.[INBOX_EXTENSION];
    if (typeof params !== 'object' || params === null) {
        return { kind: 'message' };
    }
    const { kind, busy, to } = params as Record<string, unknown>;
    return {
        kind: kind === 'progress' ? 'progress' : 'message',
        ...(typeof busy === 'boolean' ? { busy } : {}),
        ...(typeof to === 'string' && to !== '' ? { to } : {})
    };
}
function sendRequest(message: Message) {
    return { tenant: '', message, configuration: undefined, metadata: undefined };
}
function textPart(text: string): Part {
    return { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' };
}
/** Text of the parts: text as it is, data as JSON, files as a line naming them. */
function partsText(parts: readonly Part[]): string {
    return parts.map(part => {
        const content = part.content;
        switch (content?.$case) {
            case 'text':
                return content.value;
            case 'data':
                return `\`\`\`json\n${JSON.stringify(content.value, null, 2)}\n\`\`\``;
            case 'url':
                return `[${part.filename || content.value}](${content.value})`;
            case 'raw':
                return `[${part.filename || 'file'}, ${part.mediaType || 'binary'}, ${content.value.length} bytes]`;
            default:
                return '';
        }
    }).filter(text => text !== '').join('\n');
}
/** How a task state shows on the dashboard; nothing for a state that says nothing. */
function statusOfTask(state: TaskState): { status: AgentStatus; reason?: string } | undefined {
    switch (state) {
        case TaskState.TASK_STATE_SUBMITTED:
        case TaskState.TASK_STATE_WORKING:
            return { status: 'working' };
        case TaskState.TASK_STATE_INPUT_REQUIRED:
            return { status: 'waiting', reason: 'input required' };
        case TaskState.TASK_STATE_AUTH_REQUIRED:
            return { status: 'waiting', reason: 'authentication required' };
        default:
            return statusOfStoppedTask(state);
    }
}
/** How a task that stopped shows on the dashboard; nothing for a state that says nothing. */
function statusOfStoppedTask(state: TaskState): { status: AgentStatus; reason?: string } | undefined {
    switch (state) {
        case TaskState.TASK_STATE_COMPLETED:
            return { status: 'idle' };
        case TaskState.TASK_STATE_CANCELED:
            return { status: 'idle', reason: 'canceled' };
        case TaskState.TASK_STATE_FAILED:
            return { status: 'error', reason: 'the task failed' };
        case TaskState.TASK_STATE_REJECTED:
            return { status: 'error', reason: 'the agent rejected the task' };
        default:
            return undefined;
    }
}
function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
/** Waits, or stops waiting as soon as the signal is aborted. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
    });
}
export { A2AAgent, HARNESS_EXTENSION, INBOX_EXTENSION, RESTART_EXTENSION, cardLocation };
export type { A2AAgentInfo, A2AAgentOptions };
