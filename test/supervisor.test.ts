import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { Supervisor, UnknownAgentError } from '../src/supervisor.js';
import type { SupervisorNotice } from '../src/supervisor.js';
import { fakeFleet } from './fake-fleet-agent.js';
function supervised(...ids: string[]) {
    const { fleet, fakes, createAgent } = fakeFleet(...ids);
    const supervisor = new Supervisor(fleet, { createAgent, queuedAfterMs: 50, historyLimit: 5 });
    const notices: SupervisorNotice[] = [];
    supervisor.subscribe((notice) => notices.push(notice));
    return { supervisor, fakes, notices };
}
function fake<T>(value: T | undefined): T {
    if (value === undefined) {
        throw new Error('no such fake');
    }
    return value;
}
test('starts every agent, and one that fails does not stop the others', async () => {
    const { supervisor, fakes } = supervised('a', 'b');
    fake(fakes.get('a')).broken = true;
    await supervisor.start();
    deepStrictEqual(supervisor.agents().map((agent) => [agent.id, agent.name, agent.kind, agent.status]), [
        ['a', 'A', 'local', 'error'],
        ['b', 'B', 'local', 'idle']
    ]);
});
test('keeps the last events of each agent and hands out those after a seq', async () => {
    const { supervisor } = supervised('a');
    await supervisor.start();
    await supervisor.send('a', 'one');
    await supervisor.send('a', 'two');
    const history = supervisor.history('a');
    strictEqual(history.length, 5, 'the history keeps only historyLimit events');
    deepStrictEqual(history.map((event) => event.seq), [3, 4, 5, 6, 7]);
    deepStrictEqual(supervisor.history('a', 6).map((event) => event.seq), [7]);
});
test('a broadcast goes to each agent on its own: a broken or a busy one holds nobody up', async () => {
    const { supervisor, fakes, notices } = supervised('a', 'b', 'c');
    await supervisor.start();
    fake(fakes.get('b')).broken = true;
    fake(fakes.get('c')).busy = true;
    const deliveries = await supervisor.broadcast('hello');
    deepStrictEqual(deliveries, [
        { agentId: 'a', result: 'taken' },
        { agentId: 'b', result: 'failed', error: 'b is broken' },
        { agentId: 'c', result: 'queued' }
    ]);
    fake(fakes.get('c')).release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(notices.filter((notice) => notice.type === 'delivery'), [
        { type: 'delivery', delivery: { agentId: 'c', result: 'taken' } }
    ]);
});
test('a broadcast may pick its agents', async () => {
    const { supervisor, fakes } = supervised('a', 'b');
    await supervisor.start();
    const deliveries = await supervisor.broadcast('hi', ['b', 'b']);
    deepStrictEqual(deliveries, [{ agentId: 'b', result: 'taken' }]);
    deepStrictEqual(fake(fakes.get('a')).calls, ['start']);
});
test('names an agent that is not in the fleet', async () => {
    const { supervisor } = supervised('a');
    throws(() => supervisor.restart('nobody'), UnknownAgentError);
    await rejects(supervisor.broadcast('hi', ['a', 'nobody']), UnknownAgentError);
});
test('passes restart, cancel and permission answers to the agent, and stops them all', async () => {
    const { supervisor, fakes } = supervised('a', 'b');
    await supervisor.start();
    fake(fakes.get('a')).askPermission('r1');
    strictEqual(supervisor.answerPermission('a', 'r1', 'yes'), true);
    strictEqual(supervisor.answerPermission('a', 'r1', 'yes'), false);
    await supervisor.cancel('a');
    await supervisor.restart('a');
    await supervisor.stop();
    deepStrictEqual(fake(fakes.get('a')).calls, ['start', 'permission r1 yes', 'permission r1 yes', 'cancel', 'restart', 'stop']);
    deepStrictEqual(fake(fakes.get('b')).calls, ['start', 'stop']);
});
