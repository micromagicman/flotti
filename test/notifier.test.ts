import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent, AgentEventBody, AgentStatus } from '../src/agent-events.js';
import type { NotificationEvents } from '../src/dashboard-protocol.js';
import { Notifier, agentUrl, classify } from '../src/notifier.js';
import type { Notice, NoticeSource, NotificationChannel } from '../src/notifier.js';
import type { SupervisorNotice } from '../src/supervisor.js';
import type { Agent, LocalAgent, RemoteAgent } from '../src/types.js';
/** A channel that remembers what it was asked to do. */
class Recorder implements NotificationChannel {
    readonly name = 'recorder';
    readonly sent: Notice[] = [];
    readonly withdrawn: string[] = [];
    async notify(notice: Notice): Promise<void> {
        this.sent.push(notice);
    }
    async withdraw(key: string): Promise<void> {
        this.withdrawn.push(key);
    }
}
function local(id: string, ssh?: string): LocalAgent {
    return {
        kind: 'local',
        id,
        name: id.charAt(0).toUpperCase() + id.slice(1),
        directory: `/fleet/local/${id}`,
        manifestPath: `/fleet/local/${id}/agent.json`,
        command: 'fake',
        arguments: [],
        ...(ssh === undefined ? {} : { ssh }),
        workdir: '~',
        env: {},
        restart: 'on-failure',
        heartbeatTimeoutSec: 60,
        skillsDirectory: `/fleet/local/${id}/skills`,
        memoryDirectory: `/fleet/local/${id}/memory`
    };
}
function remoteOverSsh(id: string): RemoteAgent {
    return {
        kind: 'remote',
        id,
        name: id,
        directory: `/fleet/remote/${id}`,
        manifestPath: `/fleet/remote/${id}/agent.json`,
        protocol: 'a2a',
        ssh: { target: 'user@build-host' },
        auth: { type: 'none' }
    };
}
type Setup = { events?: Partial<NotificationEvents>; repeatMinutes?: number; channels?: NotificationChannel[] };
/** A notifier over pretend agents: `emit` plays their events, `recorder` sees what it sends. */
function watching(agents: readonly Agent[], setup: Setup = {}) {
    const listeners = new Set<(notice: SupervisorNotice) => void>();
    const source: NoticeSource = {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        agent: (agentId) => {
            const found = agents.find((agent) => agent.id === agentId);
            if (found === undefined) {
                throw new Error(`no agent ${agentId}`);
            }
            return found;
        }
    };
    const recorder = new Recorder();
    const notifier = new Notifier(source, {
        config: () => ({
            events: { waiting: true, error: true, connection: true, ...setup.events },
            repeatMinutes: setup.repeatMinutes ?? 0,
            dashboardUrl: 'http://127.0.0.1:4870/',
            channels: setup.channels ?? [recorder]
        }),
        warn: () => undefined
    });
    let seq = 0;
    const emit = (agentId: string, body: AgentEventBody): void => {
        const event = { ...body, agentId, seq: ++seq, time: new Date().toISOString() } as AgentEvent;
        listeners.forEach((listener) => listener({ type: 'event', event }));
    };
    const status = (agentId: string, value: AgentStatus, reason?: string): void =>
        emit(agentId, reason === undefined ? { type: 'status', status: value } : { type: 'status', status: value, reason });
    return { notifier, recorder, emit, status };
}
test('one wait earns one notification, and the answer takes it back', () => {
    const { recorder, emit, status } = watching([local('reviewer')]);
    status('reviewer', 'idle');
    status('reviewer', 'working');
    emit('reviewer', { type: 'permission', requestId: 'r1', title: 'Run npm test', options: [] });
    status('reviewer', 'waiting');
    status('reviewer', 'waiting', 'still waiting');
    deepStrictEqual(recorder.sent.map(({ kind, title, body, url }) => ({ kind, title, body, url })), [{
        kind: 'waiting',
        title: 'Reviewer is waiting for you',
        body: 'Asks for permission: Run npm test',
        url: 'http://127.0.0.1:4870/#/reviewer'
    }]);
    status('reviewer', 'working');
    deepStrictEqual(recorder.withdrawn, [recorder.sent[0]?.key]);
    status('reviewer', 'waiting');
    strictEqual(recorder.sent.length, 2, 'a new wait is a new notification');
});
test('an agent that waits for input is quoted: its question is the gist', () => {
    const { recorder, emit, status } = watching([local('writer')]);
    status('writer', 'working');
    emit('writer', { type: 'message', role: 'agent', messageId: 'm1', text: 'Which branch ', append: false });
    emit('writer', { type: 'message', role: 'agent', messageId: 'm1', text: 'should I use?', append: true });
    status('writer', 'waiting', 'input required');
    strictEqual(recorder.sent[0]?.body, 'Which branch should I use?');
});
test('nothing is sent when the moment is switched off, or no channel is set up', () => {
    const off = watching([local('reviewer')], { events: { waiting: false } });
    off.status('reviewer', 'idle');
    off.status('reviewer', 'waiting');
    deepStrictEqual(off.recorder.sent, []);
    const none = watching([local('reviewer')], { channels: [] });
    none.status('reviewer', 'idle');
    none.status('reviewer', 'waiting');
    none.status('reviewer', 'error', 'boom');
    deepStrictEqual(none.recorder.sent, []);
});
test('a failure is told once, however long the agent stays down, and again after it was back', () => {
    const { recorder, status } = watching([local('builder')]);
    status('builder', 'idle');
    status('builder', 'starting', 'exited with code 1; restarting in 1000 ms');
    status('builder', 'starting', 'starting, try 2');
    status('builder', 'error', 'gave up after 5 restarts in a row');
    deepStrictEqual(recorder.sent.map(({ kind, title, body }) => [kind, title, body]), [
        ['error', 'Builder failed', 'exited with code 1; restarting in 1000 ms']
    ]);
    deepStrictEqual(recorder.withdrawn, [], 'a failure is not taken back');
    status('builder', 'idle');
    status('builder', 'error', 'the turn failed');
    strictEqual(recorder.sent.length, 2);
});
test('a stop or a restart by hand is not a failure', () => {
    const { recorder, status } = watching([local('builder')]);
    status('builder', 'idle');
    status('builder', 'stopped');
    status('builder', 'starting', 'restarting');
    status('builder', 'idle');
    status('builder', 'starting', 'restarting');
    deepStrictEqual(recorder.sent, []);
});
test('an agent over SSH that falls has lost its connection', () => {
    const { recorder, status } = watching([remoteOverSsh('tunnelled'), local('far', 'user@build-host')]);
    status('tunnelled', 'idle');
    status('tunnelled', 'starting', 'reconnecting: the tunnel closed');
    status('tunnelled', 'error', 'connection refused; trying again in 2 s');
    status('far', 'working');
    status('far', 'starting', 'exited with code 255; restarting in 1000 ms');
    deepStrictEqual(recorder.sent.map(({ kind, title }) => [kind, title]), [
        ['connection', 'tunnelled lost its SSH connection'],
        ['connection', 'Far lost its SSH connection']
    ]);
});
test('the connection switch is its own: off, a lost connection says nothing', () => {
    const { recorder, status } = watching([remoteOverSsh('tunnelled')], { events: { connection: false } });
    status('tunnelled', 'idle');
    status('tunnelled', 'starting', 'reconnecting: the tunnel closed');
    status('tunnelled', 'error', 'connection refused; trying again in 2 s');
    deepStrictEqual(recorder.sent, []);
});
test('an agent that still waits is told again when the settings ask for it', (context) => {
    context.mock.timers.enable({ apis: ['setInterval'] });
    const { recorder, status, notifier } = watching([local('reviewer')], { repeatMinutes: 10 });
    status('reviewer', 'idle');
    status('reviewer', 'waiting');
    context.mock.timers.tick(10 * 60_000);
    context.mock.timers.tick(10 * 60_000);
    strictEqual(recorder.sent.length, 3);
    strictEqual(new Set(recorder.sent.map((notice) => notice.key)).size, 1, 'a repeat belongs to the same wait');
    status('reviewer', 'idle');
    context.mock.timers.tick(30 * 60_000);
    strictEqual(recorder.sent.length, 3, 'no repeat once answered');
    notifier.close();
});
test('a failed channel is reported and does not stop the others', async () => {
    const broken: NotificationChannel = {
        name: 'broken',
        notify: () => Promise.reject(new Error('down')),
        withdraw: () => Promise.resolve()
    };
    const warnings: string[] = [];
    const recorder = new Recorder();
    const listeners: ((notice: SupervisorNotice) => void)[] = [];
    new Notifier({ subscribe: (listener) => (listeners.push(listener), () => undefined), agent: () => local('reviewer') }, {
        config: () => ({ events: { waiting: true, error: true, connection: true }, repeatMinutes: 0, dashboardUrl: 'http://x/', channels: [broken, recorder] }),
        warn: (line) => warnings.push(line)
    });
    const event = (status: 'idle' | 'waiting', seq: number) => ({ type: 'event' as const, event: { type: 'status' as const, status, agentId: 'reviewer', seq, time: '' } });
    listeners.forEach((listener) => listener(event('idle', 1)));
    listeners.forEach((listener) => listener(event('waiting', 2)));
    await new Promise((resolve) => setImmediate(resolve));
    strictEqual(recorder.sent.length, 1);
    deepStrictEqual(warnings, ['flotti: a broken notification failed: down']);
});
test('the kinds, and the address of a tab', () => {
    strictEqual(classify(local('a'), 'idle', 'waiting', undefined), 'waiting');
    strictEqual(classify(local('a'), 'starting', 'idle', undefined), undefined);
    strictEqual(classify(local('a'), 'stopped', 'starting', undefined), undefined);
    strictEqual(classify(local('a'), 'starting', 'error', 'no such command'), 'error');
    strictEqual(classify(local('a', 'user@host'), 'starting', 'error', 'no such command'), 'error');
    strictEqual(agentUrl('https://fleet.example.org', 'a b'), 'https://fleet.example.org/#/a%20b');
});
