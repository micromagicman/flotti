import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { WebSocket } from 'ws';
import type { AgentEvent } from '../src/agent-events.js';
import type { ServerMessage } from '../src/dashboard-protocol.js';
import { startDashboard } from '../src/dashboard-server.js';
import type { Dashboard } from '../src/dashboard-server.js';
import { Supervisor } from '../src/supervisor.js';
import { FakeFleetAgent, fakeFleet } from './fake-fleet-agent.js';
const webRoot = mkdtempSync(join(tmpdir(), 'flotti-web-'));
writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>flotti</title>');
after(() => rmSync(webRoot, { recursive: true, force: true }));
const open: { dashboard: Dashboard; supervisor: Supervisor; sockets: WebSocket[] }[] = [];
afterEach(async () => {
    for (const { dashboard, supervisor, sockets } of open.splice(0)) {
        sockets.forEach((socket) => socket.terminate());
        await dashboard.close();
        await supervisor.stop();
    }
});
async function serve(...ids: string[]) {
    const { fleet, fakes, createAgent } = fakeFleet(...ids);
    const supervisor = new Supervisor(fleet, { createAgent, queuedAfterMs: 50 });
    await supervisor.start();
    const dashboard = await startDashboard(supervisor, { port: 0, webRoot });
    const sockets: WebSocket[] = [];
    open.push({ dashboard, supervisor, sockets });
    const fake = (id: string): FakeFleetAgent => fakes.get(id) ?? new FakeFleetAgent(id);
    return { dashboard, supervisor, fake, sockets };
}
type Answer = { status: number; body: unknown; text: string };
function call(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const outgoing = request({
            host: '127.0.0.1',
            port,
            method,
            path,
            headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }
        }, (response) => {
            let text = '';
            response.on('data', (chunk: Buffer) => (text += chunk.toString()));
            response.on('end', () => {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(text);
                } catch {
                    parsed = undefined;
                }
                resolve({ status: response.statusCode ?? 0, body: parsed, text });
            });
        });
        outgoing.on('error', reject);
        outgoing.end(payload);
    });
}
/** A page on the socket: collects what the server says. */
async function page(port: number, sockets: WebSocket[], since?: Record<string, number>, origin?: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin === undefined ? {} : { origin });
    sockets.push(socket);
    const messages: ServerMessage[] = [];
    socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as ServerMessage;
        messages.push(message);
        if (message.type === 'fleet' && since !== undefined) {
            socket.send(JSON.stringify({ type: 'subscribe', since }));
        }
    });
    await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
    });
    return { socket, messages };
}
function events(messages: readonly ServerMessage[]): AgentEvent[] {
    return messages.flatMap((message) => (message.type === 'event' ? [message.event] : []));
}
async function eventually(condition: () => boolean): Promise<void> {
    const until = Date.now() + 2000;
    while (!condition()) {
        if (Date.now() > until) {
            throw new Error('the condition did not come true in time');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
test('lists the agents and serves the page', async () => {
    const { dashboard } = await serve('a', 'b');
    const agents = await call(dashboard.port, 'GET', '/api/agents');
    deepStrictEqual(agents.body, [
        { id: 'a', name: 'A', kind: 'local', status: 'idle' },
        { id: 'b', name: 'B', kind: 'local', status: 'idle' }
    ]);
    const index = await call(dashboard.port, 'GET', '/agent/a');
    strictEqual(index.status, 200);
    ok(index.text.includes('<title>flotti</title>'), 'any page path gets index.html');
    strictEqual((await call(dashboard.port, 'GET', '/assets/missing.js')).status, 404);
    strictEqual((await call(dashboard.port, 'GET', '/../../etc/passwd.txt')).status, 404);
});
test('sends a message to one agent and a broadcast to several', async () => {
    const { dashboard, fake } = await serve('a', 'b', 'c');
    fake('c').busy = true;
    const one = await call(dashboard.port, 'POST', '/api/agents/a/messages', { text: 'hello' });
    deepStrictEqual([one.status, one.body], [200, { agentId: 'a', result: 'taken' }]);
    const all = await call(dashboard.port, 'POST', '/api/broadcast', { text: 'ping' });
    deepStrictEqual(all.body, {
        deliveries: [
            { agentId: 'a', result: 'taken' },
            { agentId: 'b', result: 'taken' },
            { agentId: 'c', result: 'queued' }
        ]
    });
    const some = await call(dashboard.port, 'POST', '/api/broadcast', { text: 'pong', agents: ['b'] });
    deepStrictEqual(some.body, { deliveries: [{ agentId: 'b', result: 'taken' }] });
    deepStrictEqual(fake('a').calls, ['start', 'send hello', 'send ping']);
});
test('restarts, cancels and answers permission requests', async () => {
    const { dashboard, fake } = await serve('a');
    strictEqual((await call(dashboard.port, 'POST', '/api/agents/a/restart', {})).status, 202);
    strictEqual((await call(dashboard.port, 'POST', '/api/agents/a/cancel', {})).status, 200);
    strictEqual((await call(dashboard.port, 'POST', '/api/agents/a/permissions/r1', { optionId: 'yes' })).status, 404);
    fake('a').askPermission('r1');
    strictEqual((await call(dashboard.port, 'POST', '/api/agents/a/permissions/r1', { optionId: 'yes' })).status, 200);
    deepStrictEqual(fake('a').calls, ['start', 'restart', 'cancel', 'permission r1 yes', 'permission r1 yes']);
});
test('refuses what it should', async () => {
    const { dashboard } = await serve('a');
    const { port } = dashboard;
    strictEqual((await call(port, 'POST', '/api/agents/nobody/restart', {})).status, 404);
    strictEqual((await call(port, 'POST', '/api/agents/a/messages', { text: '  ' })).status, 400);
    strictEqual((await call(port, 'POST', '/api/broadcast', { text: 'hi', agents: [] })).status, 400);
    strictEqual((await call(port, 'GET', '/api/agents/a/restart')).status, 405);
    strictEqual((await call(port, 'POST', '/api/shutdown', {})).status, 404, 'no shutdown route without a token');
    const form = await call(port, 'POST', '/api/agents/a/restart', undefined, { 'content-type': 'text/plain' });
    strictEqual(form.status, 415, 'a cross-site form cannot send JSON');
    const rebound = await call(port, 'GET', '/api/agents', undefined, { host: `evil.example:${port}` });
    strictEqual(rebound.status, 421, 'a foreign host name is refused');
    const foreign = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://evil.example' });
    const refused = await new Promise<boolean>((resolve) => {
        foreign.once('open', () => resolve(false));
        foreign.once('error', () => resolve(true));
    });
    strictEqual(refused, true, 'a socket from another site is refused');
});
test('a page gets the fleet, then the history, then live events', async () => {
    const { dashboard, supervisor, sockets } = await serve('a', 'b');
    await supervisor.send('a', 'before');
    const { messages } = await page(dashboard.port, sockets, {}, `http://127.0.0.1:${dashboard.port}`);
    await eventually(() => events(messages).length === 5);
    strictEqual(messages[0]?.type, 'fleet');
    await supervisor.send('b', 'after');
    await eventually(() => events(messages).length === 8);
    const seqs = events(messages).map((event) => `${event.agentId}${event.seq}`);
    deepStrictEqual(seqs, ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4']);
});
test('a page that reconnects gets only what it missed', async () => {
    const { dashboard, supervisor, sockets } = await serve('a');
    await supervisor.send('a', 'one');
    const { messages } = await page(dashboard.port, sockets, { a: 3 });
    await eventually(() => events(messages).length === 1);
    deepStrictEqual(events(messages).map((event) => event.seq), [4]);
    await supervisor.send('a', 'two');
    await eventually(() => events(messages).length === 4);
    deepStrictEqual(events(messages).map((event) => event.seq), [4, 5, 6, 7]);
});
test('tells the pages when it goes away', async () => {
    const { dashboard, sockets } = await serve('a');
    const { messages, socket } = await page(dashboard.port, sockets, {});
    const closed = new Promise((resolve) => socket.once('close', resolve));
    open.splice(0).forEach(({ supervisor }) => void supervisor.stop());
    await dashboard.close();
    await closed;
    strictEqual(messages.at(-1)?.type, 'shutdown');
});
