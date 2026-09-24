import { deepStrictEqual, match, notStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, describe, it } from 'node:test';
import { TaskState } from '@a2a-js/sdk';
import { A2AAgent, HARNESS_EXTENSION, INBOX_EXTENSION } from '../src/a2a-agent.js';
import type { AgentEvent, AgentStatus } from '../src/agent-events.js';
import { SshError, describeFailure, discover, parsePublished, parseTarget, pickPublished } from '../src/ssh.js';
import type { SshOptions } from '../src/ssh.js';
import type { RemoteAgent } from '../src/types.js';
import { FakeAgent, agentMessage, said, statusUpdate, task } from './a2a-fake-server.js';
import type { Script } from './a2a-fake-server.js';
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
const FAKE_SSH = fileURLToPath(new URL('./fake-ssh.js', import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), 'flotti-ssh-'));
after(() => rmSync(workspace, { recursive: true, force: true }));
let made = 0;
/** A pretend host: a home directory with what it publishes, and a pretend ssh that goes there. */
function host(options: { refuse?: string } = {}) {
    const directory = join(workspace, `host-${++made}`);
    const home = join(directory, 'home');
    mkdirSync(home, { recursive: true });
    const config = join(directory, 'ssh.json');
    const pids = join(directory, 'pids');
    const forwarded = join(directory, 'forwarded');
    writeFileSync(config, JSON.stringify({ home, pids, forwarded, ...options }));
    const ssh: SshOptions = { command: process.execPath, prefix: [FAKE_SSH, config], readyTimeoutMs: 5_000 };
    return {
        ssh,
        publish(id: string, contents: object | string): void {
            mkdirSync(join(home, '.flotti', 'a2a'), { recursive: true });
            writeFileSync(join(home, '.flotti', 'a2a', `${id}.json`), typeof contents === 'string' ? contents : JSON.stringify(contents, null, 4));
        },
        /** Process ids of the tunnels opened so far. */
        tunnels(): number[] {
            return existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number) : [];
        },
        /** Connections the tunnels forwarded so far. */
        forwarded(): number {
            return existsSync(forwarded) ? readFileSync(forwarded, 'utf8').split('\n').filter(Boolean).length : 0;
        }
    };
}
const TARGET = parseTarget('eva@example.org');
describe('ssh: the address', () => {
    it('takes user@host, a host alone and a port', () => {
        deepStrictEqual(parseTarget('eva@example.org'), { destination: 'eva@example.org', host: 'example.org' });
        deepStrictEqual(parseTarget(' cutie@10.0.0.7:2222 '), { destination: 'cutie@10.0.0.7', host: '10.0.0.7', port: 2222 });
        deepStrictEqual(parseTarget('example.org'), { destination: 'example.org', host: 'example.org' });
    });
    it('refuses what ssh would read as an option, or not as an address', () => {
        for (const bad of ['-oProxyCommand=x', 'eva@-oProxyCommand=x', 'eva@host with space', 'eva@', '', 'eva@host:0', 'eva@host:99999']) {
            throws(() => parseTarget(bad), SshError, bad);
        }
    });
});
describe('ssh: what a host publishes', () => {
    it('reads every published file, and keeps the token', async () => {
        const pretend = host();
        pretend.publish('eva', { name: 'Eva', url: 'http://127.0.0.1:18741/', token: 't0ken' });
        pretend.publish('cutie', { url: 'http://127.0.0.1:18742/' });
        const published = await discover(TARGET, pretend.ssh);
        deepStrictEqual(published.sort((left, right) => left.id.localeCompare(right.id)), [
            { id: 'cutie', url: 'http://127.0.0.1:18742/' },
            { id: 'eva', name: 'Eva', url: 'http://127.0.0.1:18741/', token: 't0ken' }
        ]);
    });
    it('reads the harness an agent publishes, whatever its name', () => {
        deepStrictEqual(parsePublished(TARGET, '\u001eworker.json\n{"url": "http://127.0.0.1:1/", "harness": "codex"}'), [
            { id: 'worker', url: 'http://127.0.0.1:1/', harness: 'codex' }
        ]);
        deepStrictEqual(parsePublished(TARGET, '\u001eworker.json\n{"url": "http://127.0.0.1:1/", "harness": "home-made"}')[0]?.harness, 'home-made');
        deepStrictEqual(Object.keys(parsePublished(TARGET, '\u001eworker.json\n{"url": "http://127.0.0.1:1/"}')[0] ?? {}), ['id', 'url']);
        throws(() => parsePublished(TARGET, '\u001eworker.json\n{"url": "http://127.0.0.1:1/", "harness": 7}'), /worker\.json on [^:]+: harness must be a non-empty string/);
    });
    it('finds nothing on a host that publishes nothing', async () => {
        deepStrictEqual(await discover(TARGET, host().ssh), []);
    });
    it('names the file that is wrong', () => {
        throws(() => parsePublished(TARGET, '\u001eeva.json\n{"url": 1}'), /~\/\.flotti\/a2a\/eva\.json on eva@example\.org: url must be a non-empty string/);
        throws(() => parsePublished(TARGET, '\u001eeva.json\nnot json'), /eva\.json on eva@example\.org is not JSON/);
        throws(() => parsePublished(TARGET, '\u001eeva.json\n{"url": "ftp://x"}'), /url must be an http: address/);
        throws(() => parsePublished(TARGET, '\u001eeva.json\n{}'), /url is missing/);
    });
    it('picks the named agent, or the only one', () => {
        const eva = { id: 'eva', url: 'http://127.0.0.1:1/' };
        const cutie = { id: 'cutie', url: 'http://127.0.0.1:2/' };
        strictEqual(pickPublished(TARGET, [eva]), eva);
        strictEqual(pickPublished(TARGET, [eva, cutie], 'cutie'), cutie);
        throws(() => pickPublished(TARGET, [eva, cutie]), /publishes several agents \(eva, cutie\); name one in ssh\.agent/);
        throws(() => pickPublished(TARGET, [eva], 'cutie'), /does not publish "cutie"; it publishes eva/);
        throws(() => pickPublished(TARGET, []), /publishes no agent: ~\/\.flotti\/a2a\/ has no \.json file/);
    });
    it('says why ssh failed in words a person can act on', async () => {
        const refused = host({ refuse: 'eva@example.org: Permission denied (publickey).' });
        await rejects(discover(TARGET, refused.ssh), /did not accept the SSH key: add your public key to ~\/\.ssh\/authorized_keys/);
        match(describeFailure(TARGET, 255, 'ssh: Could not resolve hostname example.org: Name or service not known'), /The host example\.org is not known/);
        match(describeFailure(TARGET, 255, 'ssh: connect to host example.org port 22: Connection refused'), /Cannot reach example\.org over SSH/);
        match(describeFailure(TARGET, 255, 'Host key verification failed.'), /ssh-keygen -R example\.org/);
    });
    it('says so when there is no ssh at all', async () => {
        await rejects(discover(TARGET, { command: join(workspace, 'no-such-ssh') }), /flotti needs the OpenSSH client/);
    });
});
/** Answers every message with one completed task that says the message back. */
const echo: Script = async (context, bus) => {
    bus.publish(task(context, TaskState.TASK_STATE_WORKING));
    bus.publish(statusUpdate(context.taskId, context.contextId, TaskState.TASK_STATE_COMPLETED, agentMessage(`echo: ${said(context)}`, context)));
    bus.finished();
};
const running: FakeAgent[] = [];
const clients: A2AAgent[] = [];
afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.stop()));
    await Promise.all(running.splice(0).map((agent) => agent.close()));
});
function overSsh(ssh: SshOptions): { client: A2AAgent; events: AgentEvent[] } {
    const agent: RemoteAgent = {
        kind: 'remote',
        id: 'eva',
        name: 'Eva',
        directory: '/fleet/remote/eva',
        manifestPath: '/fleet/remote/eva/agent.json',
        protocol: 'a2a',
        ssh: { target: 'eva@example.org' },
        auth: { type: 'none' }
    };
    const client = new A2AAgent(agent, { ssh, reconnectDelayMs: 10, reopenDelayMaxMs: 50 });
    clients.push(client);
    const events: AgentEvent[] = [];
    client.subscribe((event) => events.push(event));
    return { client, events };
}
function reaches(client: A2AAgent, status: AgentStatus, reason?: string): Promise<void> {
    return new Promise((resolve) => {
        const stop = client.subscribe((event) => {
            if (event.type === 'status' && event.status === status && (reason === undefined || event.reason === reason)) {
                stop();
                resolve();
            }
        });
    });
}
/** Waits until the condition holds, checking every 10 ms. */
async function eventually(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > until) {
            throw new Error('the condition did not come true in time');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
describe('A2AAgent over SSH', () => {
    it('opens the tunnel, uses the published token and talks through the tunnel only', async () => {
        const agent = await new FakeAgent({ script: echo }).listen();
        running.push(agent);
        const pretend = host();
        pretend.publish('eva', { name: 'Eva', url: `${agent.url}/`, token: 'published-secret' });
        const { client, events } = overSsh(pretend.ssh);
        await client.start();
        strictEqual(client.status, 'idle');
        await client.send('hi');
        await reaches(client, 'idle');
        ok(events.some((event) => event.type === 'message' && event.text === 'echo: hi'));
        strictEqual(pretend.tunnels().length, 1);
        ok(pretend.forwarded() >= 1, 'the requests went down the tunnel');
        ok(agent.received.length > 0);
        for (const request of agent.received) {
            strictEqual(request.headers.authorization, 'Bearer published-secret');
        }
    });
});
describe('A2AAgent over SSH: the harness', () => {
    it('takes the harness from the published file, over what the card says', async () => {
        const agent = await new FakeAgent({
            script: echo,
            extensions: [HARNESS_EXTENSION],
            extensionParams: { [HARNESS_EXTENSION]: { harness: 'claude' } }
        }).listen();
        running.push(agent);
        const pretend = host();
        pretend.publish('worker', { url: `${agent.url}/`, harness: 'codex' });
        const { client } = overSsh(pretend.ssh);
        strictEqual(client.harness, undefined, 'not known before it is connected to');
        await client.start();
        strictEqual(client.harness, 'codex');
        await client.stop();
        strictEqual(client.harness, 'codex', 'still known while it is stopped');
    });
    it('knows no harness when the file and the card say nothing', async () => {
        const agent = await new FakeAgent({ script: echo }).listen();
        running.push(agent);
        const pretend = host();
        pretend.publish('worker', { url: `${agent.url}/` });
        const { client } = overSsh(pretend.ssh);
        await client.start();
        strictEqual(client.harness, undefined);
    });
});
describe('A2AAgent over SSH: keeping the tunnel up', () => {
    it('opens the tunnel again when it drops, and says why meanwhile', async () => {
        const agent = await new FakeAgent({ script: echo }).listen();
        running.push(agent);
        const pretend = host();
        pretend.publish('eva', { url: `${agent.url}/`, token: 'published-secret' });
        const { client, events } = overSsh(pretend.ssh);
        await client.start();
        const [first] = pretend.tunnels();
        ok(first !== undefined);
        const back = reaches(client, 'idle', 'reconnected');
        process.kill(first);
        await back;
        const reasons = events.flatMap((event) => event.type === 'status' && event.status === 'starting' ? [event.reason ?? ''] : []);
        ok(reasons.some((reason) => /^reconnecting: the SSH tunnel dropped/.test(reason)), reasons.join(' | '));
        const tunnels = pretend.tunnels();
        strictEqual(tunnels.length, 2);
        notStrictEqual(tunnels[1], first);
        await client.send('again');
        await reaches(client, 'idle');
        ok(events.some((event) => event.type === 'message' && event.text === 'echo: again'));
    });
    it('reports a key the host does not accept, and keeps trying', async () => {
        const pretend = host({ refuse: 'eva@example.org: Permission denied (publickey).' });
        const { client, events } = overSsh(pretend.ssh);
        await rejects(client.start(), /did not accept the SSH key/);
        const retrying = reaches(client, 'error');
        await retrying;
        const reasons = events.flatMap((event) => event.type === 'status' && event.status === 'error' ? [event.reason ?? ''] : []);
        ok(reasons.some((reason) => /did not accept the SSH key.*; trying again in 1 s$/.test(reason)), reasons.join(' | '));
        await client.stop();
        strictEqual(client.status, 'stopped');
    });
    it('closes the tunnel when it is stopped', async () => {
        const agent = await new FakeAgent({ script: echo }).listen();
        running.push(agent);
        const pretend = host();
        pretend.publish('eva', { url: `${agent.url}/` });
        const { client } = overSsh(pretend.ssh);
        await client.start();
        const [tunnel] = pretend.tunnels();
        await client.stop();
        throws(() => process.kill(tunnel ?? 0, 0), /ESRCH/);
    });
});
describe('A2AAgent over SSH: the inbox', () => {
    it('keeps the inbox open through the tunnel, and opens it again after the tunnel drops', async () => {
        const inboxes: { bus: ExecutionEventBus; context: RequestContext }[] = [];
        const agent = await new FakeAgent({
            extensions: [INBOX_EXTENSION],
            script: async (context, bus) => {
                if (context.userMessage.metadata?.[INBOX_EXTENSION] !== undefined) {
                    inboxes.push({ bus, context });
                    bus.publish(task(context, TaskState.TASK_STATE_WORKING));
                    await new Promise(() => undefined);
                }
                await echo(context, bus);
            }
        }).listen();
        running.push(agent);
        const pretend = host();
        pretend.publish('eva', { url: `${agent.url}/`, token: 'published-secret' });
        const { client, events } = overSsh(pretend.ssh);
        const post = (text: string) => {
            const inbox = inboxes.at(-1);
            ok(inbox !== undefined);
            inbox.bus.publish(statusUpdate(inbox.context.taskId, inbox.context.contextId, TaskState.TASK_STATE_WORKING,
                agentMessage(text, inbox.context, `own-${text}`)));
        };
        const said = (text: string) => events.some((event) => event.type === 'message' && event.text === text);
        await client.start();
        await eventually(() => inboxes.length === 1);
        post('before the drop');
        await eventually(() => said('before the drop'));
        for (const request of agent.received) {
            strictEqual(request.headers.authorization, 'Bearer published-secret');
        }
        const [first] = pretend.tunnels();
        const back = reaches(client, 'idle', 'reconnected');
        process.kill(first ?? 0);
        await back;
        await eventually(() => inboxes.length === 2);
        post('after the drop');
        await eventually(() => said('after the drop'));
        ok(pretend.forwarded() >= 3, 'the inbox went down the tunnel');
    });
});
