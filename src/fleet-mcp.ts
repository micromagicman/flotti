import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AdminAction, Forwarded, SendOptions } from './agent-events.js';
import type { AgentSummary, Delivery } from './dashboard-protocol.js';
import type { DelegationCancel, DelegationStart } from './delegations.js';
import type { AdminOutcome } from './fleet-admin.js';
import { MEMORY_TOOLS, callMemoryTool, isMemoryTool } from './memory-tools.js';
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
    send(agentId: string, text: string, options?: SendOptions): Promise<Delivery>;
    /** Gives a task on behalf of an agent of the fleet: `from` is its id; `deadline` an ISO 8601 time. */
    delegate(from: string, to: string, text: string, deadline?: string): Promise<DelegationStart>;
    /** Takes back a task the agent `from` gave; throws when it gave no such task. */
    cancelDelegation(from: string, delegationId: string): DelegationCancel;
    /**
     * Restarts an agent or clears its context on behalf of an administrator of
     * the fleet; refuses anyone else. Without it the tools of administrators
     * answer that they are not available.
     */
    administer?(adminId: string, action: AdminAction, target: string): Promise<AdminOutcome>;
    /**
     * Where the memory bank of the agent is, for the memory tools (#101);
     * undefined for an agent whose memory flotti does not keep — a remote one,
     * one on an SSH host. Without it no agent gets the memory tools.
     */
    memoryBank?(agentId: string): string | undefined;
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
/**
 * The last message one agent got from another — through the tools, or sent on
 * by the supervisor: what `reply` and `forward` act on.
 */
type Received = {
    readonly from: string;
    /** Its `messageId` in the tab of the agent that got it: a reply quotes it. */
    readonly messageId: string;
    readonly text: string;
    readonly forwarded?: Forwarded;
};
/**
 * A message of one agent the supervisor handed to another past the tools — a
 * message of a remote agent, an answer sent back at the end of a turn — so
 * that `reply` and `forward` of the receiver act on it too.
 */
type DeliveredMessage = Received & {
    /** Id of the agent that got it. */
    readonly to: string;
};
/** What one call of a tool sends, besides the receiver and the text. */
type Extras = Pick<SendOptions, 'replyTo' | 'forwarded'>;
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
            + 'Your own entry is marked "you", administrators of the fleet "admin".',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'send_message',
        description: 'Sends a message to another agent of the fleet. It arrives as a message from you, and what the '
            + 'agent answers comes back to you as a message from it. A message another agent sent you is answered '
            + 'the same way: just answer it, no tool needed. Do not answer acknowledgements: a thank-you needs no '
            + 'thank-you back.',
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
        description: 'Writes again to the agent whose message came to you last, quoting that message. Your answer '
            + 'in the turn of its message already reaches it: this is for writing to it later.',
        inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'The answer.' } },
            required: ['text'],
            additionalProperties: false
        }
    },
    {
        name: 'delegate',
        description: 'Gives another agent of the fleet a task and returns its id at once. The agent works on it in a '
            + 'turn of its own; when it is done, the outcome comes to you as a message from it: completed with what '
            + 'it answered, failed or canceled with why. A task that cannot be given — no such agent, the agent is '
            + 'stopped — fails at once. Use it for work you want done and reported back; send_message is for a word.',
        inputSchema: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Id of the agent, as list_agents gives it.' },
                text: { type: 'string', description: 'The task: what to do, and what to answer when done.' },
                deadline_minutes: {
                    type: 'number',
                    description: 'Optional: minutes the task may take. A task not done by then fails, and the agent stops working on it.'
                }
            },
            required: ['to', 'text'],
            additionalProperties: false
        }
    },
    {
        name: 'cancel_delegation',
        description: 'Takes back a task you gave: the agent stops working on it, or never starts on it.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string', description: 'Id of the task, as delegate returned it.' } },
            required: ['id'],
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
/** The tools of an administrator of the fleet: listed to administrators only, refused to anyone else. */
const ADMIN_TOOLS = [
    {
        name: 'restart_agent',
        description: 'Restarts an agent of the fleet — you are an administrator of it. A local agent is restarted '
            + 'as a process, a remote one is asked to restart itself. Naming yourself restarts you once this turn '
            + 'is over.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string', description: 'Id of the agent, as list_agents gives it; may be yours.' } },
            required: ['id'],
            additionalProperties: false
        }
    },
    {
        name: 'clear_context',
        description: 'Clears the context of an agent of the fleet — you are an administrator of it: its next message '
            + 'starts a new conversation, without the old history. What it is doing now is cancelled. Naming '
            + 'yourself clears yours once this turn is over.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string', description: 'Id of the agent, as list_agents gives it; may be yours.' } },
            required: ['id'],
            additionalProperties: false
        }
    }
] as const;
/** What each tool of an administrator does. */
const ADMIN_ACTIONS: Readonly<Record<string, AdminAction>> = { restart_agent: 'restart', clear_context: 'clear-context' };
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
    /** Remembers a message the supervisor delivered: the receiver's `reply` and `forward` now act on it. */
    delivered(message: DeliveredMessage): void {
        const { to, ...received } = message;
        this.received.set(to, received);
    }
    close(): Promise<void> {
        return new Promise((resolve) => {
            this.server.close(() => resolve());
            this.server.closeAllConnections();
        });
    }
    private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const caller = this.admit(request, response);
        if (caller === undefined) {
            return;
        }
        let body: unknown;
        try {
            body = JSON.parse(await readBody(request));
        } catch {
            respond(response, 400, rpcError(null, -32700, 'the body is not JSON'));
            return;
        }
        await this.answerBody(caller, body, response);
    }
    /**
     * The agent calling, when the request is one the tools take; otherwise the
     * request is answered with why not, and there is no caller.
     */
    private admit(request: IncomingMessage, response: ServerResponse): string | undefined {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (path !== MCP_PATH) {
            respond(response, 404, { error: 'not found' });
            return undefined;
        }
        const caller = this.caller(request);
        if (caller === undefined) {
            response.setHeader('WWW-Authenticate', 'Bearer');
            respond(response, 401, { error: 'the token of an agent of the fleet is required' });
            return undefined;
        }
        if (request.method !== 'POST') {
            // No stream from the server: every answer comes with its request.
            response.setHeader('Allow', 'POST');
            respond(response, 405, { error: 'POST only' });
            return undefined;
        }
        return caller;
    }
    /** Answers one JSON-RPC message or a batch of them, the way it came. */
    private async answerBody(caller: string, body: unknown, response: ServerResponse): Promise<void> {
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
                return initializeResult(caller, fields, this.isAdmin(caller), this.memoryBank(caller) !== undefined);
            case 'ping':
                return {};
            case 'tools/list':
                return { tools: this.toolsOf(caller) };
            case 'tools/call':
                return this.callTool(caller, fields);
            default:
                throw new RpcError(-32601, `no method ${method}`);
        }
    }
    /** `tools/call`: arguments the tool cannot take come back as an error result, not a protocol error. */
    private callTool(caller: string, fields: Record<string, unknown>): Promise<ToolResult> {
        return this.tool(caller, String(fields['name'] ?? ''), isObject(fields['arguments']) ? fields['arguments'] : {})
            .catch((error: unknown) => {
                if (error instanceof ArgumentError) {
                    return failure(error.message);
                }
                throw error;
            });
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
            case 'reply':
                return this.reply(fleet, caller, args);
            case 'forward':
                return this.forward(fleet, caller, args);
            default:
                return this.taskTool(fleet, caller, name, args);
        }
    }
    /** The tools of tasks one agent gives another; any other is a memory tool, one of an administrator, or none. */
    private taskTool(fleet: FleetDirectory, caller: string, name: string, args: ToolArguments): Promise<ToolResult> {
        switch (name) {
            case 'delegate':
                return this.delegate(fleet, caller, args);
            case 'cancel_delegation':
                return this.cancelDelegation(fleet, caller, stringArgument(args, 'id'));
            default:
                return isMemoryTool(name) ? this.memoryTool(caller, name, args) : this.adminTool(fleet, caller, name, args);
        }
    }
    /** The tools the caller is listed: the memory tools with a memory bank, those of an administrator to one. */
    private toolsOf(caller: string): readonly object[] {
        return [
            ...TOOLS,
            ...(this.memoryBank(caller) === undefined ? [] : MEMORY_TOOLS),
            ...(this.isAdmin(caller) ? ADMIN_TOOLS : [])
        ];
    }
    /** A memory tool, on the caller's own bank; refused to an agent whose memory flotti does not keep. */
    private memoryTool(caller: string, name: string, args: ToolArguments): Promise<ToolResult> {
        const bank = this.memoryBank(caller);
        return bank === undefined
            ? Promise.resolve(failure('memory is not supported for you: flotti keeps no memory bank for an agent on '
                + 'another host or a remote one. Nothing was stored.'))
            : callMemoryTool(bank, name, args);
    }
    /** The memory bank of the caller, when it gets the memory tools. */
    private memoryBank(caller: string): string | undefined {
        return this.fleet?.memoryBank?.(caller);
    }
    /** Whether the caller is an administrator of the fleet: it is then listed the tools of one. */
    private isAdmin(caller: string): boolean {
        return this.fleet?.agents().find((agent) => agent.id === caller)?.admin === true;
    }
    /** `restart_agent` and `clear_context`: whether the caller may is for the fleet to say. */
    private async adminTool(fleet: FleetDirectory, caller: string, name: string, args: ToolArguments): Promise<ToolResult> {
        const action = Object.hasOwn(ADMIN_ACTIONS, name) ? ADMIN_ACTIONS[name] : undefined;
        if (action === undefined) {
            throw new RpcError(-32602, `no tool ${name}`);
        }
        if (fleet.administer === undefined) {
            return failure('the tools of administrators are not available in this fleet');
        }
        const outcome = await fleet.administer(caller, action, stringArgument(args, 'id'));
        return outcome.ok ? text(outcome.text) : failure(outcome.text);
    }
    /** The `reply` tool: to the agent whose message came last, quoting it — as a reply of a person does. */
    private async reply(fleet: FleetDirectory, caller: string, args: ToolArguments): Promise<ToolResult> {
        const last = this.received.get(caller);
        if (last === undefined) {
            return failure('no agent has written to you yet; use send_message and name the agent');
        }
        const quoted = last.text.trim() === '' && last.forwarded !== undefined ? last.forwarded.text : last.text;
        return this.send(fleet, caller, last.from, stringArgument(args, 'text'), {
            replyTo: { agentId: caller, messageId: last.messageId, author: last.from, text: quoted }
        });
    }
    /**
     * The `forward` tool: the last message, as it was, with a comment above it
     * if one is given. A forward forwarded again names who wrote it first.
     */
    private async forward(fleet: FleetDirectory, caller: string, args: ToolArguments): Promise<ToolResult> {
        const last = this.received.get(caller);
        if (last === undefined) {
            return failure('no agent has written to you yet: there is nothing to forward');
        }
        const comment = typeof args['comment'] === 'string' ? args['comment'].trim() : '';
        const forwarded = last.text.trim() === '' && last.forwarded !== undefined
            ? last.forwarded
            : { author: last.from, text: last.text };
        return this.send(fleet, caller, stringArgument(args, 'to'), comment, { forwarded });
    }
    /** The `delegate` tool: the id of the task, or why it failed at once. */
    private async delegate(fleet: FleetDirectory, caller: string, args: ToolArguments): Promise<ToolResult> {
        const to = stringArgument(args, 'to');
        const task = stringArgument(args, 'text');
        const minutes = args['deadline_minutes'];
        if (minutes !== undefined && (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0)) {
            throw new ArgumentError('deadline_minutes must be a number of minutes above zero');
        }
        const deadline = minutes === undefined ? undefined : new Date(Date.now() + minutes * 60_000).toISOString();
        const { delegation, queued } = await fleet.delegate(caller, to, task, deadline);
        const id = delegation.delegationId;
        if (delegation.state === 'failed') {
            return failure(`Task ${id} failed at once: ${delegation.result ?? 'no reason given'}`);
        }
        const due = deadline === undefined ? '' : ` It is due by ${deadline}.`;
        return text(`Task ${id} is with "${to}"${queued ? ', waiting in line until it is done with what it is doing' : ''}.${due} `
            + `Its outcome comes to you as a message from "${to}"; cancel_delegation takes it back.`);
    }
    /** The `cancel_delegation` tool. */
    private cancelDelegation(fleet: FleetDirectory, caller: string, id: string): Promise<ToolResult> {
        try {
            const { delegation, canceled } = fleet.cancelDelegation(caller, id);
            return Promise.resolve(canceled
                ? text(`Task ${id} is canceled; "${delegation.to}" was told to stop.`)
                : text(`Task ${id} was over already: ${delegation.state}.`));
        } catch (error) {
            return Promise.resolve(failure(error instanceof Error ? error.message : String(error)));
        }
    }
    private async send(fleet: FleetDirectory, from: string, to: string, message: string, extras: Extras = {}): Promise<ToolResult> {
        if (to === from) {
            return failure('that is you: name another agent');
        }
        if (!fleet.agents().some((agent) => agent.id === to)) {
            return failure(`there is no agent "${to}" in the fleet; list_agents names them`);
        }
        const messageId = randomUUID();
        const delivery = await deliver(fleet, to, message, { from, messageId, ...extras });
        if (delivery.result === 'failed') {
            return failure(`"${to}" did not get it: ${delivery.error ?? 'no reason given'}`);
        }
        this.delivered({ to, from, messageId, text: message, ...(extras.forwarded === undefined ? {} : { forwarded: extras.forwarded }) });
        return text(delivery.result === 'taken'
            ? `"${to}" has it. Its answer comes to you as a message from "${to}".`
            : `"${to}" is busy: the message waits in line and reaches it once it is done.`);
    }
}
/** Sends through the fleet; a send that throws is a failed delivery. */
async function deliver(fleet: FleetDirectory, to: string, message: string, options: SendOptions): Promise<Delivery> {
    try {
        return await fleet.send(to, message, options);
    } catch (error) {
        // The fleet changed under the call: the sender or the receiver is gone.
        return { agentId: to, result: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
}
/** The answer to `initialize`: the protocol version, the capabilities, who the caller is and whether it administers. */
function initializeResult(caller: string, fields: Record<string, unknown>, admin: boolean, memory: boolean): object {
    return {
        protocolVersion: PROTOCOL_VERSIONS.find((known) => known === fields['protocolVersion'])
            ?? PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: '1' },
        instructions: `You are "${caller}", one agent of a flotti fleet. These tools let you see the other `
            + 'agents and write to them' + (memory ? ', and keep your own memory across conversations with the memory_* tools.' : '.')
            + (admin ? ' You are an administrator of the fleet: you may also restart agents and clear their context.' : '')
    };
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
export type { DeliveredMessage, FleetDirectory, FleetToolsAccess };
