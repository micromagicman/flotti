import { randomUUID } from 'node:crypto';
import { AGENT_CARD_PATH, Role, TaskState } from '@a2a-js/sdk';
import type { AgentCard, Message, Part, StreamResponse, Task } from '@a2a-js/sdk';
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
import { AgentEvents } from './agent-events.js';
import type { AgentConnection, AgentEventListener, AgentStatus } from './agent-events.js';
import type { Environment } from './manifest.js';
import type { RemoteAgent, RemoteAuth } from './types.js';
/**
 * A2A extension through which supavisor asks a remote agent to restart itself.
 * The agent declares it in `capabilities.extensions` of its card; the contract
 * is in docs/a2a-restart.md.
 */
const RESTART_EXTENSION = 'https://github.com/micromagicman/supavisor/blob/main/docs/a2a-restart.md';
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
};
/** What the agent card told about the agent, for the dashboard. */
type A2AAgentInfo = {
    readonly name: string;
    readonly description: string;
    /** Version of the agent itself, as its card states it. */
    readonly version: string;
    /** A2A version supavisor speaks to it, sent in the `A2A-Version` header. */
    readonly protocolVersion: string;
    /** Whether answers arrive as a stream; otherwise supavisor asks for the task every so often. */
    readonly streaming: boolean;
    /** Whether the agent can restart itself when asked (the supavisor restart extension). */
    readonly restart: boolean;
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
/**
 * A remote agent of the fleet, spoken to over A2A with the official SDK: the
 * card is read from the agent address, the SDK picks the transport the card
 * offers (JSON-RPC or HTTP+JSON; A2A 0.3 agents are understood too), answers
 * are streamed when the agent can stream and polled when it cannot.
 */
class A2AAgent implements AgentConnection {
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
    private readonly events = new AgentEvents();
    private currentStatus: AgentStatus = 'stopped';
    private currentReason: string | undefined;
    private client: Client | undefined;
    private card: A2AAgentInfo | undefined;
    /** Aborted by stop and restart: ends the streams and drops the queued messages. */
    private session = new AbortController();
    /** Messages wait here while the agent is busy with the previous one. */
    private queue: Promise<void> = Promise.resolve();
    private contextId: string | undefined;
    private task: CurrentTask | undefined;
    /** The paused task the message of the current turn answers, as it was when the message went. */
    private answering: CurrentTask | undefined;
    /** Ids of the agent messages already shown: a task snapshot repeats them. */
    private readonly shown = new Set<string>();
    constructor(agent: RemoteAgent, options: A2AAgentOptions = {}) {
        this.agentId = agent.id;
        this.agent = agent;
        this.env = options.env ?? process.env;
        const base = options.fetch ?? globalThis.fetch;
        this.fetch = createAuthenticatingFetchWithRetry(base, {
            headers: async () => authHeaders(this.agent.auth, this.env),
            // A secret from the environment cannot be refreshed: a refusal is final.
            shouldRetryWithHeaders: async () => undefined
        });
        this.cardFetch = cachingCardFetch(this.fetch);
        this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
        this.reconnectAttempts = options.reconnectAttempts ?? 5;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 500;
        this.reconnectDelayMaxMs = options.reconnectDelayMaxMs ?? 5_000;
        this.restartTimeoutMs = options.restartTimeoutMs ?? 60_000;
    }
    get status(): AgentStatus {
        return this.currentStatus;
    }
    /** What the card said; absent until the agent is connected to. */
    get info(): A2AAgentInfo | undefined {
        return this.card;
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
        this.setStatus('starting');
        try {
            await this.connect();
        } catch (error) {
            this.setStatus('error', describeError(error));
            throw error;
        }
        this.setStatus('idle');
    }
    send(text: string): Promise<void> {
        const client = this.client;
        if (client === undefined) {
            return Promise.reject(new Error(`Agent ${this.agentId} is not connected; start it first.`));
        }
        const signal = this.session.signal;
        let accepted!: () => void;
        let refused!: (error: unknown) => void;
        const delivery = new Promise<void>((resolve, reject) => {
            accepted = resolve;
            refused = reject;
        });
        const turn = this.queue.then(() => this.runTurn(client, text, signal, accepted, refused));
        this.queue = turn.catch(() => undefined);
        return delivery;
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
     * Restarts the agent itself when its card offers the restart extension, and
     * reconnects once it is back. An agent without the extension cannot be
     * restarted from here: its conversation starts anew instead, which is all
     * a restart means for a process supavisor does not own.
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
            if (unfinished !== undefined) {
                await client.cancelTask({ tenant: '', id: unfinished.id, metadata: undefined }).catch(() => undefined);
            }
            this.setStatus('idle', 'new conversation: the agent cannot be restarted remotely');
            return;
        }
        this.setStatus('starting', 'restarting');
        try {
            await askToRestart(client);
            await this.reconnect();
        } catch (error) {
            this.setStatus('error', describeError(error));
            throw error;
        }
        this.setStatus('idle', 'restarted');
    }
    async stop(): Promise<void> {
        this.endSession();
        this.client = undefined;
        this.forgetConversation();
        this.setStatus('stopped');
    }
    private async connect(): Promise<void> {
        authHeaders(this.agent.auth, this.env);
        const legacyCompat = { enabled: true };
        const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
            transports: [
                new JsonRpcTransportFactory({ fetchImpl: this.fetch, legacyCompat }),
                new RestTransportFactory({ fetchImpl: this.fetch, legacyCompat })
            ],
            cardResolver: new DefaultAgentCardResolver({ fetchImpl: this.cardFetch, legacyCompat }),
            clientConfig: { polling: true }
        }));
        const location = cardLocation(this.agent.url);
        const client = await factory.createFromUrl(location.base, location.path);
        // The extended card, when the agent has one for those who proved themselves.
        const card = await client.getAgentCard({ signal: this.session.signal });
        this.client = client;
        this.card = describeCard(card, client.protocolVersion);
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
        signal: AbortSignal,
        accepted: () => void,
        refused: (error: unknown) => void
    ): Promise<void> {
        if (signal.aborted) {
            refused(new Error(`Agent ${this.agentId} was stopped before the message was sent.`));
            return;
        }
        const message = this.userMessage(text);
        this.answering = message.taskId === '' ? undefined : this.task;
        let delivered = false;
        const deliver = () => {
            if (!delivered) {
                delivered = true;
                this.events.emit({ type: 'message', role: 'user', messageId: message.messageId, text, append: false });
                accepted();
            }
        };
        this.setStatus('working');
        try {
            if (this.card?.streaming === true) {
                await this.followStream(client, client.sendMessageStream(sendRequest(message), { signal }), signal, deliver);
            } else {
                const result = await client.sendMessage(sendRequest(message), { signal });
                deliver();
                const over = 'messageId' in result
                    ? this.apply({ payload: { $case: 'message', value: result } })
                    : this.apply({ payload: { $case: 'task', value: result } });
                if (!over) {
                    await this.poll(client, signal);
                }
            }
        } catch (error) {
            if (signal.aborted) {
                refused(error);
                return;
            }
            this.setStatus('error', describeError(error));
            refused(error);
        } finally {
            this.answering = undefined;
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
            if (signal.aborted || this.turnIsOver()) {
                return;
            }
            const task = this.task;
            if (!progress.received || task === undefined) {
                throw new Error('the agent closed the stream without answering');
            }
            stream = await this.catchUp(client, task, signal, progress);
        }
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
                progress.received = true;
                deliver();
                progress.failures = 0;
                if (this.apply(event)) {
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
            if (progress.failures >= this.reconnectAttempts) {
                throw new Error(`lost the stream of task ${task.id}: ${describeError(progress.lastError ?? 'closed early')}`, {
                    cause: progress.lastError
                });
            }
            await pause(this.backoff(progress.failures++), signal);
            if (signal.aborted) {
                return undefined;
            }
            try {
                const now = await client.getTask({ tenant: '', id: task.id }, { signal });
                if (this.apply({ payload: { $case: 'task', value: now } })) {
                    return undefined;
                }
                return client.resubscribeTask({ tenant: '', id: task.id }, { signal });
            } catch (error) {
                if (signal.aborted) {
                    return undefined;
                }
                progress.lastError = error;
            }
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
        const payload = event.payload;
        switch (payload?.$case) {
            case 'message': {
                this.contextId = payload.value.contextId || this.contextId;
                this.task = undefined;
                this.showMessage(payload.value);
                this.setStatus('idle');
                return true;
            }
            case 'task': {
                const task = payload.value;
                this.contextId = task.contextId || this.contextId;
                const stale = this.isStale(task);
                for (const message of task.history) {
                    if (message.role === Role.ROLE_AGENT) {
                        this.showMessage(message);
                    }
                }
                for (const artifact of task.artifacts) {
                    this.showArtifact(task.id, artifact.artifactId, artifact.parts, false);
                }
                return stale ? false : this.track(task.id, task.status);
            }
            case 'statusUpdate': {
                this.contextId = payload.value.contextId || this.contextId;
                return this.track(payload.value.taskId, payload.value.status);
            }
            case 'artifactUpdate': {
                const { artifact, taskId } = payload.value;
                if (artifact !== undefined) {
                    this.showArtifact(taskId, artifact.artifactId, artifact.parts, payload.value.append);
                }
                return false;
            }
            default:
                return false;
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
    private showMessage(message: Message): void {
        const id = message.messageId || randomUUID();
        if (this.shown.has(id)) {
            return;
        }
        this.shown.add(id);
        const text = partsText(message.parts);
        if (text !== '') {
            this.events.emit({ type: 'message', role: 'agent', messageId: id, text, append: false });
        }
    }
    private showArtifact(taskId: string, artifactId: string, parts: readonly Part[], append: boolean): void {
        const text = partsText(parts);
        if (text !== '' || !append) {
            this.events.emit({ type: 'message', role: 'agent', messageId: `${taskId}/${artifactId}`, text, append });
        }
    }
    /** A message from a person; it answers the task when the task is waiting for one. */
    private userMessage(text: string): Message {
        const task = this.task;
        const waiting = task !== undefined && INTERRUPTED_STATES.includes(task.state);
        return {
            messageId: randomUUID(),
            contextId: this.contextId ?? '',
            taskId: waiting ? task.id : '',
            role: Role.ROLE_USER,
            parts: [textPart(text)],
            metadata: undefined,
            extensions: [],
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
    }
    private forgetConversation(): void {
        this.contextId = undefined;
        this.task = undefined;
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
 * Headers that prove supavisor to the agent. The secret is read from the
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
    let cached: { body: string; etag: string | null; freshUntil: number } | undefined;
    const replay = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    return async (input, init) => {
        if (cached !== undefined && Date.now() < cached.freshUntil) {
            return replay(cached.body);
        }
        const headers = new Headers(init?.headers);
        if (cached?.etag != null) {
            headers.set('If-None-Match', cached.etag);
        }
        const response = await base(input, { ...init, headers });
        if (response.status === 304 && cached !== undefined) {
            cached.freshUntil = Date.now() + freshFor(response.headers.get('Cache-Control'));
            return replay(cached.body);
        }
        if (!response.ok) {
            return response;
        }
        const body = await response.text();
        const cacheControl = response.headers.get('Cache-Control');
        cached = /\bno-store\b/i.test(cacheControl ?? '')
            ? undefined
            : { body, etag: response.headers.get('ETag'), freshUntil: Date.now() + freshFor(cacheControl) };
        return replay(body);
    };
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
    return {
        name: card.name,
        description: card.description,
        version: card.version,
        protocolVersion,
        streaming: card.capabilities?.streaming === true,
        restart: (card.capabilities?.extensions ?? []).some(extension => extension.uri === RESTART_EXTENSION),
        signed: (card.signatures ?? []).length > 0,
        security: Object.keys(card.securitySchemes ?? {}),
        skills: (card.skills ?? []).map(skill => ({ id: skill.id, name: skill.name, description: skill.description }))
    };
}
/**
 * Asks the agent to restart itself through the restart extension. Any answer
 * but a failed or rejected task means the agent took the request.
 */
async function askToRestart(client: Client): Promise<void> {
    const request: Message = {
        messageId: randomUUID(),
        contextId: '',
        taskId: '',
        role: Role.ROLE_USER,
        parts: [textPart('Restart requested by supavisor.')],
        metadata: { [RESTART_EXTENSION]: { action: 'restart' } },
        extensions: [RESTART_EXTENSION],
        referenceTaskIds: []
    };
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
export { A2AAgent, RESTART_EXTENSION, cardLocation };
export type { A2AAgentInfo, A2AAgentOptions };
