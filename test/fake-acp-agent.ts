/**
 * A pretend ACP agent the tests start as a real child process. What it does is
 * set by the JSON in FAKE_ACP; what it was asked is appended to the record file,
 * one JSON object a line, so a test can check it.
 *
 * Messages it understands:
 * - `crash`           — exits with code 3 in the middle of the message;
 * - `freeze`          — stops answering anything, the event loop blocked;
 * - `wait`            — works until cancelled, then ends with `cancelled`;
 * - `deaf`            — ignores cancel and never ends;
 * - `permission`      — asks for a permission and says which option came back;
 * - `spawn`           — starts a grandchild process and writes its pid to the record;
 * - `later`           — answers, and a moment after the turn is over goes on of its own:
 *                       a tool call and a message without `messageId`;
 * - `mcp <call>`      — calls a tool of the MCP server `flotti` it was given, `<call>` being the
 *                       JSON of `tools/call` params, and says the text of the result;
 * - anything else     — answers "you said: <message>" with a tool call on the way.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
type FakeConfig = {
    /** Where to write what the agent was asked. */
    readonly record: string;
    /** Exit with code 2 right at the start this many times; the count lives in `counter`. */
    readonly crashStarts?: number;
    readonly counter?: string;
    readonly resume?: boolean;
    readonly load?: boolean;
    readonly additionalDirectories?: boolean;
    /** Offer a model option with these values. */
    readonly models?: readonly string[];
    /** Answer session/new with `auth_required`. */
    readonly authRequired?: boolean;
    /** Say it takes MCP servers over HTTP. */
    readonly mcpHttp?: boolean;
};
const config = JSON.parse(process.env['FAKE_ACP'] ?? '{}') as FakeConfig;
function record(entry: object): void {
    appendFileSync(config.record, `${JSON.stringify(entry)}\n`);
}
if (config.crashStarts !== undefined && config.counter !== undefined) {
    const count = existsSync(config.counter) ? Number(readFileSync(config.counter, 'utf8')) : 0;
    writeFileSync(config.counter, String(count + 1));
    if (count < config.crashStarts) {
        process.stderr.write(`fake agent: crashing on start ${count + 1}\n`);
        process.exit(2);
    }
}
record({
    event: 'started',
    pid: process.pid,
    ppid: process.ppid,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    codexConfig: process.env['CODEX_CONFIG'] ?? null
});
process.stderr.write('fake agent: ready\n');
let sessionCount = 0;
/** The MCP server over HTTP the last session was given. */
let mcpServer: { url: string; headers: { name: string; value: string }[] } | undefined;
function keepMcp(servers: readonly acp.McpServer[] | undefined): void {
    const http = servers?.find((server) => 'type' in server && server.type === 'http');
    if (http !== undefined && 'url' in http && 'headers' in http) {
        mcpServer = { url: http.url, headers: [...http.headers] };
    }
}
/** One `tools/call` to the MCP server: the text of its result, or why there is none. */
async function callTool(params: string): Promise<string> {
    if (mcpServer === undefined) {
        return 'no MCP server';
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    for (const header of mcpServer.headers) {
        headers[header.name] = header.value;
    }
    const response = await fetch(mcpServer.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: JSON.parse(params) as unknown })
    });
    const body = await response.json() as { result?: { content: { text: string }[]; isError?: boolean } };
    const result = body.result;
    return result === undefined ? `HTTP ${response.status}` : `${result.isError === true ? 'error: ' : ''}${result.content[0]?.text ?? ''}`;
}
const cancels = new Map<string, () => void>();
function modelOptions(current: string | undefined): acp.SessionConfigOption[] {
    if (config.models === undefined) {
        return [];
    }
    return [{
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: current ?? config.models[0] ?? '',
        options: config.models.map((value: string) => ({ value, name: value }))
    }];
}
/** Asks for a permission and says what the person picked; returns the stop reason. */
async function askPermission(client: acp.AgentContext, sessionId: string): Promise<'cancelled' | 'end_turn'> {
    const answer = await client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: 'call-1', title: 'Delete everything' },
        options: [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' }
        ]
    });
    const outcome = answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'cancelled';
    await say(client, sessionId, `permission: ${outcome}`);
    return outcome === 'cancelled' ? 'cancelled' : 'end_turn';
}
/** An ordinary answer: a tool call, a plan, and the message said back. */
async function answer(client: acp.AgentContext, sessionId: string, text: string): Promise<void> {
    await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Think', status: 'in_progress' }
    });
    await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' }
    });
    await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'plan', entries: [] }
    });
    await say(client, sessionId, `you said: ${text}`);
}
async function say(client: acp.AgentContext, sessionId: string, text: string): Promise<void> {
    await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId: 'm1' }
    });
}
/** What an agent does with no prompt to answer: works on, and says so. */
async function onMyOwn(client: acp.AgentContext, sessionId: string): Promise<void> {
    await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: 'call-2', title: 'Check CI', status: 'completed' }
    });
    await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CI is green' } }
    });
}
acp.agent({ name: 'fake-acp-agent' })
    .onRequest(acp.methods.agent.initialize, (context) => {
        record({ event: 'initialize', params: context.params });
        return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {
                loadSession: config.load === true,
                ...(config.mcpHttp === true ? { mcpCapabilities: { http: true } } : {}),
                sessionCapabilities: {
                    ...(config.resume === true ? { resume: {} } : {}),
                    ...(config.additionalDirectories === true ? { additionalDirectories: {} } : {})
                }
            },
            authMethods: []
        };
    })
    .onRequest(acp.methods.agent.session.new, (context) => {
        record({ event: 'session/new', params: context.params });
        keepMcp(context.params.mcpServers);
        if (config.authRequired === true) {
            throw acp.RequestError.authRequired();
        }
        return { sessionId: `session-${process.pid}-${++sessionCount}`, configOptions: modelOptions(undefined) };
    })
    .onRequest(acp.methods.agent.session.resume, (context) => {
        record({ event: 'session/resume', params: context.params });
        keepMcp(context.params.mcpServers);
        return { configOptions: modelOptions(undefined) };
    })
    .onRequest(acp.methods.agent.session.load, async (context) => {
        record({ event: 'session/load', params: context.params });
        await say(context.client, context.params.sessionId, 'an old answer, replayed');
        return { configOptions: modelOptions(undefined) };
    })
    .onRequest(acp.methods.agent.session.setConfigOption, (context) => {
        record({ event: 'session/set_config_option', params: context.params });
        const value = 'value' in context.params ? String(context.params.value) : '';
        if (!config.models?.includes(value)) {
            throw acp.RequestError.invalidParams(undefined, `no model ${value}`);
        }
        return { configOptions: modelOptions(value) };
    })
    .onNotification(acp.methods.agent.session.cancel, (context) => {
        record({ event: 'session/cancel', params: context.params });
        cancels.get(context.params.sessionId)?.();
    })
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
        const { sessionId } = context.params;
        const first = context.params.prompt[0];
        const text = first?.type === 'text' ? first.text : '';
        record({ event: 'session/prompt', text });
        switch (text) {
            case 'crash':
                await say(context.client, sessionId, 'about to crash');
                process.exit(3);
                break;
            case 'freeze': {
                const until = Date.now() + 60_000;
                while (Date.now() < until) {
                    // Blocked on purpose: no heartbeat answers.
                }
                break;
            }
            case 'wait':
                await new Promise<void>((resolve) => cancels.set(sessionId, resolve));
                return { stopReason: 'cancelled' };
            case 'deaf':
                await new Promise<void>(() => undefined);
                break;
            case 'permission':
                return { stopReason: await askPermission(context.client, sessionId) };
            case 'spawn': {
                const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
                record({ event: 'grandchild', pid: grandchild.pid });
                await say(context.client, sessionId, 'spawned');
                break;
            }
            case 'later':
                await say(context.client, sessionId, 'on it');
                setTimeout(() => void onMyOwn(context.client, sessionId), 50);
                break;
            default:
                if (text.startsWith('mcp ')) {
                    await say(context.client, sessionId, `mcp: ${await callTool(text.slice(4))}`);
                    break;
                }
                await answer(context.client, sessionId, text);
        }
        return { stopReason: 'end_turn' };
    })
    .connect(acp.ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
    ));
