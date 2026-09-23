import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentSummary, Delivery } from './dashboard-protocol.js';
/**
 * The fleet as tools: an MCP server flotti hands to every ACP agent it starts,
 * in `mcpServers` of `session/new`, so a bare Claude Code or Codex can see its
 * neighbours and write to them with no configuration of its own.
 *
 * Streamable HTTP, answered with plain JSON: both adapters take an MCP server
 * over HTTP (claude-agent-acp 0.81.1: `http` and `sse`; codex-acp 1.13.1: `http`
 * only), and HTTP is what an SSH reverse tunnel carries to an agent on another
 * host. Every agent gets a token of its own; the token tells the server who is
 * calling — the sender of the messages it sends.
 */
/** Path the tools answer on. */
const MCP_PATH = '/mcp';
/** Name of the server, as the agent sees it: its tools come as `mcp__flotti__…`. */
const MCP_SERVER_NAME = 'flotti';
/** Versions of MCP this server speaks; a client asking for another one is offered the first. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05', '2025-11-25'] as const;
/** Largest request body the server reads. */
const MAX_BODY_BYTES = 1_000_000;
/** What the tools need of the fleet: the supervisor is one. */
interface FleetDirectory {
    agents(): AgentSummary[];
    /** Sends a message on behalf of an agent of the fleet: `from` is its id. */
    send(agentId: string, text: string, from?: string): Promise<Delivery>;
}
/** How an agent reaches the tools: the port on its side and the token that says who it is. */
type FleetToolsAccess = {
    readonly port: number;
    readonly token: string;
};
type JsonRpcRequest = {
    readonly jsonrpc?: unknown;
    readonly id?: string | number | null;
    readonly method?: unknown;
    readonly params?: unknown;
};
type ToolResult = { readonly content: { type: 'text'; text: string }[]; readonly isError?: boolean };
type ToolArguments = Readonly<Record<string, unknown>>;
/** The last message one agent got from another through the tools: what `reply` and `forward` act on. */
type Received = { readonly from: string; readonly text: string };
class RpcError extends Error {
    constructor(readonly code: number, message: string) {
        super(message);
    }
}
/** A tool called with arguments it cannot take: an error result the agent reads, not a protocol error. */
class ArgumentError extends Error {}
const TOOLS = [
    {
        name: 'list_agents',
        description: 'Lists the agents of your flotti fleet: id, name, what they are for and what they are doing now. '
            + 'Your own entry is marked "you".',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'send_message',
        description: 'Sends a message to another agent of the fleet. It arrives as a message from you, and the agent '
            + 'answers with this tool too — your own answer to a person does not reach it. Do not answer '
            + 'acknowledgements: a thank-you needs no thank-you back.',
        inputSchema: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Id of the agent, as list_agents gives it.' },
                text: { type: 'string', description: 'The message.' }
            },
            required: ['to', 'text'],
            additionalProperties: false
        }
    },
    {
        name: 'reply',
        description: 'Answers the agent whose message came to you last.',
        inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'The answer.' } },
            required: ['text'],
            additionalProperties: false
        }
    },
    {
        name: 'forward',
        description: 'Forwards the last message another agent sent you, as it was, to another agent of the fleet.',
        inputSchema: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Id of the agent to forward it to.' },
                comment: { type: 'string', description: 'A few words of your own to put before it; optional.' }
            },
            required: ['to'],
            additionalProperties: false
        }
    }
] as const;
/**
 * The fleet tools of one flotti run. Listens on the loopback only; a call
 * without the token of an agent of the fleet is refused, so a web page on the
 * same machine cannot use them either.
 */
class FleetMcpServer {
    private readonly tokens = new Map<string, string>();
    private readonly agentsByToken = new Map<string, string>();
    private readonly received = new Map<string, Received>();
    private fleet: FleetDirectory | undefined;
    private constructor(private readonly server: Server, readonly port: number) {}
    /** Starts listening on a free port of the loopback; the tools answer once {@link serve} names the fleet. */
    static async start(): Promise<FleetMcpServer> {
        const started: { instance?: FleetMcpServer } = {};
        const server = createServer((request, response) => {
            if (started.instance === undefined) {
                response.writeHead(503).end();
                return;
            }
            void started.instance.handle(request, response);
        });
        const port = await new Promise<number>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.off('error', reject);
                resolve((server.address() as AddressInfo).port);
            });
        });
        started.instance = new FleetMcpServer(server, port);
        return started.instance;
    }
    /** The fleet the tools list and send to. */
    serve(fleet: FleetDirectory): void {
        this.fleet = fleet;
    }
    /** The way for this agent to reach the tools on this machine; the same token for the whole run. */
    access(agentId: string): FleetToolsAccess {
        let token = this.tokens.get(agentId);
        if (token === undefined) {
            token = randomBytes(24).toString('hex');
            this.tokens.set(agentId, token);
            this.agentsByToken.set(token, agentId);
        }
        return { port: this.port, token };
    }
    close(): Promise<void> {
        return new Promise((resolve) => {
            this.server.close(() => resolve());
            this.server.closeAllConnections();
        });
    }
    private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (path !== MCP_PATH) {
            respond(response, 404, { error: 'not found' });
            return;
        }
        const caller = this.caller(request);
        if (caller === undefined) {
            response.setHeader('WWW-Authenticate', 'Bearer');
            respond(response, 401, { error: 'the token of an agent of the fleet is required' });
            return;
        }
        if (request.method !== 'POST') {
            // No stream from the server: every answer comes with its request.
            response.setHeader('Allow', 'POST');
            respond(response, 405, { error: 'POST only' });
            return;
        }
        let body: unknown;
        try {
            body = JSON.parse(await readBody(request));
        } catch {
            respond(response, 400, rpcError(null, -32700, 'the body is not JSON'));
            return;
        }
        const requests = Array.isArray(body) ? body as JsonRpcRequest[] : [body as JsonRpcRequest];
        const answers = (await Promise.all(requests.map((item) => this.answer(caller, item))))
            .filter((answer) => answer !== undefined);
        if (answers.length === 0) {
            response.writeHead(202).end();
            return;
        }
        respond(response, 200, Array.isArray(body) ? answers : answers[0]);
    }
    private caller(request: IncomingMessage): string | undefined {
        const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
        return match === null ? undefined : this.agentsByToken.get(match[1] ?? '');
    }
    /** The answer to one JSON-RPC message; nothing for a notification or a response. */
    private async answer(caller: string, message: JsonRpcRequest): Promise<object | undefined> {
        if (typeof message !== 'object' || message === null || typeof message.method !== 'string') {
            return message?.id === undefined ? undefined : rpcError(message.id, -32600, 'not a JSON-RPC request');
        }
        if (message.id === undefined) {
            return undefined;
        }
        try {
            return { jsonrpc: '2.0', id: message.id, result: await this.call(caller, message.method, message.params) };
        } catch (error) {
            const code = error instanceof RpcError ? error.code : -32603;
            return rpcError(message.id, code, error instanceof Error ? error.message : String(error));
        }
    }
    private async call(caller: string, method: string, params: unknown): Promise<object> {
        const fields = isObject(params) ? params : {};
        switch (method) {
            case 'initialize':
                return {
                    protocolVersion: PROTOCOL_VERSIONS.find((known) => known === fields['protocolVersion'])
                        ?? PROTOCOL_VERSIONS[0],
                    capabilities: { tools: {} },
                    serverInfo: { name: MCP_SERVER_NAME, version: '1' },
                    instructions: `You are "${caller}", one agent of a flotti fleet. These tools let you see the other `
                        + 'agents and write to them.'
                };
            case 'ping':
                return {};
            case 'tools/list':
                return { tools: TOOLS };
            case 'tools/call':
                return this.tool(caller, String(fields['name'] ?? ''), isObject(fields['arguments']) ? fields['arguments'] : {})
                    .catch((error: unknown) => {
                        if (error instanceof ArgumentError) {
                            return failure(error.message);
                        }
                        throw error;
                    });
            default:
                throw new RpcError(-32601, `no method ${method}`);
        }
    }
    private async tool(caller: string, name: string, args: ToolArguments): Promise<ToolResult> {
        const fleet = this.fleet;
        if (fleet === undefined) {
            return failure('the fleet is not up yet; try again in a moment');
        }
        switch (name) {
            case 'list_agents':
                return text(JSON.stringify(fleet.agents().map((agent) =>
                    agent.id === caller ? { ...agent, you: true } : agent), null, 2));
            case 'send_message':
                return this.send(fleet, caller, stringArgument(args, 'to'), stringArgument(args, 'text'));
            case 'reply': {
                const last = this.received.get(caller);
                if (last === undefined) {
                    return failure('no agent has written to you yet; use send_message and name the agent');
                }
                return this.send(fleet, caller, last.from, stringArgument(args, 'text'));
            }
            case 'forward': {
                const last = this.received.get(caller);
                if (last === undefined) {
                    return failure('no agent has written to you yet: there is nothing to forward');
                }
                const comment = typeof args['comment'] === 'string' && args['comment'].trim() !== ''
                    ? `${args['comment'].trim()}\n\n`
                    : '';
                return this.send(fleet, caller, stringArgument(args, 'to'),
                    `${comment}Forwarded from agent "${last.from}":\n\n${last.text}`);
            }
            default:
                throw new RpcError(-32602, `no tool ${name}`);
        }
    }
    private async send(fleet: FleetDirectory, from: string, to: string, message: string): Promise<ToolResult> {
        if (to === from) {
            return failure('that is you: name another agent');
        }
        if (!fleet.agents().some((agent) => agent.id === to)) {
            return failure(`there is no agent "${to}" in the fleet; list_agents names them`);
        }
        const delivery = await fleet.send(to, message, from);
        if (delivery.result === 'failed') {
            return failure(`"${to}" did not get it: ${delivery.error ?? 'no reason given'}`);
        }
        this.received.set(to, { from, text: message });
        return text(delivery.result === 'taken'
            ? `"${to}" has it. Its answer comes to you as a message from "${to}".`
            : `"${to}" is busy: the message waits in line and reaches it once it is done.`);
    }
}
function stringArgument(args: ToolArguments, name: string): string {
    const value = args[name];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ArgumentError(`${name} is missing: it must be non-empty text`);
    }
    return value.trim();
}
function text(value: string): ToolResult {
    return { content: [{ type: 'text', text: value }] };
}
function failure(value: string): ToolResult {
    return { content: [{ type: 'text', text: value }], isError: true };
}
function rpcError(id: string | number | null, code: number, message: string): object {
    return { jsonrpc: '2.0', id, error: { code, message } };
}
function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function respond(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
}
function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        request.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('the body is too large'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        request.on('error', reject);
    });
}
export { FleetMcpServer, MCP_PATH, MCP_SERVER_NAME };
export type { FleetDirectory, FleetToolsAccess };
