import { randomUUID } from 'node:crypto';
import { Role } from '@a2a-js/sdk';
import type { Message, Part, StreamResponse, Task, TaskArtifactUpdateEvent, TaskState, TaskStatusUpdateEvent } from '@a2a-js/sdk';
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
import type { AgentEvent, AgentEventListener, AgentStatus, FleetAgent, SendOptions } from './agent-events.js';
import type { Environment } from './manifest.js';
import { HealthTracker } from './connection-health.js';
import type { ConnectionHealth, HealthListener, HealthTrackerOptions } from './connection-health.js';
import { SshConnection } from './ssh.js';
import type { RemoteConnection, RemoteEndpoint, SshOptions } from './ssh.js';
import type { RemoteAgent, RemoteAuth } from './types.js';
import type { AgentSummary } from './dashboard-protocol.js';
import { roster, rosterEntries } from './fleet-roster.js';
import type { Roster } from './fleet-roster.js';
import { describeError } from './describe-error.js';
import { cachingCardFetch, cardLocation, cardUrl, describeCard, hearsFleet } from './a2a-card.js';
import type { A2AAgentInfo } from './a2a-card.js';
import { inboxParams, senderMarks } from './a2a-inbox.js';
import type { AdminRequest, SaidParams } from './a2a-inbox.js';
import {
    FINAL_STATES,
    FLEET_EXTENSION,
    HARNESS_EXTENSION,
    INBOX_EXTENSION,
    INTERRUPTED_STATES,
    REFUSED_STATES,
    RESTART_EXTENSION,
    askToRestart,
    extensionRequest,
    onPayload,
    partsText,
    refusalReason,
    sendRequest,
    stateOf,
    statusMessage,
    statusMessageId,
    statusOfTask,
    stopsTurn,
    tellFleet,
    textPart,
    turnEndReason
} from './a2a-protocol.js';
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
    /**
     * Takes what the agent asks of flotti as an administrator of the fleet,
     * through the inbox (docs/a2a-inbox.md); without it such a request is
     * only a line in the tab.
     */
    readonly onAdminRequest?: (request: AdminRequest) => void;
    /**
     * The fleet the agent is in, handed to an agent that declares the fleet
     * extension (docs/a2a-fleet.md); without it the agent is told nothing of
     * the fleet.
     */
    readonly fleet?: { readonly roster: () => readonly AgentSummary[] };
    /** How long changes of the fleet are gathered before the roster goes out; 1 s by default. */
    readonly rosterDebounceMs?: number;
};
/** A round trip that takes longer than this is not measured: the connection says itself when it is gone. */
const PROBE_TIMEOUT_MS = 10_000;
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
/** What the options of an agent set with a number, and what each is when they do not. */
const TIMING_DEFAULTS = {
    pollIntervalMs: 2_000,
    reconnectAttempts: 5,
    reconnectDelayMs: 500,
    reconnectDelayMaxMs: 5_000,
    restartTimeoutMs: 60_000,
    reopenDelayMaxMs: 30_000,
    healthIntervalMs: 15_000
};
type Timing = { readonly [K in keyof typeof TIMING_DEFAULTS]: number };
/** The numbers of the options, each defaulted on its own. */
function timing(options: A2AAgentOptions): Timing {
    const entries = Object.entries(TIMING_DEFAULTS).map(([key, fallback]) => [key, options[key as keyof Timing] ?? fallback]);
    return Object.fromEntries(entries) as Timing;
}
/** An SSH tunnel for an agent with `ssh` in its manifest; nothing for one without. */
function sshConnection(agent: RemoteAgent, options: A2AAgentOptions): RemoteConnection | undefined {
    return agent.ssh === undefined ? undefined : new SshConnection(agent.ssh, options.ssh);
}
/** Keeps the health of the connection, when there is one to keep open. */
function healthTracker(connection: RemoteConnection | undefined, options: A2AAgentOptions): HealthTracker | undefined {
    return connection === undefined ? undefined : new HealthTracker(options.health);
}
/** A failed attempt to catch up with a task that is to be tried again. */
const TRY_AGAIN = Symbol('try again');
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
    /** The pauses, attempts and time limits of this agent, defaults filled in. */
    private readonly timing: Timing;
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
    /** Ids of the administrator requests already taken: a snapshot of the inbox repeats them, a new conversation too. */
    private readonly takenRequests = new Set<string>();
    /** Where the requests of an administrator go, and where the roster of the fleet comes from. */
    private readonly hooks: Pick<A2AAgentOptions, 'onAdminRequest' | 'fleet' | 'rosterDebounceMs'>;
    /** Version of the last roster the agent was sent; it only grows, whatever the session. */
    private rosterVersion = 0;
    /** The entries the agent was last sent in this session, as JSON; absent until its inbox is asked for. */
    private rosterSent: string | undefined;
    /** Gathers the changes of the fleet before the roster goes out. */
    private rosterTimer: ReturnType<typeof setTimeout> | undefined;
    /** Rosters go out one after another, never side by side. */
    private rosterLine: Promise<void> = Promise.resolve();
    constructor(agent: RemoteAgent, options: A2AAgentOptions = {}) {
        this.agentId = agent.id;
        this.agent = agent;
        this.events = new AgentEvents(agent.id);
        this.env = options.env ?? process.env;
        this.plainFetch = options.fetch ?? globalThis.fetch;
        this.fetch = this.authenticatingFetch(this.plainFetch);
        this.cardFetch = cachingCardFetch(this.fetch);
        this.timing = timing(options);
        this.hooks = options;
        this.connection = this.wayTo(agent, options);
        this.tracker = healthTracker(this.connection, options);
    }
    /** The connection to open on the way to the agent, if there is one; its drop is watched. */
    private wayTo(agent: RemoteAgent, options: A2AAgentOptions): RemoteConnection | undefined {
        const connection = options.connection ?? sshConnection(agent, options);
        connection?.onDrop((reason: string) => this.dropped(reason));
        return connection;
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
            this.startFailed(error);
            throw error;
        }
        this.setStatus('idle');
        this.openInbox();
    }
    /** The start failed: the status says why, and a tunnel is tried again. */
    private startFailed(error: unknown): void {
        this.setStatus('error', describeError(error));
        if (this.connection !== undefined) {
            // A tunnel is kept up: a host that is away now is tried again until it is back.
            void this.keepTrying(describeError(error), 1);
        }
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
        const client = this.client;
        const task = this.unfinishedTask();
        if (client === undefined || task === undefined) {
            return;
        }
        this.canceled(await client.cancelTask({ tenant: '', id: task.id, metadata: undefined }));
    }
    /** The task as it is once cancelled; shown when the conversation is still at it. */
    private canceled(task: Task): void {
        if (this.task?.id === task.id) {
            this.apply({ payload: { $case: 'task', value: task } });
        }
    }
    /** The task the conversation is at, unless it is over. */
    private unfinishedTask(): CurrentTask | undefined {
        return this.task !== undefined && !FINAL_STATES.includes(this.task.state) ? this.task : undefined;
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
        const unfinished = this.unfinishedTask();
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
    /**
     * Starts a new conversation: the next message goes with a new `contextId`,
     * so the agent does not get the old history. A task in work is cancelled,
     * and the messages in line are dropped, as a restart drops them.
     */
    async clearContext(): Promise<void> {
        const client = this.client;
        const unfinished = this.unfinishedTask();
        if (client === undefined || (unfinished === undefined && !this.inTurn)) {
            this.forgetContext();
            return;
        }
        this.endSession();
        this.forgetContext();
        await dropTask(client, unfinished);
        this.setStatus('idle');
        this.openInbox();
    }
    /** For an agent that cannot restart: drops the unfinished task, and the conversation starts anew. */
    private async startNewConversation(client: Client, unfinished: CurrentTask | undefined): Promise<void> {
        await dropTask(client, unfinished);
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
        const moved = rewrite(new URL(requestUrl(input)));
        if (moved === undefined) {
            return input;
        }
        return movedRequest(input, moved);
    }
    /** The connection broke by itself: what was in work is lost, and the way is opened again. */
    private dropped(reason: string): void {
        this.tracker?.down();
        if (this.settling) {
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
            if (!await this.waitToReopen(attempt, why, signal)) {
                return;
            }
            const failure = await this.reopenOnce(why, signal);
            if (failure === undefined) {
                return;
            }
            why = failure;
        }
    }
    /** The pause before an attempt but the first, growing with each; false once the wait was aborted. */
    private async waitToReopen(attempt: number, why: string, signal: AbortSignal): Promise<boolean> {
        if (attempt > 0) {
            const wait = Math.min(1_000 * 2 ** (attempt - 1), this.timing.reopenDelayMaxMs);
            this.setStatus('error', `${why}; trying again in ${Math.ceil(wait / 1_000)} s`);
            await pause(wait, signal);
        }
        return !signal.aborted;
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
    /** Whether the agent is stopped, starting or reopening: a drop now changes nothing. */
    private get settling(): boolean {
        return this.currentStatus === 'stopped' || this.currentStatus === 'starting' || this.reopening;
    }
    private async connect(): Promise<void> {
        const location = cardLocation(await this.address());
        const factory = this.clientFactory();
        const client = await factory.createFromUrl(location.base, location.path);
        // The extended card, when the agent has one for those who proved themselves.
        const card = await client.getAgentCard({ signal: this.session.signal });
        this.client = client;
        this.card = describeCard(card, client.protocolVersion);
        this.toldHarness = this.endpoint?.harness ?? this.card.harness;
        this.measureRoundTrips();
    }
    /**
     * The address of the agent: the one the connection gives once open, or the
     * one of the manifest. The secret is checked first, when the connection
     * brings no headers of its own.
     */
    private async address(): Promise<string> {
        const url = await this.openConnection() ?? this.agent.url;
        this.checkSecret();
        if (url === undefined) {
            throw new Error(`Agent ${this.agentId} has neither url nor ssh in its manifest.`);
        }
        return url;
    }
    /** A secret the manifest names but the environment lacks fails the connect, not the first message. */
    private checkSecret(): void {
        if (this.endpoint?.headers === undefined) {
            authHeaders(this.agent.auth, this.env);
        }
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
                await pause(this.timing.healthIntervalMs, signal);
            }
        })();
    }
    /** One round trip to the agent; a failed one tells nothing: a dropped connection says so itself. */
    private async measureRoundTrip(signal: AbortSignal): Promise<void> {
        const endpoint = this.endpoint;
        if (endpoint === undefined) {
            return;
        }
        const took = await this.roundTrip(cardUrl(endpoint.url), signal);
        if (took !== undefined) {
            this.tracker?.latency(took);
        }
    }
    /** Milliseconds the card at `card` took to come back; nothing when it did not, or the wait was aborted. */
    private async roundTrip(card: string, signal: AbortSignal): Promise<number | undefined> {
        const started = performance.now();
        try {
            const response = await this.plainFetch(this.route(card), { signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) });
            await response.body?.cancel();
            return answered(response, signal) ? performance.now() - started : undefined;
        } catch {
            // Timed out, refused or cut off: the next round trip, or the drop, will say more.
            return undefined;
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
        const deadline = Date.now() + this.timing.restartTimeoutMs;
        const signal = this.session.signal;
        for (let attempt = 0; ; attempt++) {
            if (await this.connectBefore(deadline, signal)) {
                return;
            }
            await pause(this.backoff(attempt), signal);
        }
    }
    /** One attempt to connect to the restarted agent: true once it is back; throws once the time is up. */
    private async connectBefore(deadline: number, signal: AbortSignal): Promise<boolean> {
        try {
            await this.connect();
            return true;
        } catch (error) {
            if (signal.aborted || Date.now() >= deadline) {
                throw new Error(`the agent did not come back after the restart: ${describeError(error)}`, {
                    cause: error
                });
            }
            return false;
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
            delivery.end(signal.aborted ? 'cancelled' : turnEndReason(this.task?.state));
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
        await this.sendAndPoll(client, message, signal, deliver);
    }
    /** For an agent that cannot stream: sends the message and asks for its task until the turn is over. */
    private async sendAndPoll(client: Client, message: Message, signal: AbortSignal, deliver: () => void): Promise<void> {
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
        if (this.streamDone(signal)) {
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
            return await this.takeStream(stream, deliver, progress);
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
    /** Whether no stream is to be read any more: the wait was aborted, or the turn is over. */
    private streamDone(signal: AbortSignal): boolean {
        return signal.aborted || this.turnIsOver();
    }
    /** Takes the events of one stream until it ends; true once an event finished the turn. */
    private async takeStream(stream: AsyncGenerator<StreamResponse>, deliver: () => void, progress: StreamProgress): Promise<boolean> {
        for await (const event of stream) {
            if (this.takeEvent(event, deliver, progress)) {
                return true;
            }
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
            const next = await this.tryResubscribe(client, task, signal, progress);
            if (next !== TRY_AGAIN) {
                return next;
            }
        }
    }
    /** One attempt of `catchUp`: what `resubscribe` gives, or `TRY_AGAIN` after a failure the wait survived. */
    private async tryResubscribe(
        client: Client,
        task: CurrentTask,
        signal: AbortSignal,
        progress: StreamProgress
    ): Promise<AsyncGenerator<StreamResponse> | undefined | typeof TRY_AGAIN> {
        try {
            return await this.resubscribe(client, task, signal);
        } catch (error) {
            if (signal.aborted) {
                return undefined;
            }
            progress.lastError = error;
            return TRY_AGAIN;
        }
    }
    /** Waits before the next attempt to catch up, giving up after too many; false once the wait was aborted. */
    private async waitToCatchUp(task: CurrentTask, signal: AbortSignal, progress: StreamProgress): Promise<boolean> {
        if (progress.failures >= this.timing.reconnectAttempts) {
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
    /** Whether the task of the turn has stopped or paused. */
    private turnIsOver(): boolean {
        const state = this.task?.state;
        return state !== undefined && stopsTurn(state);
    }
    /** For an agent that cannot stream: asks for the task until the turn is over. */
    private async poll(client: Client, signal: AbortSignal): Promise<void> {
        const polling = { failures: 0 };
        while (!signal.aborted) {
            await pause(this.timing.pollIntervalMs, signal);
            if (await this.pollOnce(client, signal, polling)) {
                return;
            }
        }
    }
    /** Asks for the task once; true when the turn is over or there is nothing to ask for any more. */
    private async pollOnce(client: Client, signal: AbortSignal, polling: { failures: number }): Promise<boolean> {
        const task = this.task;
        if (signal.aborted || task === undefined) {
            return true;
        }
        try {
            const over = this.apply({ payload: { $case: 'task', value: await client.getTask({ tenant: '', id: task.id }, { signal }) } });
            polling.failures = 0;
            return over;
        } catch (error) {
            this.pollFailed(error, signal, polling);
            return false;
        }
    }
    /** A failed ask for the task is tried again, up to `reconnectAttempts` in a row; then it throws. */
    private pollFailed(error: unknown, signal: AbortSignal, polling: { failures: number }): void {
        if (signal.aborted || ++polling.failures > this.timing.reconnectAttempts) {
            throw error;
        }
    }
    /** Turns one A2A event into dashboard events; tells whether the turn is over. */
    private apply(event: StreamResponse): boolean {
        this.tracker?.activity();
        return onPayload(event, {
            message: message => this.applyMessage(message),
            task: task => this.applyTask(task),
            statusUpdate: update => this.applyStatusUpdate(update),
            artifactUpdate: update => {
                this.showArtifactUpdate(update);
                return false;
            }
        }, false);
    }
    /** The task changed its state: tracked as the task of the turn. */
    private applyStatusUpdate(update: TaskStatusUpdateEvent): boolean {
        this.contextId = update.contextId || this.contextId;
        return this.track(update.taskId, update.status);
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
        return answering !== undefined && pausedOn(task, answering);
    }
    private track(taskId: string, status: Task['status']): boolean {
        const state = stateOf(status);
        this.task = { id: taskId, state, statusMessageId: statusMessageId(status) };
        this.answering = undefined;
        const message = statusMessage(status);
        if (message !== undefined) {
            this.showMessage(message);
        }
        this.showTaskState(state);
        return stopsTurn(state);
    }
    /** The status of the agent follows the state of the task, when the state says something. */
    private showTaskState(state: TaskState): void {
        const shown = statusOfTask(state);
        if (shown !== undefined) {
            this.setStatus(shown.status, shown.reason);
        }
    }
    // --- the inbox: what the agent says of its own ----------------------------------------------------------
    /**
     * Opens the inbox of an agent that offers it, and keeps it open in the
     * background until the session ends: stop and restart abort it.
     */
    private openInbox(): void {
        const client = this.client;
        const card = this.card;
        if (client === undefined || card?.inbox !== true) {
            return;
        }
        this.followInboxOf(client, card);
    }
    /** Keeps the inbox open when the agent can stream; says so when it cannot. */
    private followInboxOf(client: Client, card: A2AAgentInfo): void {
        if (!card.streaming) {
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
        while (inboxOpen(signal, progress)) {
            const lastError = await this.inboxAttempt(client, progress, signal);
            if (!inboxOpen(signal, progress)) {
                return;
            }
            this.inboxLost(lastError, progress);
            await pause(this.backoff(progress.failures - 1), signal);
        }
    }
    /** Reads the inbox until its stream ends: the error it ended with, or nothing. */
    private async inboxAttempt(client: Client, progress: InboxProgress, signal: AbortSignal): Promise<unknown> {
        try {
            await this.readInbox(client, progress, signal);
            return undefined;
        } catch (error) {
            return error;
        }
    }
    /** The stream of the inbox ended: counted, and the first loss in a row is a line in the tab. */
    private inboxLost(lastError: unknown, progress: InboxProgress): void {
        if (progress.failures++ === 0) {
            this.log(`lost the inbox, reconnecting: ${describeError(lastError ?? 'closed early')}`);
        }
    }
    /** Reads one stream of the inbox until it ends. */
    private async readInbox(client: Client, progress: InboxProgress, signal: AbortSignal): Promise<void> {
        const stream = await this.inboxStream(client, progress, signal);
        for await (const event of stream ?? []) {
            this.inboxEvent(event, progress);
        }
    }
    /** One event of the inbox: the inbox is back, if it was lost. */
    private inboxEvent(event: StreamResponse, progress: InboxProgress): void {
        if (progress.failures > 0) {
            this.log('the inbox is back');
        }
        progress.failures = 0;
        this.tracker?.activity();
        this.applyInbox(event, progress);
    }
    /** The stream to read the inbox from: a new inbox, or the one open before; nothing when that one is over. */
    private async inboxStream(
        client: Client,
        progress: InboxProgress,
        signal: AbortSignal
    ): Promise<AsyncGenerator<StreamResponse> | undefined> {
        const taskId = progress.taskId;
        if (taskId === undefined) {
            const request = this.inboxRequest();
            return client.sendMessageStream(sendRequest(request), {
                signal,
                serviceParameters: ServiceParameters.create(withA2AExtensions(...request.extensions))
            });
        }
        const task = await this.inboxTask(client, taskId, progress, signal);
        this.applyInbox({ payload: { $case: 'task', value: task } }, progress);
        return progress.taskId === undefined || progress.refused
            ? undefined
            : client.resubscribeTask({ tenant: '', id: taskId }, { signal });
    }
    /** The request that opens the inbox; with the roster of the fleet, to an agent that wants it. */
    private inboxRequest(): Message {
        const fleet = this.wantsRoster() ? this.nextRoster() : undefined;
        const request = extensionRequest(INBOX_EXTENSION, 'flotti listens for what you say of your own.', {
            action: 'subscribe',
            ...(fleet === undefined ? {} : { fleet: fleet.roster })
        });
        if (fleet === undefined) {
            return request;
        }
        this.rosterVersion = fleet.roster.version;
        this.rosterSent = fleet.key;
        return { ...request, extensions: [INBOX_EXTENSION, FLEET_EXTENSION] };
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
        onPayload(event, {
            message: message => this.refuseInbox(message, progress),
            task: task => {
                this.showTaskContents(task, message => this.inboxMessage(message));
                this.trackInbox(task.id, task.status, progress);
            },
            statusUpdate: update => this.trackInbox(update.taskId, update.status, progress),
            artifactUpdate: update => this.showArtifactUpdate(update)
        }, undefined);
    }
    /** The agent answered the inbox request with a message: it keeps no inbox. */
    private refuseInbox(message: Message, progress: InboxProgress): void {
        this.inboxMessage(message);
        this.log('the agent answered the inbox request with a message: it keeps no inbox');
        progress.refused = true;
    }
    private trackInbox(taskId: string, status: Task['status'], progress: InboxProgress): void {
        progress.taskId = taskId;
        const message = statusMessage(status);
        if (message !== undefined) {
            this.inboxMessage(message);
        }
        const state = stateOf(status);
        if (REFUSED_STATES.includes(state)) {
            this.log(`the agent turned the inbox down${refusalReason(status)}`);
            progress.refused = true;
        } else if (FINAL_STATES.includes(state)) {
            // Closed by the agent — it is going away, say. The next inbox is a new one.
            progress.taskId = undefined;
        }
    }
    /** A message that came through the inbox: a message of the agent's own, a line of progress, a request. */
    private inboxMessage(message: Message): void {
        const params = inboxParams(message);
        if (params.kind === 'admin') {
            this.adminRequest(message.messageId, params.request);
            return;
        }
        this.inboxSaid(message, params);
        if (params.busy !== undefined) {
            this.noteBusyOnItsOwn(params.busy);
        }
    }
    /** What the agent said through the inbox: a task taken back, a line of progress, or a message. */
    private inboxSaid(message: Message, params: SaidParams): void {
        if (params.cancel !== undefined) {
            this.events.emit({ type: 'cancel-delegation', delegationId: params.cancel });
        } else if (params.kind === 'progress') {
            this.showProgress(message);
        } else {
            this.showMessage(message, params.to, params.task);
        }
    }
    /** A line of progress, shown once, whatever repeats it. */
    private showProgress(message: Message): void {
        const id = messageIdOf(message);
        const text = partsText(message.parts);
        if (!this.shown.has(id) && text !== '') {
            this.events.emit({ type: 'progress', text });
        }
        this.shown.add(id);
    }
    /** A request of the agent as an administrator of the fleet: handed over once, whatever repeats it. */
    private adminRequest(messageId: string, request: AdminRequest | undefined): void {
        if (messageId !== '' && this.takenRequests.has(messageId)) {
            return;
        }
        this.takenRequests.add(messageId);
        this.handOver(request);
    }
    /** Hands a request of an administrator to whatever takes such requests; a line in the tab otherwise. */
    private handOver(request: AdminRequest | undefined): void {
        if (request === undefined) {
            this.log('the agent asked for an action of an administrator flotti does not know: "action" and "agent" say what and on whom');
        } else if (this.hooks.onAdminRequest === undefined) {
            this.log(`the agent asked to ${request.action} "${request.target}", and nothing here takes such requests`);
        } else {
            this.hooks.onAdminRequest(request);
        }
    }
    /** The agent said through the inbox whether it is busy on its own: outside a turn the status follows. */
    private noteBusyOnItsOwn(busy: boolean): void {
        this.busyOnItsOwn = busy;
        const [from, to]: readonly AgentStatus[] = busy ? ['idle', 'working'] : ['working', 'idle'];
        if (!this.inTurn && this.currentStatus === from) {
            this.setStatus(to);
        }
    }
    private log(text: string): void {
        this.events.emit({ type: 'log', source: 'flotti', text });
    }
    // --- the roster of the fleet: who the agent can write to ------------------------------------------------
    /**
     * The fleet changed — an agent came or went, was renamed, changed its
     * status. The agent is sent the roster once the changes stop for a moment;
     * nothing is sent before its inbox was asked for, nor when nothing it sees
     * changed. The roster goes outside the line of messages and starts no turn.
     */
    fleetChanged(): void {
        const client = this.client;
        if (client === undefined || !this.rosterDue()) {
            return;
        }
        const signal = this.session.signal;
        this.rosterTimer = setTimeout(() => {
            this.rosterTimer = undefined;
            this.rosterLine = this.rosterLine.then(() => this.sendRoster(client, signal));
        }, this.hooks.rosterDebounceMs ?? 1_000);
    }
    /** Whether the agent is told who is in the fleet: it declares the extension, and the inbox it goes with. */
    private wantsRoster(): boolean {
        return this.hooks.fleet !== undefined && hearsFleet(this.card);
    }
    /** Whether a change of the fleet is to be told: the inbox was asked for, and no roster is gathering yet. */
    private rosterDue(): boolean {
        return this.rosterSent !== undefined && this.rosterTimer === undefined && this.wantsRoster();
    }
    /** The roster as it is now, with the next version, and its entries as JSON to tell a change by. */
    private nextRoster(): { readonly roster: Roster; readonly key: string } {
        const entries = rosterEntries(this.hooks.fleet?.roster() ?? [], this.agentId);
        return { roster: roster(this.rosterVersion + 1, entries), key: JSON.stringify(entries) };
    }
    /** Sends the roster as a `fleet` request; a failed one is a line in the tab, and the next change tries again. */
    private async sendRoster(client: Client, signal: AbortSignal): Promise<void> {
        const next = this.nextRoster();
        if (signal.aborted || next.key === this.rosterSent) {
            return;
        }
        try {
            await tellFleet(client, next.roster, signal);
        } catch (error) {
            this.rosterFailed(error, signal);
            return;
        }
        this.rosterTold(next, signal);
    }
    /** A roster that did not go out is a line in the tab, unless the session is over. */
    private rosterFailed(error: unknown, signal: AbortSignal): void {
        if (!signal.aborted) {
            this.log(`could not tell the agent who is in the fleet: ${describeError(error)}`);
        }
    }
    /** The roster went out: the next one is told only when it differs. */
    private rosterTold(sent: { readonly roster: Roster; readonly key: string }, signal: AbortSignal): void {
        if (!signal.aborted) {
            this.rosterVersion = Math.max(this.rosterVersion, sent.roster.version);
            this.rosterSent = sent.key;
        }
    }
    /**
     * A message of the agent; `to` — the agent of the fleet it is for, when it
     * is not for a person, and `task` — when it gives that agent a task.
     */
    private showMessage(message: Message, to?: string, task?: { readonly deadline?: string }): void {
        const id = messageIdOf(message);
        if (this.shown.has(id)) {
            return;
        }
        this.shown.add(id);
        const text = partsText(message.parts);
        if (text !== '') {
            this.events.emit({ type: 'message', role: 'agent', messageId: id, text, append: false, ...addressee(id, to, task) });
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
     * names it. A message of a person answers the task when the task is waiting
     * for one; a message of an agent opens a new task, since the question was
     * asked of the person.
     */
    private userMessage(text: string, options: SendOptions): Message {
        return {
            messageId: options.messageId ?? randomUUID(),
            contextId: this.contextId ?? '',
            taskId: this.answeredTask(options),
            role: Role.ROLE_USER,
            parts: [textPart(this.toldText(text, options))],
            ...senderMarks(options),
            referenceTaskIds: []
        };
    }
    /** The task a message of a person answers, when the task is waiting for one; empty otherwise. */
    private answeredTask(options: SendOptions): string {
        const task = this.task;
        return options.from === undefined && task !== undefined && INTERRUPTED_STATES.includes(task.state) ? task.id : '';
    }
    /** The text as the agent gets it: an agent without the inbox is told the sender in front of it. */
    private toldText(text: string, options: SendOptions): string {
        const body = composeText(text, options, this.agentId);
        return options.from === undefined || this.card?.inbox === true ? body : `[from ${options.from}] ${body}`;
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
        clearTimeout(this.rosterTimer);
        this.rosterTimer = undefined;
        this.rosterSent = undefined;
        this.rosterLine = Promise.resolve();
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
    /** The conversation starts anew; what was shown stays shown. */
    private forgetContext(): void {
        this.contextId = undefined;
        this.task = undefined;
        this.answering = undefined;
    }
    private forgetConversation(): void {
        this.contextId = undefined;
        this.task = undefined;
        this.busyOnItsOwn = false;
        this.shown.clear();
    }
    private backoff(attempt: number): number {
        return Math.min(this.timing.reconnectDelayMs * 2 ** attempt, this.timing.reconnectDelayMaxMs);
    }
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
/** Cancels a task that is not over; a refusal changes nothing, the task is dropped either way. */
async function dropTask(client: Client, task: CurrentTask | undefined): Promise<void> {
    if (task !== undefined) {
        await client.cancelTask({ tenant: '', id: task.id, metadata: undefined }).catch(() => undefined);
    }
}
/** The address a request goes to. */
function requestUrl(input: string | URL | Request): string {
    return input instanceof Request ? input.url : input.toString();
}
/** The request sent to `moved` instead; a plain address stays a plain address. */
function movedRequest(input: string | URL | Request, moved: URL): string | Request {
    return input instanceof Request ? new Request(moved, input) : moved.href;
}
/** Whether the agent answered a round trip, and the answer is still wanted. */
function answered(response: Response, signal: AbortSignal): boolean {
    return response.ok && !signal.aborted;
}
/** Whether a snapshot shows the task paused on the very question that was asked. */
function pausedOn(task: Task, asked: CurrentTask): boolean {
    return task.id === asked.id && task.status?.state === asked.state && statusMessageId(task.status) === asked.statusMessageId;
}
/** Whether the inbox is still to be read: the session goes on, and the agent did not turn it down. */
function inboxOpen(signal: AbortSignal, progress: InboxProgress): boolean {
    return !signal.aborted && !progress.refused;
}
/** The id of a message; one of its own for a message without. */
function messageIdOf(message: Message): string {
    return message.messageId || randomUUID();
}
/** Who a message of the agent is for, when not for a person, and the task it gives that agent. */
function addressee(id: string, to?: string, task?: { readonly deadline?: string }): Pick<AgentEvent & { type: 'message' }, 'to' | 'delegation'> {
    if (to === undefined) {
        return {};
    }
    return task === undefined ? { to } : { to, delegation: { id, ...task } };
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
export { A2AAgent, FLEET_EXTENSION, HARNESS_EXTENSION, INBOX_EXTENSION, RESTART_EXTENSION, cardLocation };
export type { A2AAgentInfo, A2AAgentOptions, AdminRequest };
