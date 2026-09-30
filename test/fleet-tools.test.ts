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
import { everyone, fakeFleet, group, seeingEachOther } from './fake-fleet-agent.js';
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
/**
 * The fleet, as the tools see it; `sent` is what each receiver reads, `options`
 * what came with it. Every agent is in the one group `everyone`: a message
 * posted to it reaches every other agent, as through the supervisor.
 */
function directory(ids: readonly string[]): FleetDirectory & { sent: string[]; options: SendOptions[] } {
    const sent: string[] = [];
    const options: SendOptions[] = [];
    const agents = (): AgentSummary[] => ids.map((id) => ({ id, name: id, kind: 'local', status: 'idle' }));
    const send = async (agentId: string, text: string, given: SendOptions = {}): Promise<Delivery> => {
        sent.push(`${given.from ?? '-'} -> ${agentId}: ${composeText(text, given, agentId)}`);
        options.push(given);
        return { agentId, result: 'taken' };
    };
    return {
        sent,
        options,
        agents,
        ...seeingEachOther(ids, agents),
        sendToGroup: async (groupId, text, given = {}) => ({
            deliveries: await Promise.all(ids.filter((id) => id !== given.from).map((id) => send(id, text, { ...given, group: groupId })))
        }),
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
        deepStrictEqual(tools.tools.map((tool) => tool.name), ['list_agents', 'list_groups', 'send_message', 'reply', 'delegate', 'cancel_delegation', 'forward']);
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
const TO_IS_GONE = '"to" is gone: a message to another agent goes through a group — name the group in "group" and the agent with @<id> in the text';
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
            ...directory(['alice', 'bob']),
            sendToGroup: () => Promise.reject(new Error('There is no group "everyone" in the fleet.')),
            ...noDelegations
        });
        const answer = await callTool(server, server.access('alice').token, 'send_message', { group: 'everyone', text: 'hi' });
        ok(answer.isError);
        match(answer.text, /was not posted to group "everyone": There is no group "everyone"/);
    });
    it('says what is wrong as a tool error the agent can read', async () => {
        const server = await toolsServer();
        server.serve(directory(['alice', 'bob']));
        const alice = server.access('alice').token;
        match((await callTool(server, alice, 'send_message', { group: 'everyone' })).text, /text is missing/);
        match((await callTool(server, alice, 'reply', { text: 'hi' })).text, /no message has come to you through a group yet/);
        ok((await callTool(server, alice, 'reply', { text: 'hi' })).isError);
    });
});
describe('fleet tools: agents talk inside groups only (0.7.0, #171)', () => {
    it('send_message and forward have no "to" in their schema, delegate takes the group and the doer', async () => {
        const server = await toolsServer();
        server.serve(directory(['alice', 'bob']));
        const { body } = await rpc(server, server.access('alice').token, 'tools/list');
        const tools = (body?.['result'] as { tools: { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[] }).tools;
        const schema = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema;
        deepStrictEqual(Object.keys(schema('send_message')?.properties ?? {}), ['group', 'text']);
        deepStrictEqual(schema('send_message')?.required, ['group', 'text']);
        deepStrictEqual(Object.keys(schema('forward')?.properties ?? {}), ['group', 'comment']);
        deepStrictEqual(schema('delegate')?.required, ['group', 'to', 'text']);
    });
    it('a message with "to" is refused on every tool before anything is asked, and goes nowhere', async () => {
        const server = await toolsServer();
        const fleet = directory(['alice', 'bob']);
        server.serve(fleet);
        const alice = server.access('alice').token;
        server.delivered({ to: 'alice', from: 'bob', messageId: 'm-1', text: 'the build is red', group: 'everyone' });
        for (const [name, args] of [
            ['send_message', { to: 'bob', text: 'hi' }],
            ['send_message', { to: 'bob', group: 'everyone', text: 'hi' }],
            ['send_message', { to: 'nobody', text: 'hi' }],
            ['forward', { to: 'bob' }],
            ['reply', { to: 'bob', text: 'hi' }]
        ] as const) {
            const answer = await callTool(server, alice, name, args);
            deepStrictEqual([answer.isError, answer.text], [true, TO_IS_GONE], `${name} ${JSON.stringify(args)}`);
        }
        deepStrictEqual(fleet.sent, [], 'nothing went anywhere');
    });
    it('a peer gets nothing by "to" through the supervisor either; through the group it gets the message', async () => {
        const { call, supervisor, fakes, lines } = await fleetWithGroups(['eva', 'reviewer'], [['release', ['eva', 'reviewer']]]);
        strictEqual((await call('eva', 'send_message', { to: 'reviewer', text: 'hi' })).text, TO_IS_GONE);
        deepStrictEqual(fakes.get('reviewer')?.calls, ['start'], 'nothing reaches the peer');
        deepStrictEqual(lines('eva'), [], 'the tool said it: no line besides');
        strictEqual((await call('eva', 'send_message', { group: 'release', text: '@reviewer hi' })).isError, false);
        await eventually(() => (fakes.get('reviewer')?.calls.length ?? 0) > 1);
        deepStrictEqual(fakes.get('reviewer')?.calls.slice(0, 2), ['start', 'send @reviewer hi from eva']);
        await supervisor.stop();
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
/** A fleet of fakes with these groups, run by a supervisor that serves the tools. */
async function fleetWithGroups(ids: readonly string[], groups: Parameters<typeof group>[]) {
    const server = await toolsServer();
    const { fleet, fakes, createAgent } = fakeFleet(...ids);
    const supervisor = new Supervisor({ ...fleet, groups: groups.map((fields) => group(...fields)) }, { createAgent, fleetTools: server });
    server.serve(supervisor);
    await supervisor.start();
    const call = (caller: string, name: string, args: object = {}) => callTool(server, server.access(caller).token, name, args);
    const lines = (agentId: string) => supervisor.history(agentId).flatMap((event) => (event.type === 'log' ? [event.text] : []));
    return { supervisor, fakes, call, lines };
}
describe('fleet tools: who sees whom (docs/groups.md)', () => {
    it('list_agents names the peers with the groups shared, the caller marked; an agent in no group with anyone gets an empty list and why', async () => {
        const { call, supervisor } = await fleetWithGroups(['eva', 'loner', 'reviewer', 'writer'], [['docs', ['writer', 'eva']], ['release', ['eva', 'reviewer']]]);
        const listed = JSON.parse((await call('eva', 'list_agents')).text) as Record<string, unknown>[];
        deepStrictEqual(listed.map((agent) => [agent['id'], agent['groups'], agent['you'] ?? false]), [
            ['eva', ['docs', 'release'], true],
            ['reviewer', ['release'], false],
            ['writer', ['docs'], false]
        ]);
        const alone = await call('loner', 'list_agents');
        strictEqual(alone.isError, false);
        match(alone.text, /^\[\]\nYou are not in a group with anyone yet, so there is no agent you can write to/);
        await supervisor.stop();
    });
    it('list_groups names the groups of the caller: id, name, topic and the members by id and name', async () => {
        const { call, supervisor } = await fleetWithGroups(['eva', 'loner', 'reviewer'], [['release', ['eva', 'reviewer', 'gone'], { name: 'Release', topic: 'Ship it.' }]]);
        deepStrictEqual(JSON.parse((await call('eva', 'list_groups')).text), [
            { id: 'release', name: 'Release', topic: 'Ship it.', members: [{ id: 'eva', name: 'EVA' }, { id: 'reviewer', name: 'REVIEWER' }] }
        ]);
        match((await call('loner', 'list_groups')).text, /^\[\]\nYou are in no group yet/);
        await supervisor.stop();
    });
    it('a task to an agent out of sight, or outside the group it names, is refused with the words for no agent; a member gets it', async () => {
        const { call, supervisor, fakes, lines } = await fleetWithGroups(['eva', 'reviewer', 'writer'], [['docs', ['writer', 'eva']], ['release', ['eva', 'reviewer']]]);
        match((await call('writer', 'delegate', { group: 'docs', to: 'reviewer', text: 'do it' })).text, /^Task \S+ failed at once: there is no agent "reviewer" among the agents you can write to/);
        match((await call('writer', 'delegate', { group: 'docs', to: 'nobody', text: 'do it' })).text, /^Task \S+ failed at once: there is no agent "nobody" among/);
        match((await call('eva', 'delegate', { group: 'docs', to: 'reviewer', text: 'do it' })).text, /^Task \S+ failed at once: there is no agent "reviewer" among/, 'a peer, but not in the group named');
        match((await call('writer', 'delegate', { group: 'release', to: 'reviewer', text: 'do it' })).text, /^Task \S+ failed at once: there is no group "release" among the groups you are in/);
        match((await call('eva', 'delegate', { group: 'release', text: 'do it' })).text, /^a task names one doer/);
        deepStrictEqual(fakes.get('reviewer')?.calls, ['start'], 'nothing reaches the agent');
        deepStrictEqual(lines('writer'), ['"reviewer" is not in a group with "writer"', '"writer" is not in group "release"'], 'the tab of the giver says the real reason');
        deepStrictEqual(lines('eva'), ['"reviewer" is not in group "docs"']);
        match((await call('eva', 'delegate', { group: 'release', to: 'reviewer', text: 'do it' })).text, /^Task \S+ is with "reviewer" in group "release"/);
        await supervisor.stop();
    });
});
describe('fleet tools: replies to what the supervisor delivers', () => {
    it('reply answers in the group the last group message came from, not the outcome of a task that came after it', async () => {
        const { server, supervisor, fake } = await fleetWithTools('alice', 'bob');
        const alice = fake('alice');
        await callTool(server, server.access('bob').token, 'send_message', { group: 'everyone', text: 'is the release ready?' });
        await eventually(() => alice.options.some((options) => options.from === 'bob'));
        server.delivered({ to: 'alice', from: 'bob', messageId: 'outcome-1', text: 'done' });
        const answer = await callTool(server, server.access('alice').token, 'reply', { text: 'yes, tagged' });
        strictEqual(answer.isError, false, answer.text);
        await eventually(() => supervisor.groupHistory('everyone').some((message) => message.text === 'yes, tagged'));
        const replied = supervisor.groupHistory('everyone').find((message) => message.text === 'yes, tagged');
        deepStrictEqual([replied?.from, replied?.replyTo?.author, replied?.replyTo?.text], ['alice', 'bob', 'is the release ready?']);
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
describe('fleet tools: an agent writes to a group', { timeout: 30_000 }, () => {
    it('and the message reaches the other member with its sender and the group', async () => {
        const server = await toolsServer();
        const make = (id: string) => new Harness({ fake: { mcpHttp: true }, manifest: { id }, options: { fleetTools: server.access(id) } });
        const alice = make('alice');
        const bob = make('bob');
        const running = new Map([['alice', alice.agent], ['bob', bob.agent]]);
        const supervisor = new Supervisor(
            { location: { path: workspace, source: 'argument' }, exists: true, agents: [alice.agent.agent, bob.agent.agent], groups: [everyone(['alice', 'bob'])] },
            { createAgent: (agent) => running.get(agent.id) ?? alice.agent }
        );
        server.serve(supervisor);
        await supervisor.start();
        await alice.talk('mcp {"name":"send_message","arguments":{"group":"everyone","text":"ping from alice"}}');
        const received = await bob.next((event) => event.type === 'message' && event.role === 'user');
        deepStrictEqual(pick(received), { text: 'ping from alice', from: 'alice' });
        await eventually(() => bob.recorded('session/prompt').length > 0);
        strictEqual(bob.recorded('session/prompt')[0]?.['text'], '[from alice in group everyone] ping from alice');
        ok(alice.events.some((event) => event.type === 'message' && event.role === 'agent' && /mcp: Posted to group "everyone": "bob" (has it|is busy)/.test(event.text)));
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
describe('fleet tools: messages to a group (docs/groups.md)', () => {
    it('posts to every other member of a group the caller is in, and says how each took it', async () => {
        const server = await toolsServer();
        const fleet = directory(['alice', 'bob', 'carol']);
        server.serve(fleet);
        const posted = await callTool(server, server.access('alice').token, 'send_message', { group: 'everyone', text: 'ship it' });
        strictEqual(posted.isError, false, posted.text);
        strictEqual(posted.text, 'Posted to group "everyone": "bob" has it; "carol" has it. What the members answer comes to you as messages from them.');
        deepStrictEqual(fleet.sent, ['alice -> bob: ship it', 'alice -> carol: ship it']);
        deepStrictEqual(fleet.options.map((options) => [options.from, options.group]), [['alice', 'everyone'], ['alice', 'everyone']]);
    });
    it('refuses a call that names no group, and a group the caller is not in', async () => {
        const server = await toolsServer();
        const fleet = directory(['alice', 'bob']);
        server.serve(fleet);
        const alice = server.access('alice').token;
        const neither = await callTool(server, alice, 'send_message', { text: 'hi' });
        deepStrictEqual([neither.isError, neither.text], [true, '"group" is missing: name a group you are in, as list_groups gives it']);
        const outside = await callTool(server, alice, 'send_message', { group: 'secret', text: 'hi' });
        deepStrictEqual([outside.isError, outside.text], [true, 'there is no group "secret" among the groups you are in; list_groups names them']);
        server.delivered({ to: 'alice', from: 'bob', messageId: 'm-1', text: 'the build is red' });
        match((await callTool(server, alice, 'forward', {})).text, /"group" is missing/);
        deepStrictEqual(fleet.sent, [], 'nothing went anywhere');
    });
});
describe('fleet tools: forwards to a group (docs/groups.md)', () => {
    it('forwards a forward as it was first written, naming who wrote it', async () => {
        const server = await toolsServer();
        const fleet = directory(['alice', 'bob', 'carol']);
        server.serve(fleet);
        server.delivered({ to: 'bob', from: 'alice', messageId: 'm-1', text: 'the build is red', group: 'everyone' });
        await callTool(server, server.access('bob').token, 'forward', { group: 'everyone' });
        server.delivered({ to: 'carol', from: 'bob', messageId: 'm-2', text: '', forwarded: { author: 'alice', text: 'the build is red' }, group: 'everyone' });
        await callTool(server, server.access('carol').token, 'forward', { group: 'everyone' });
        deepStrictEqual(fleet.options.at(-1)?.forwarded, { author: 'alice', text: 'the build is red' });
        strictEqual(fleet.sent.at(-2), 'carol -> alice: Forwarded from you:\n\nthe build is red');
    });
    it('replies to the group when the last message came through one, and forwards to a group', async () => {
        const server = await toolsServer();
        const fleet = directory(['alice', 'bob', 'carol']);
        server.serve(fleet);
        server.delivered({ to: 'bob', from: 'alice', messageId: 'm-1', text: 'ship it', group: 'everyone' });
        const reply = await callTool(server, server.access('bob').token, 'reply', { text: 'aye' });
        strictEqual(reply.isError, false, reply.text);
        await callTool(server, server.access('bob').token, 'forward', { group: 'everyone', comment: 'FYI' });
        deepStrictEqual(fleet.sent, [
            'bob -> alice: In reply to a message from you:\n> ship it\n\naye',
            'bob -> carol: In reply to a message from agent "alice":\n> ship it\n\naye',
            'bob -> alice: FYI\n\nForwarded from you:\n\nship it',
            'bob -> carol: FYI\n\nForwarded from agent "alice":\n\nship it'
        ]);
        deepStrictEqual(fleet.options[0], { from: 'bob', group: 'everyone', replyTo: { agentId: 'bob', messageId: 'm-1', author: 'alice', text: 'ship it' } });
        deepStrictEqual(fleet.options[3], { from: 'bob', group: 'everyone', forwarded: { author: 'alice', text: 'ship it' } });
    });
});
describe('fleet tools: a message to a group through the supervisor (docs/groups.md)', () => {
    it('reaches the members, and a member\'s reply answers the group', async () => {
        const { supervisor, fakes, call, lines } = await fleetWithGroups(['a', 'b', 'c'], [['release', ['a', 'b', 'c']]]);
        const posted = await call('a', 'send_message', { group: 'release', text: 'ship it' });
        strictEqual(posted.isError, false, posted.text);
        await eventually(() => supervisor.groupHistory('release').length === 3, 2_000);
        deepStrictEqual(supervisor.groupHistory('release').map((message) => [message.from, message.text]), [['a', 'ship it'], ['b', 'you said: ship it'], ['c', 'you said: ship it']]);
        const later = await call('b', 'reply', { text: 'later' });
        strictEqual(later.isError, false, later.text);
        await eventually(() => supervisor.groupHistory('release').length >= 4, 2_000);
        const quoted = supervisor.groupHistory('release')[3]?.replyTo;
        deepStrictEqual([quoted?.author, quoted?.text], ['c', 'you said: ship it'], 'the last message b got was the answer of c, posted to the group');
        deepStrictEqual(fakes.get('c')?.calls.filter((line) => line === 'send later from b'), ['send later from b'], 'the reply reaches the other members once');
        deepStrictEqual(lines('a'), []);
        await supervisor.stop();
    });
});
