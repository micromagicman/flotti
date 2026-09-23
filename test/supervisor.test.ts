import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { Supervisor, UnknownAgentError } from '../src/supervisor.js';
import type { SupervisorNotice } from '../src/supervisor.js';
import { FakeFleetAgent, fakeFleet } from './fake-fleet-agent.js';
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
test('an agent added, removed, stopped and started while the fleet runs; every change of the fleet is announced', async () => {
    const { supervisor, fakes, notices } = supervised('a', 'b');
    await supervisor.start();
    const fleets = (): string[][] => notices.flatMap((notice) => (notice.type === 'fleet' ? [notice.agents.map((agent) => agent.id)] : []));
    const b = supervisor.agent('b');
    await supervisor.remove('b');
    deepStrictEqual(supervisor.agents().map((agent) => agent.id), ['a']);
    deepStrictEqual(fake(fakes.get('b')).calls, ['start', 'stop']);
    fakes.set('b', new FakeFleetAgent('b'));
    supervisor.add(b);
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(supervisor.agents().map((agent) => [agent.id, agent.status]), [['a', 'idle'], ['b', 'idle']]);
    throws(() => supervisor.add(b), /already/);
    await supervisor.stopAgent('a');
    strictEqual(supervisor.agents()[0]?.status, 'stopped');
    await supervisor.startAgent('a');
    strictEqual(supervisor.agents()[0]?.status, 'idle');
    deepStrictEqual(fleets(), [['a'], ['a', 'b']]);
});
test('a changed agent keeps its history, and the numbers of its events go on growing', async () => {
    const { fleet, fakes, createAgent } = fakeFleet('a');
    const supervisor = new Supervisor(fleet, { createAgent });
    await supervisor.start();
    await supervisor.send('a', 'one');
    deepStrictEqual(supervisor.history('a').map((event) => event.seq), [1, 2, 3, 4]);
    const first = fake(fakes.get('a'));
    fakes.set('a', new FakeFleetAgent('a'));
    await supervisor.replace({ ...supervisor.agent('a'), name: 'Changed' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(first.calls, ['start', 'send one', 'stop']);
    deepStrictEqual(fake(fakes.get('a')).calls, ['start'], 'a running agent runs on with the new manifest');
    strictEqual(supervisor.agents()[0]?.name, 'Changed');
    deepStrictEqual(supervisor.history('a').map((event) => event.seq), [1, 2, 3, 4, 5, 6]);
    deepStrictEqual(supervisor.history('a', 5).map((event) => event.type === 'status' && event.status), ['idle']);
});
test('another fleet: the old agents stop, the new ones start', async () => {
    const { supervisor, fakes, notices } = supervised('a');
    await supervisor.start();
    const next = fakeFleet('x');
    fakes.set('x', fake(next.fakes.get('x')));
    await supervisor.load(next.fleet);
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(fake(fakes.get('a')).calls, ['start', 'stop']);
    deepStrictEqual(supervisor.agents().map((agent) => [agent.id, agent.status]), [['x', 'idle']]);
    deepStrictEqual(notices.filter((notice) => notice.type === 'fleet').length, 1);
});
