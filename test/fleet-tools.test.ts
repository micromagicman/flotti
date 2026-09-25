import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { composeText } from '../src/agent-events.js';
import type { AgentEvent, SendOptions } from '../src/agent-events.js';
import type { AgentSummary, Delivery } from '../src/dashboard-protocol.js';
import { FleetMcpServer } from '../src/fleet-mcp.js';
import type { FleetDirectory } from '../src/fleet-mcp.js';
import { RemoteStartReader, remoteCommandArguments } from '../src/ssh.js';
import type { SshOptions } from '../src/ssh.js';
import { Supervisor } from '../src/supervisor.js';
import type { LocalAgent } from '../src/types.js';
import { fakeFleet } from './fake-fleet-agent.js';
import type { FakeFleetAgent } from './fake-fleet-agent.js';
import { rejected, single } from './fleet-helpers.js';
import { Harness, eventually, workspace } from './local-agent-helpers.js';
const FAKE_SSH = fileURLToPath(new URL('./fake-ssh.js', import.meta.url));
const servers: FleetMcpServer[] = [];
after(async () => {
    await Promise.all(servers.map((server) => server.close()));
});
async function toolsServer(): Promise<FleetMcpServer> {
    const server = await FleetMcpServer.start();
    servers.push(server);
    return server;
}
/** A fleet the tools give no task to. */
const noDelegations: Pick<FleetDirectory, 'delegate' | 'cancelDelegation'> = {
    delegate: () => Promise.reject(new Error('no tasks here')),
    cancelDelegation: () => {
        throw new Error('no tasks here');
    }
};
/** The fleet, as the tools see it; `sent` is what each receiver reads, `options` what came with it. */
function directory(ids: readonly string[]): FleetDirectory & { sent: string[]; options: SendOptions[] } {
    const sent: string[] = [];
    const options: SendOptions[] = [];
    return {
        sent,
        options,
        agents: (): AgentSummary[] => ids.map((id) => ({ id, name: id, kind: 'local', status: 'idle' })),
        send: async (agentId: string, text: string, given: SendOptions = {}): Promise<Delivery> => {
            sent.push(`${given.from ?? '-'} -> ${agentId}: ${composeText(text, given, agentId)}`);
            options.push(given);
            return { agentId, result: 'taken' };
        },
        ...noDelegations
    };
}
/** One JSON-RPC request to the tools, as an agent makes it. */
async function rpc(server: FleetMcpServer, token: string | undefined, method: string, params: object = {}) {
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...(token === undefined ? {} : { Authorization: `Bearer ${token}` })
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params })
    });
    return { status: response.status, body: await response.json().catch(() => undefined) as Record<string, unknown> | undefined };
}
async function callTool(server: FleetMcpServer, token: string, name: string, args: object): Promise<{ text: string; isError: boolean }> {
    const { body } = await rpc(server, token, 'tools/call', { name, arguments: args });
    const result = body?.['result'] as { content: { text: string }[]; isError?: boolean };
    return { text: result.content[0]?.text ?? '', isError: result.isError === true };
}
describe('fleet tools: the MCP server', () => {
    it('answers an agent of the fleet only, by its token', async () => {
        const server = await toolsServer();
        server.serve(directory(['alice', 'bob']));
        const { token } = server.access('alice');
        strictEqual(server.access('alice').token, token, 'one token per agent for the whole run');
        notStrictEqual(server.access('bob').token, token);
        strictEqual((await rpc(server, undefined, 'tools/list')).status, 401);
        strictEqual((await rpc(server, 'not-a-token', 'tools/list')).status, 401);
        const init = await rpc(server, token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
        strictEqual(init.status, 200);
        const result = init.body?.['result'] as Record<string, unknown>;
        strictEqual(result['protocolVersion'], '2025-03-26');
        deepStrictEqual(result['capabilities'], { tools: {} });
        const tools = (await rpc(server, token, 'tools/list')).body?.['result'] as { tools: { name: string }[] };
        deepStrictEqual(tools.tools.map((tool) => tool.name), ['list_agents', 'send_message', 'reply', 'delegate', 'cancel_delegation', 'forward']);
    });
    it('takes notifications without an answer, and offers its own version to a client it does not know', async () => {
        const server = await toolsServer();
        const { token } = server.access('alice');
        const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
        });
        strictEqual(response.status, 202);
        const init = await rpc(server, token, 'initialize', { protocolVersion: '1999-01-01' });
        strictEqual((init.body?.['result'] as Record<string, unknown>)['protocolVersion'], '2025-06-18');
        strictEqual((await fetch(`http://127.0.0.1:${server.port}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
    });
});
describe('fleet tools: what they do', () => {
    it('lists the fleet and marks the caller', async () => {
        const server = await toolsServer();
        server.serve(directory(['alice', 'bob']));
        const listed = JSON.parse((await callTool(server, server.access('bob').token, 'list_agents', {})).text) as Record<string, unknown>[];
        deepStrictEqual(listed.map((agent) => [agent['id'], agent['you'] ?? false]), [['alice', false], ['bob', true]]);
    });
    it('says so when the fleet refuses the message', async () => {
        const server = await toolsServer();
        server.serve({
            agents: () => directory(['alice', 'bob']).agents(),
            send: () => {
                throw new Error('There is no agent "alice" in the fleet.');
            },
            ...noDelegations
        });
        const answer = await callTool(server, server.access('alice').token, 'send_message', { to: 'bob', text: 'hi' });
        ok(answer.isError);
        match(answer.text, /"bob" did not get it: There is no agent "alice"/);
    });
    it('says what is wrong as a tool error the agent can read', async () => {
        const server = await toolsServer();
        server.serve(directory(['alice', 'bob']));
        const alice = server.access('alice').token;
        match((await callTool(server, alice, 'send_message', { to: 'alice', text: 'hi' })).text, /that is you/);
        match((await callTool(server, alice, 'send_message', { to: 'nobody', text: 'hi' })).text, /no agent "nobody"/);
        match((await callTool(server, alice, 'send_message', { to: 'bob' })).text, /text is missing/);
        match((await callTool(server, alice, 'reply', { text: 'hi' })).text, /no agent has written to you yet/);
        ok((await callTool(server, alice, 'reply', { text: 'hi' })).isError);
    });
});
describe('fleet tools: replies and forwards', () => {
    it('sends on behalf of the caller, and replies and forwards what came last', async () => {
        const server = await toolsServer();
        const fleet = directory(['alice', 'bob', 'carol']);
        server.serve(fleet);
        const alice = server.access('alice').token;
        const bob = server.access('bob').token;
        const sent = await callTool(server, alice, 'send_message', { to: 'bob', text: 'review #7, please' });
        strictEqual(sent.isError, false);
        match(sent.text, /"bob" has it/);
        await callTool(server, bob, 'reply', { text: 'done, one remark' });
        await callTool(server, bob, 'forward', { to: 'carol', comment: 'FYI' });
        deepStrictEqual(fleet.sent, [
            'alice -> bob: review #7, please',
            'bob -> alice: In reply to a message from you:\n> review #7, please\n\ndone, one remark',
            'bob -> carol: FYI\n\nForwarded from agent "alice":\n\nreview #7, please'
        ]);
        // The same model as a reply and a forward of a person: the tab of each receiver shows the quote and the forward.
        const [first, reply, forward] = fleet.options;
        ok(first?.messageId !== undefined);
        deepStrictEqual(reply?.replyTo, { agentId: 'bob', messageId: first.messageId, author: 'alice', text: 'review #7, please' });
        deepStrictEqual(forward?.forwarded, { author: 'alice', text: 'review #7, please' });
    });
    it('forwards a forward as it was first written, naming who wrote it', async () => {
        const server = await toolsServer();
        const fleet = directory(['alice', 'bob', 'carol']);
        server.serve(fleet);
        await callTool(server, server.access('alice').token, 'send_message', { to: 'bob', text: 'the build is red' });
        await callTool(server, server.access('bob').token, 'forward', { to: 'carol' });
        await callTool(server, server.access('carol').token, 'forward', { to: 'alice' });
        deepStrictEqual(fleet.options.at(-1)?.forwarded, { author: 'alice', text: 'the build is red' });
        strictEqual(fleet.sent.at(-1), 'carol -> alice: Forwarded from you:\n\nthe build is red');
    });
});
/** A fleet of fakes run by a supervisor that hands the delivered messages to the tools. */
async function fleetWithTools(...ids: string[]) {
    const server = await toolsServer();
    const { fleet, fakes, createAgent } = fakeFleet(...ids);
    const supervisor = new Supervisor(fleet, { createAgent, fleetTools: server });
    server.serve(supervisor);
    await supervisor.start();
    const fake = (id: string): FakeFleetAgent => {
        const found = fakes.get(id);
        ok(found !== undefined);
        return found;
    };
    return { server, supervisor, fake };
}
/** The message the agent got from `from`, as its tab shows it. */
function received(agent: FakeFleetAgent, from: string): { messageId: string; text: string } {
    const index = agent.options.findIndex((options) => options.from === from);
    const call = agent.calls.filter((line) => line.startsWith('send '))[index];
    const options = agent.options[index];
    ok(call !== undefined && options !== undefined, `nothing from ${from}`);
    const text = call.slice('send '.length, call.length - ` from ${from}`.length);
    return { messageId: options.messageId ?? `u-${text}`, text };
}
describe('fleet tools: replies to what the supervisor delivers', () => {
    it('replies to a remote agent that wrote to the caller, quoting its message', async () => {
        const { server, supervisor, fake } = await fleetWithTools('alice', 'remote');
        const alice = fake('alice');
        const remote = fake('remote');
        alice.slow = true;
        remote.emit({ type: 'message', role: 'agent', messageId: 'r-1', text: 'is the release ready?', append: false, to: 'alice' });
        await eventually(() => alice.options.length > 0);
        const got = received(alice, 'remote');
        const answer = await callTool(server, server.access('alice').token, 'reply', { text: 'yes, tagged' });
        strictEqual(answer.isError, false, answer.text);
        const last = remote.options.at(-1);
        strictEqual(remote.calls.at(-1), 'send yes, tagged from alice');
        deepStrictEqual(last?.replyTo, { agentId: 'alice', messageId: got.messageId, author: 'remote', text: 'is the release ready?' });
        await supervisor.stop();
    });
    it('replies to the agent whose automatic answer came last', async () => {
        const { server, supervisor, fake } = await fleetWithTools('alice', 'bob', 'carol');
        const alice = fake('alice');
        const bob = fake('bob');
        const alicesToken = server.access('alice').token;
        // Carol writes through the tools first: without the answer of bob, `reply` would go to her.
        await callTool(server, server.access('carol').token, 'send_message', { to: 'alice', text: 'hello' });
        await callTool(server, alicesToken, 'send_message', { to: 'bob', text: 'review #7, please' });
        await eventually(() => alice.options.some((options) => options.from === 'bob'));
        const got = received(alice, 'bob');
        strictEqual(got.text, 'you said: review #7, please');
        const answer = await callTool(server, alicesToken, 'reply', { text: 'thanks' });
        strictEqual(answer.isError, false, answer.text);
        strictEqual(bob.calls.at(-1), 'send thanks from alice');
        deepStrictEqual(bob.options.at(-1)?.replyTo, { agentId: 'alice', messageId: got.messageId, author: 'bob', text: 'you said: review #7, please' });
        await supervisor.stop();
    });
});
describe('fleet tools: every ACP session gets them', { timeout: 20_000 }, () => {
    it('as an MCP server over HTTP with the agent\'s own token', async () => {
        const server = await toolsServer();
        const access = server.access('alice');
        const harness = new Harness({ fake: { mcpHttp: true }, manifest: { id: 'alice' }, options: { fleetTools: access } });
        await harness.agent.start();
        const [created] = harness.recorded('session/new');
        deepStrictEqual((created?.['params'] as Record<string, unknown>)['mcpServers'], [{
            type: 'http',
            name: 'flotti',
            url: `http://127.0.0.1:${access.port}/mcp`,
            headers: [{ name: 'Authorization', value: `Bearer ${access.token}` }]
        }]);
    });
    it('not when the agent takes no MCP over HTTP, and a line says so', async () => {
        const server = await toolsServer();
        const harness = new Harness({ options: { fleetTools: server.access('plain') }, manifest: { id: 'plain' } });
        await harness.agent.start();
        const [created] = harness.recorded('session/new');
        deepStrictEqual((created?.['params'] as Record<string, unknown>)['mcpServers'], []);
        ok(harness.events.some((event) => event.type === 'log' && /takes no MCP server over HTTP/.test(event.text)));
    });
});
describe('fleet tools: an agent writes to another', { timeout: 30_000 }, () => {
    it('and the message reaches it with its sender', async () => {
        const server = await toolsServer();
        const make = (id: string) => new Harness({ fake: { mcpHttp: true }, manifest: { id }, options: { fleetTools: server.access(id) } });
        const alice = make('alice');
        const bob = make('bob');
        const running = new Map([['alice', alice.agent], ['bob', bob.agent]]);
        const supervisor = new Supervisor(
            { location: { path: workspace, source: 'argument' }, exists: true, agents: [alice.agent.agent, bob.agent.agent] },
            { createAgent: (agent) => running.get(agent.id) ?? alice.agent }
        );
        server.serve(supervisor);
        await supervisor.start();
        await alice.talk('mcp {"name":"send_message","arguments":{"to":"bob","text":"ping from alice"}}');
        const received = await bob.next((event) => event.type === 'message' && event.role === 'user');
        deepStrictEqual(pick(received), { text: 'ping from alice', from: 'alice' });
        await eventually(() => bob.recorded('session/prompt').length > 0);
        strictEqual(bob.recorded('session/prompt')[0]?.['text'], '[from alice] ping from alice');
        ok(alice.events.some((event) => event.type === 'message' && event.role === 'agent' && /mcp: "bob" (has it|is busy)/.test(event.text)));
        await supervisor.stop();
    });
});
function pick(event: AgentEvent): unknown {
    return event.type === 'message' ? { text: event.text, from: event.from } : event;
}
/** A pretend host for an agent flotti starts over SSH. */
function sshHost(): { ssh: SshOptions; home: string } {
    const place = join(workspace, `ssh-host-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const home = join(place, 'home');
    mkdirSync(join(home, 'work'), { recursive: true });
    const config = join(place, 'ssh.json');
    writeFileSync(config, JSON.stringify({ home, pids: join(place, 'pids'), forwarded: join(place, 'forwarded') }));
    return { ssh: { command: process.execPath, prefix: [FAKE_SSH, config], readyTimeoutMs: 5_000 }, home: realpathSync(home) };
}
// The pretend host runs the command with `sh`, as a POSIX host does; a Windows runner has no such host.
describe('an agent started on another host over SSH', { timeout: 30_000, skip: process.platform === 'win32' && 'needs a POSIX sh' }, () => {
    it('runs there, in the home directory, with the manifest\'s environment only', async () => {
        const { ssh, home } = sshHost();
        const harness = new Harness({ remote: true, options: { ssh } });
        await harness.agent.start();
        const [started] = harness.recorded('started');
        strictEqual(realpathSync(String(started?.['cwd'])), home);
        const [created] = harness.recorded('session/new');
        strictEqual((created?.['params'] as Record<string, unknown>)['cwd'], home);
        strictEqual(await harness.talk('hello'), 'end_turn');
        ok(!harness.events.some((event) => event.type === 'log' && /flotti-cwd|Allocated port/.test(event.text)));
        await harness.agent.stop();
        strictEqual(harness.agent.state, 'stopped');
    });
    it('in the working directory the manifest names there', async () => {
        const { ssh, home } = sshHost();
        const harness = new Harness({ remote: true, manifest: { workdir: '~/work' }, options: { ssh } });
        await harness.agent.start();
        strictEqual((harness.recorded('session/new')[0]?.['params'] as Record<string, unknown>)['cwd'], join(home, 'work'));
    });
    it('reaches the fleet tools through the reverse tunnel', async () => {
        const { ssh } = sshHost();
        const server = await toolsServer();
        server.serve(directory(['remote-one', 'alice']));
        const access = server.access('remote-one');
        const harness = new Harness({ remote: true, fake: { mcpHttp: true }, manifest: { id: 'remote-one' }, options: { ssh, fleetTools: access } });
        await harness.agent.start();
        const params = harness.recorded('session/new')[0]?.['params'] as { mcpServers: { url: string }[] };
        const url = new URL(params.mcpServers[0]?.url ?? '');
        notStrictEqual(Number(url.port), access.port, 'the port the host gave the tunnel, not the one here');
        await harness.talk('mcp {"name":"list_agents","arguments":{}}');
        ok(harness.events.some((event) => event.type === 'message' && event.role === 'agent' && /"you": true/.test(event.text)));
    });
    it('is restarted like one here: the process there goes and comes back', async () => {
        const { ssh } = sshHost();
        const harness = new Harness({ remote: true, fake: { resume: true }, options: { ssh } });
        await harness.agent.start();
        await harness.agent.restart();
        strictEqual(harness.recorded('started').length, 2);
        strictEqual(harness.recorded('session/resume').length, 1);
    });
});
describe('ssh: the command that starts an agent on a host', () => {
    it('quotes everything for sh, and says where it runs before it starts', () => {
        const args = remoteCommandArguments({ destination: 'eva@example.org', host: 'example.org', port: 2222 }, {
            command: 'npx',
            arguments: ['-y', "it's"],
            env: { CODEX_CONFIG: '{"a":1}' },
            workdir: '~/my work',
            reversePort: 4100
        });
        deepStrictEqual(args.slice(0, 8), ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-p', '2222']);
        ok(args.includes('-T'));
        strictEqual(args[args.indexOf('-R') + 1], '0:127.0.0.1:4100');
        deepStrictEqual(args.slice(-3, -1), ['--', 'eva@example.org']);
        strictEqual(
            args.at(-1),
            `sh -c 'cd "$HOME"/'\\''my work'\\'' || exit 97; printf "\\036flotti-cwd %s\\n" "$PWD" >&2; `
            + `exec env '\\''CODEX_CONFIG={"a":1}'\\'' '\\''npx'\\'' '\\''-y'\\'' '\\''it'\\''\\'\\'''\\''s'\\'''`
        );
    });
    it('has no reverse tunnel without the fleet tools', () => {
        const args = remoteCommandArguments({ destination: 'h', host: 'h' }, { command: 'a', arguments: [], env: {}, workdir: '/srv' });
        ok(!args.includes('-R'));
    });
    it('reads the working directory and the port off standard error, in pieces, and leaves the rest', () => {
        const reader = new RemoteStartReader(true);
        deepStrictEqual(reader.read('Allocated port 3456 for remote forward to 127.0.0.1:4100\n\u001eflotti-cw'), []);
        strictEqual(reader.place, undefined);
        deepStrictEqual(reader.read('d /home/eva\nnpm warn something\n'), ['npm warn something']);
        deepStrictEqual(reader.place, { cwd: '/home/eva', reversePort: 3456 });
    });
});
describe('local manifest: ssh', () => {
    it('names the host the agent is started on; the working directory stays as written, ~ by default', () => {
        const { agent: found } = single('local', { command: 'npx', ssh: 'eva@example.org' });
        const local = found as LocalAgent;
        strictEqual(local.ssh, 'eva@example.org');
        strictEqual(local.workdir, '~');
        const { agent: other } = single('local', { command: 'npx', ssh: 'eva@example.org:2222', workdir: 'projects/app' });
        strictEqual((other as LocalAgent).workdir, 'projects/app');
    });
    it('refuses what is not an SSH address', () => {
        match(rejected('local', { command: 'npx', ssh: '-oProxyCommand=x' }).message, /ssh: "-oProxyCommand=x" is not an SSH address/);
    });
});
