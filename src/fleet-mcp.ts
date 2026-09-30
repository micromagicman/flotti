import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AdminAction, Delegation, Forwarded, SendOptions } from './agent-events.js';
import type { AgentSummary, Delivery } from './dashboard-protocol.js';
import type { DelegationCancel, DelegationStart } from './delegations.js';
import type { GroupSendOptions } from './supervisor.js';
import { describeError } from './describe-error.js';
import type { AdminOutcome } from './fleet-admin.js';
import { TO_IS_GONE, noSuchGroup } from './groups.js';
import type { GroupView, PeerSummary } from './groups.js';
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
    /**
     * The agents this one sees (docs/groups.md): the members of every group it
     * is in, and itself; none when it is in no group with anyone.
     */
    peers(agentId: string): PeerSummary[];
    /** The groups the agent is in, as it sees them. */
    groupsOf(agentId: string): GroupView[];
    /** Whether `from` may post to the group — it is a member; the tab of `from` says why not. */
    mayPost(from: string, groupId: string): boolean;
    /** Posts a message to a group on behalf of an agent of the fleet: `from` is its id; how each other member took it. */
    sendToGroup(groupId: string, text: string, options?: GroupSendOptions): Promise<{ readonly deliveries: readonly Delivery[] }>;
    /**
     * Gives a task on behalf of an agent of the fleet to a member of a group
     * (0.7.0, #171): `from` is its id; `deadline` an ISO 8601 time.
     */
    delegate(from: string, group: string, to: string, text: string, deadline?: string): Promise<DelegationStart>;
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
/** A JSON-RPC method the server answers: its result for the caller. */
type Method = (caller: string, fields: Record<string, unknown>) => object | Promise<object>;
/** A tool of the fleet: its result for the caller. */
type Tool = (fleet: FleetDirectory, caller: string, args: ToolArguments) => Promise<ToolResult>;
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
    /** Id of the group it was posted to, when it came through one: a reply goes back there. */
    readonly group?: string;
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
/** What one call of a tool sends, besides the group and the text. */
type Extras = Pick<SendOptions, 'replyTo' | 'forwarded'>;
/**
 * The one address of a message between agents (0.7.0, #171): a group the
 * caller is in. `to` is gone from the tools; a call that names it is refused
 * with the sentence that names the way.
 */
const GROUP_PROPERTY = {
    group: {
        type: 'string',
        description: 'Id of a group you are in, as list_groups gives it: every other member gets it. To address one '
            + 'member, write @<id> in the text.'
    }
} as const;
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
        description: 'Lists the agents of your flotti fleet you can write to — those in a group with you: id, name, '
            + 'what they are for, what they are doing now, and "groups" — the groups you share. Your own entry is '
            + 'marked "you", administrators of the fleet "admin".',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'list_groups',
        description: 'Lists the groups you are in: id, name, topic — what the group is for — and members, by id and '
            + 'name. A person puts agents in groups; you cannot join or leave one.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'send_message',
        description: 'Sends a message to every other member of a group you are in ("group"): agents talk inside '
            + 'groups only. To address one member, write @<id> in the text; every member still gets it. It arrives '
            + 'as a message from you, and what the members answer is posted to the group and comes back to you as '
            + 'messages from them. A group message sent to you is answered the same way: just answer it, no tool '
            + 'needed. Do not answer acknowledgements: a thank-you needs no thank-you back.',
        inputSchema: {
            type: 'object',
            properties: {
                ...GROUP_PROPERTY,
                text: { type: 'string', description: 'The message.' }
            },
            required: ['group', 'text'],
            additionalProperties: false
        }
    },
    {
        name: 'reply',
        description: 'Writes again in the group the last group message to you came from, quoting that message. Your '
            + 'answer in the turn of the message already reaches the group: this is for writing later.',
        inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'The answer.' } },
            required: ['text'],
            additionalProperties: false
        }
    },
    {
        name: 'delegate',
        description: 'Gives a member of a group you are in a task and returns its id at once. The task is posted to '
            + 'the group, mentioning the agent; the agent works on it in a turn of its own, and when it is done the '
            + 'outcome is posted to the group and comes to you as a message from it: completed with what it '
            + 'answered, failed or canceled with why. A task that cannot be given — no such member, the agent is '
            + 'stopped — fails at once. Use it for work you want done and reported back; send_message is for a word. '
            + 'A task goes to one member of the group, never to the whole group.',
        inputSchema: {
            type: 'object',
            properties: {
                group: { type: 'string', description: 'Id of a group you and the agent are in, as list_groups gives it.' },
                to: { type: 'string', description: 'Id of the member that does the task, as list_groups gives it.' },
                text: { type: 'string', description: 'The task: what to do, and what to answer when done.' },
                deadline_minutes: {
                    type: 'number',
                    description: 'Optional: minutes the task may take. A task not done by then fails, and the agent stops working on it.'
                }
            },
            required: ['group', 'to', 'text'],
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
        description: 'Forwards the last message another agent sent you, as it was, to a group you are in ("group").',
        inputSchema: {
            type: 'object',
            properties: {
                ...GROUP_PROPERTY,
                comment: { type: 'string', description: 'A few words of your own to put before it; optional.' }
            },
            required: ['group'],
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
    /** The last message each agent got through a group: what `reply` answers. */
    private readonly receivedInGroup = new Map<string, Received & { readonly group: string }>();
    private fleet: FleetDirectory | undefined;
    /** The JSON-RPC methods, by name. */
    private readonly methods: ReadonlyMap<string, Method> = new Map<string, Method>([
        ['initialize', (caller, fields) => initializeResult(caller, fields, this.isAdmin(caller), this.memoryBank(caller) !== undefined)],
        ['ping', () => ({})],
        ['tools/list', (caller) => ({ tools: this.toolsOf(caller) })],
        ['tools/call', (caller, fields) => this.callTool(caller, fields)]
    ]);
    /** The tools every agent is listed, by name; the memory tools and those of an administrator are apart. */
    private readonly tools: ReadonlyMap<string, Tool> = new Map<string, Tool>([
        ['list_agents', (fleet, caller) => Promise.resolve(listAgents(fleet, caller))],
        ['list_groups', (fleet, caller) => Promise.resolve(listGroups(fleet, caller))],
        ['send_message', (fleet, caller, args) => this.post(fleet, caller, groupOf(args), stringArgument(args, 'text'))],
        ['reply', (fleet, caller, args) => this.reply(fleet, caller, args)],
        ['forward', (fleet, caller, args) => this.forward(fleet, caller, args)],
        ['delegate', (fleet, caller, args) => this.delegate(fleet, caller, args)],
        ['cancel_delegation', (fleet, caller, args) => this.cancelDelegation(fleet, caller, stringArgument(args, 'id'))]
    ]);
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
        if (received.group !== undefined) {
            this.receivedInGroup.set(to, { ...received, group: received.group });
        }
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
        if (pathOf(request) !== MCP_PATH) {
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
        if (!isRequest(message)) {
            return notARequest(message);
        }
        return message.id === undefined ? undefined : this.result(caller, message.id, message.method, message.params);
    }
    /** The response to a request: its result, or the error it ended with. */
    private async result(caller: string, id: string | number | null, method: string, params: unknown): Promise<object> {
        try {
            return { jsonrpc: '2.0', id, result: await this.call(caller, method, params) };
        } catch (error) {
            return rpcError(id, rpcCode(error), describeError(error));
        }
    }
    private async call(caller: string, method: string, params: unknown): Promise<object> {
        const answer = this.methods.get(method);
        if (answer === undefined) {
            throw new RpcError(-32601, `no method ${method}`);
        }
        return answer(caller, isObject(params) ? params : {});
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
    /** A tool by its name; any other than those of every agent is a memory tool, one of an administrator, or none. */
    private async tool(caller: string, name: string, args: ToolArguments): Promise<ToolResult> {
        const fleet = this.fleet;
        if (fleet === undefined) {
            return failure('the fleet is not up yet; try again in a moment');
        }
        const tool = this.tools.get(name);
        if (tool !== undefined) {
            return tool(fleet, caller, args);
        }
        return isMemoryTool(name) ? this.memoryTool(caller, name, args) : this.adminTool(fleet, caller, name, args);
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
        const action = adminAction(name);
        if (action === undefined) {
            throw new RpcError(-32602, `no tool ${name}`);
        }
        if (fleet.administer === undefined) {
            return failure('the tools of administrators are not available in this fleet');
        }
        const outcome = await fleet.administer(caller, action, stringArgument(args, 'id'));
        return outcome.ok ? text(outcome.text) : failure(outcome.text);
    }
    /**
     * The `reply` tool: in the group the last group message came from, quoting
     * it, as a reply of a person does. Agents talk inside groups (0.7.0, #171):
     * a message that came some other way — the outcome of a task, an answer of
     * 0.6.x — is not answered with it.
     */
    private async reply(fleet: FleetDirectory, caller: string, args: ToolArguments): Promise<ToolResult> {
        if (args['to'] !== undefined) {
            return failure(TO_IS_GONE);
        }
        const last = this.receivedInGroup.get(caller);
        if (last === undefined) {
            return failure('no message has come to you through a group yet: there is nothing to reply to; use send_message and name the group in "group"');
        }
        return this.post(fleet, caller, last.group, stringArgument(args, 'text'), {
            replyTo: { agentId: caller, messageId: last.messageId, author: last.from, text: original(last).text }
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
        const group = groupOf(args);
        const comment = optionalText(args, 'comment');
        return this.post(fleet, caller, group, comment, { forwarded: original(last) });
    }
    /** The `delegate` tool: the id of the task, or why it failed at once. A task names the group and its one doer. */
    private async delegate(fleet: FleetDirectory, caller: string, args: ToolArguments): Promise<ToolResult> {
        const group = stringArgument(args, 'group');
        if (optionalText(args, 'to') === '') {
            throw new ArgumentError('a task names one doer: name the member of the group that does it in "to"');
        }
        const to = stringArgument(args, 'to');
        const task = stringArgument(args, 'text');
        const deadline = deadlineOf(args['deadline_minutes']);
        const start = await fleet.delegate(caller, group, to, task, deadline);
        return start.delegation.state === 'failed' ? failedAtOnce(start.delegation) : delegated(to, group, start, deadline);
    }
    /** The `cancel_delegation` tool. */
    private cancelDelegation(fleet: FleetDirectory, caller: string, id: string): Promise<ToolResult> {
        try {
            const { delegation, canceled } = fleet.cancelDelegation(caller, id);
            return Promise.resolve(canceled
                ? text(`Task ${id} is canceled; "${delegation.to}" was told to stop.`)
                : text(`Task ${id} was over already: ${delegation.state}.`));
        } catch (error) {
            return Promise.resolve(failure(describeError(error)));
        }
    }
    /**
     * A message to a group the caller is in: every other member gets it, and
     * the result says how each took it. The supervisor tells `delivered` of
     * each member that took it, so their `reply` answers the group.
     */
    private async post(fleet: FleetDirectory, from: string, groupId: string, message: string, extras: Extras = {}): Promise<ToolResult> {
        if (!fleet.mayPost(from, groupId)) {
            return failure(noSuchGroup(groupId));
        }
        try {
            const { deliveries } = await fleet.sendToGroup(groupId, message, { from, ...extras });
            return text(posted(groupId, deliveries));
        } catch (error) {
            // The fleet changed under the call: the group or the sender is gone.
            return failure(`the message was not posted to group "${groupId}": ${describeError(error)}`);
        }
    }
}
/**
 * The group a message of a tool goes to (0.7.0, #171). A call that names `to`
 * is refused before anything else is asked: agents talk inside groups.
 */
function groupOf(args: ToolArguments): string {
    if (args['to'] !== undefined) {
        throw new ArgumentError(TO_IS_GONE);
    }
    if (optionalText(args, 'group') === '') {
        throw new ArgumentError('"group" is missing: name a group you are in, as list_groups gives it');
    }
    return optionalText(args, 'group');
}
/** The result of a message posted to a group: how each other member took it. */
function posted(groupId: string, deliveries: readonly Delivery[]): string {
    if (deliveries.length === 0) {
        return `Posted to group "${groupId}"; nobody else is in it yet.`;
    }
    return `Posted to group "${groupId}": ${deliveries.map(took).join('; ')}. What the members answer comes to you as messages from them.`;
}
/** How one member took a message of the group, in a few words. */
function took(delivery: Delivery): string {
    switch (delivery.result) {
        case 'taken':
            return `"${delivery.agentId}" has it`;
        case 'queued':
            return `"${delivery.agentId}" is busy, it waits in line`;
        default:
            return `"${delivery.agentId}" did not get it: ${delivery.error ?? 'no reason given'}`;
    }
}
/** What `list_agents` says to an agent in no group with anyone: the fleet is not empty, it is out of sight. */
const NO_PEERS = 'You are not in a group with anyone yet, so there is no agent you can write to: a person puts '
    + 'agents in groups in the settings of flotti.';
/** The `list_agents` tool: the agents the caller sees, with its own entry marked. */
function listAgents(fleet: FleetDirectory, caller: string): ToolResult {
    const peers = fleet.peers(caller);
    const listed = JSON.stringify(peers.map((agent) => agent.id === caller ? { ...agent, you: true } : agent), null, 2);
    return text(peers.length === 0 ? `${listed}\n${NO_PEERS}` : listed);
}
/** The `list_groups` tool: the groups the caller is in. */
function listGroups(fleet: FleetDirectory, caller: string): ToolResult {
    const groups = fleet.groupsOf(caller);
    const listed = JSON.stringify(groups, null, 2);
    return text(groups.length === 0 ? `${listed}\nYou are in no group yet: a person puts agents in groups in the settings of flotti.` : listed);
}
/**
 * The message a reply quotes and a forward carries: the one forwarded to the
 * caller when the last message is a bare forward, the last message itself otherwise.
 */
function original(last: Received): Forwarded {
    return last.text.trim() === '' && last.forwarded !== undefined ? last.forwarded : { author: last.from, text: last.text };
}
/** What each tool of an administrator does; nothing for any other name. */
function adminAction(name: string): AdminAction | undefined {
    return Object.hasOwn(ADMIN_ACTIONS, name) ? ADMIN_ACTIONS[name] : undefined;
}
/** The deadline of a task given `deadline_minutes`, as an ISO 8601 time; nothing without one. */
function deadlineOf(minutes: unknown): string | undefined {
    if (minutes === undefined) {
        return undefined;
    }
    if (!isPositiveNumber(minutes)) {
        throw new ArgumentError('deadline_minutes must be a number of minutes above zero');
    }
    return new Date(Date.now() + minutes * 60_000).toISOString();
}
function isPositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
/** The result of a task that failed at once: why. */
function failedAtOnce(delegation: Delegation): ToolResult {
    return failure(`Task ${delegation.delegationId} failed at once: ${delegation.result ?? 'no reason given'}`);
}
/** The result of a task given: who has it, whether it waits in line, and when it is due. */
function delegated(to: string, group: string, { delegation, queued }: DelegationStart, deadline: string | undefined): ToolResult {
    const line = queued ? ', waiting in line until it is done with what it is doing' : '';
    const due = deadline === undefined ? '' : ` It is due by ${deadline}.`;
    return text(`Task ${delegation.delegationId} is with "${to}" in group "${group}"${line}.${due} `
        + `Its outcome is posted to the group and comes to you as a message from "${to}"; cancel_delegation takes it back.`);
}
/** The answer to `initialize`: the protocol version, the capabilities, who the caller is and whether it administers. */
function initializeResult(caller: string, fields: Record<string, unknown>, admin: boolean, memory: boolean): object {
    return {
        protocolVersion: PROTOCOL_VERSIONS.find((known) => known === fields['protocolVersion'])
            ?? PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: '1' },
        instructions: `You are "${caller}", one agent of a flotti fleet. These tools let you see the agents in a `
            + 'group with you and write to them inside those groups — to one member with @<id> in the text' + (memory ? ', and keep your own memory across conversations with the memory_* tools.' : '.')
            + (admin ? ' You are an administrator of the fleet: you may also restart agents and clear their context.' : '')
    };
}
/** A request the server answers: an object with a method. */
function isRequest(message: JsonRpcRequest): message is JsonRpcRequest & { readonly method: string } {
    return typeof message === 'object' && message !== null && typeof message.method === 'string';
}
/** The answer to a message that is not a request: an error when it has an id, nothing otherwise. */
function notARequest(message: JsonRpcRequest | null): object | undefined {
    return message?.id === undefined ? undefined : rpcError(message.id, -32600, 'not a JSON-RPC request');
}
function rpcCode(error: unknown): number {
    return error instanceof RpcError ? error.code : -32603;
}
/** The path a request asks for. */
function pathOf(request: IncomingMessage): string {
    return new URL(request.url ?? '/', 'http://localhost').pathname;
}
/** An optional text argument, trimmed; empty when it is not text. */
function optionalText(args: ToolArguments, name: string): string {
    const value = args[name];
    return typeof value === 'string' ? value.trim() : '';
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
