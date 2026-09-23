import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Role, TaskState } from '@a2a-js/sdk';
import type { AgentCard, Message, Part } from '@a2a-js/sdk';
import {
    AgentEvent,
    DefaultRequestHandler,
    InMemoryTaskStore,
    JsonRpcTransportHandler,
    defaultServerCallContextBuilder,
    validateVersion
} from '@a2a-js/sdk/server';
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server';
/** What the test agent does with a message: publishes events to the bus. */
type Script = (context: RequestContext, bus: ExecutionEventBus) => Promise<void>;
type FakeAgentOptions = {
    readonly streaming?: boolean;
    /** URIs of the extensions the card declares. */
    readonly extensions?: readonly string[];
    /** `Cache-Control` of the card; `no-cache` by default. */
    readonly cardCacheControl?: string;
    /** Path of the card and the endpoint under the server root, e.g. `/a2a`. */
    readonly prefix?: string;
    readonly script: Script;
    /** Called for every SSE event about to be written; `true` drops the connection instead. */
    readonly dropStream?: (method: string, index: number) => boolean;
    /** Speaks A2A 0.3 only: a 0.3 card and the 0.3 JSON-RPC methods. */
    readonly legacy?: boolean;
};
/** One request that reached the fake agent. */
type Received = {
    readonly method: string;
    readonly headers: IncomingHttpHeaders;
    readonly params: Record<string, unknown>;
};
/**
 * A real A2A server — the SDK request handler behind a plain node:http server,
 * speaking JSON-RPC and SSE — with a scripted agent in it, so that the client
 * is tested against the protocol and not against a mock of it.
 */
class FakeAgent {
    readonly received: Received[] = [];
    cardRequests = 0;
    cardNotModified = 0;
    private readonly server = createServer((request, response) => {
        void this.route(request, response);
    });
    private readonly options: FakeAgentOptions;
    private handler!: JsonRpcTransportHandler | LegacyJsonRpcTransportHandler;
    private card!: AgentCard;
    constructor(options: FakeAgentOptions) {
        this.options = options;
    }
    async listen(): Promise<this> {
        await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
        this.card = this.makeCard();
        const requestHandler = new DefaultRequestHandler(
            this.card,
            new InMemoryTaskStore(),
            {
                execute: (context, bus) => this.options.script(context, bus),
                cancelTask: async (taskId, bus) => {
                    bus.publish(statusUpdate(taskId, '', TaskState.TASK_STATE_CANCELED));
                    bus.finished();
                }
            }
        );
        this.handler = this.options.legacy === true
            ? new LegacyJsonRpcTransportHandler(requestHandler)
            : new JsonRpcTransportHandler(requestHandler);
        return this;
    }
    /** Address to put in the manifest. */
    get url(): string {
        const { port } = this.server.address() as AddressInfo;
        return `http://127.0.0.1:${port}${this.options.prefix ?? ''}`;
    }
    methods(): string[] {
        return this.received.map(request => request.method);
    }
    async close(): Promise<void> {
        this.server.closeAllConnections();
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }
    private makeCard(): AgentCard {
        return {
            name: 'Fake',
            description: 'An agent for the tests',
            version: '1.2.3',
            supportedInterfaces: [{ url: `${this.url}/rpc`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
            provider: undefined,
            capabilities: {
                streaming: this.options.streaming ?? true,
                extensions: (this.options.extensions ?? []).map(uri => ({ uri, description: '', required: false, params: undefined })),
                extendedAgentCard: false
            },
            securitySchemes: {},
            securityRequirements: [],
            defaultInputModes: ['text/plain'],
            defaultOutputModes: ['text/plain'],
            skills: [{ id: 'echo', name: 'Echo', description: 'Says it back', tags: [], examples: [], inputModes: [], outputModes: [], securityRequirements: [] }],
            signatures: []
        };
    }
    /** The card as an A2A 0.3 agent publishes it. */
    private legacyCard(): Record<string, unknown> {
        return {
            protocolVersion: '0.3.0',
            name: this.card.name,
            description: this.card.description,
            url: `${this.url}/rpc`,
            preferredTransport: 'JSONRPC',
            version: this.card.version,
            capabilities: { streaming: this.options.streaming ?? true },
            defaultInputModes: ['text/plain'],
            defaultOutputModes: ['text/plain'],
            skills: [{ id: 'echo', name: 'Echo', description: 'Says it back', tags: [] }]
        };
    }
    private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const prefix = this.options.prefix ?? '';
        if (request.method === 'GET' && request.url === `${prefix}/.well-known/agent-card.json`) {
            this.serveCard(request, response);
            return;
        }
        if (request.method === 'POST' && request.url === `${prefix}/rpc`) {
            await this.serveRpc(request, response);
            return;
        }
        response.writeHead(404).end();
    }
    private serveCard(request: IncomingMessage, response: ServerResponse): void {
        this.cardRequests++;
        const body = JSON.stringify(this.options.legacy === true ? this.legacyCard() : this.card);
        const etag = `"${createHash('sha1').update(body).digest('hex')}"`;
        response.setHeader('ETag', etag);
        response.setHeader('Cache-Control', this.options.cardCacheControl ?? 'no-cache');
        if (request.headers['if-none-match'] === etag) {
            this.cardNotModified++;
            response.writeHead(304).end();
            return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
    }
    private async serveRpc(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
            chunks.push(chunk as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method: string; params: Record<string, unknown> };
        this.received.push({ method: body.method, headers: request.headers, params: body.params });
        const version = request.headers['a2a-version'];
        const context = defaultServerCallContextBuilder({
            extensions: undefined,
            user: undefined,
            headers: request.headers as Record<string, string>,
            requestedVersion: typeof version === 'string' ? version : undefined
        });
        if (this.options.legacy !== true) {
            validateVersion(context.requestedVersion, this.card, 'JSONRPC');
        }
        const result = await this.handler.handle(body, context);
        if (!(Symbol.asyncIterator in result)) {
            response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
            return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        response.flushHeaders();
        let index = 0;
        for await (const event of result) {
            if (this.options.dropStream?.(body.method, index++) === true) {
                response.destroy();
                return;
            }
            // Written out before the next one, so that a drop loses only what follows it.
            await new Promise<void>(resolve => response.write(`data: ${JSON.stringify(event)}\n\n`, () => resolve()));
        }
        response.end();
    }
}
function text(value: string): Part {
    return { content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' };
}
function agentMessage(value: string, context: RequestContext, messageId = `reply-${context.taskId}`): Message {
    return {
        messageId,
        contextId: context.contextId,
        taskId: context.taskId,
        role: Role.ROLE_AGENT,
        parts: [text(value)],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: []
    };
}
/** The task of the request, in the state given, as the first event of a turn. */
function task(context: RequestContext, state: TaskState): ReturnType<typeof AgentEvent.task> {
    return AgentEvent.task({
        id: context.taskId,
        contextId: context.contextId,
        status: { state, message: undefined, timestamp: undefined },
        artifacts: [],
        history: [context.userMessage],
        metadata: undefined
    });
}
function statusUpdate(taskId: string, contextId: string, state: TaskState, message?: Message): ReturnType<typeof AgentEvent.statusUpdate> {
    return AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state, message, timestamp: undefined },
        metadata: undefined
    });
}
function artifact(context: RequestContext, artifactId: string, value: string, append: boolean): ReturnType<typeof AgentEvent.artifactUpdate> {
    return AgentEvent.artifactUpdate({
        taskId: context.taskId,
        contextId: context.contextId,
        artifact: { artifactId, name: '', description: '', parts: [text(value)], metadata: undefined, extensions: [] },
        append,
        lastChunk: false,
        metadata: undefined
    });
}
/** The text of the message the agent got. */
function said(context: RequestContext): string {
    const content = context.userMessage.parts[0]?.content;
    return content?.$case === 'text' ? content.value : '';
}
/** A promise with its resolve at hand, to let a scripted agent go on when the test says so. */
function gate(): { promise: Promise<void>; open: () => void } {
    let open!: () => void;
    const promise = new Promise<void>(resolve => {
        open = resolve;
    });
    return { promise, open };
}
export { FakeAgent, agentMessage, artifact, gate, said, statusUpdate, task, text };
export type { FakeAgentOptions, Received, Script };
