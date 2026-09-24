import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { Supervisor, UnknownAgentError } from '../src/supervisor.js';
import type { SupervisorNotice } from '../src/supervisor.js';
import type { Agent, RemoteAgent } from '../src/types.js';
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
test('names the harness of an agent only where the manifest tells it', () => {
    const { fleet, createAgent } = fakeFleet('claude', 'codex', 'plain', 'eva');
    const [claude, codex, plain, eva] = fleet.agents.map((agent) => fake(agent.kind === 'local' ? agent : undefined));
    const remote: RemoteAgent = {
        kind: 'remote',
        id: fake(eva).id,
        name: fake(eva).name,
        directory: '/fleet/remote/eva',
        manifestPath: '/fleet/remote/eva/agent.json',
        protocol: 'a2a',
        url: 'https://eva.example.org/a2a',
        auth: { type: 'none' }
    };
    const agents: Agent[] = [
        { ...fake(claude), adapter: 'claude-code' },
        { ...fake(codex), adapter: 'codex' },
        fake(plain),
        remote
    ];
    const supervisor = new Supervisor({ ...fleet, agents }, { createAgent });
    deepStrictEqual(supervisor.agents().map((agent) => [agent.id, agent.harness]), [
        ['claude', 'claude'],
        ['codex', 'codex'],
        ['plain', undefined],
        ['eva', undefined]
    ]);
    deepStrictEqual(Object.keys(supervisor.agents()[2] ?? {}).includes('harness'), false, 'an unknown harness is left out, not guessed');
});
/** A remote agent of the fleet reached at a plain address, for the agent of that id. */
function remoteAgent(id: string): RemoteAgent {
    return {
        kind: 'remote',
        id,
        name: id.toUpperCase(),
        directory: `/fleet/remote/${id}`,
        manifestPath: `/fleet/remote/${id}/agent.json`,
        protocol: 'a2a',
        url: `https://${id}.example.org/a2a`,
        auth: { type: 'none' }
    };
}
test('names the harness a remote agent tells of itself, as it is, and announces it', async () => {
    const { fleet, fakes, createAgent } = fakeFleet('worker', 'helper', 'silent');
    const supervisor = new Supervisor({ ...fleet, agents: ['worker', 'helper', 'silent'].map(remoteAgent) }, { createAgent });
    const notices: SupervisorNotice[] = [];
    supervisor.subscribe((notice) => notices.push(notice));
    fake(fakes.get('worker')).harness = 'codex';
    fake(fakes.get('helper')).harness = 'home-made';
    deepStrictEqual(supervisor.agents().map((agent) => agent.harness), ['home-made', undefined, 'codex']);
    await supervisor.start();
    const fleets = notices.flatMap((notice) => notice.type === 'fleet' ? [notice.agents] : []);
    deepStrictEqual(fleets.length, 2, 'the fleet is announced once per agent whose harness became known');
    deepStrictEqual(fleets.at(-1)?.map((agent) => [agent.id, agent.harness]), [
        ['helper', 'home-made'],
        ['silent', undefined],
        ['worker', 'codex']
    ]);
    deepStrictEqual(Object.keys(supervisor.agents()[1] ?? {}).includes('harness'), false, 'an agent that says nothing has no harness');
    await supervisor.restart('worker');
    strictEqual(notices.filter((notice) => notice.type === 'fleet').length, 2, 'an unchanged harness is not announced again');
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
test('a message from another agent goes where a message of a person goes, and says who sent it', async () => {
    const { supervisor, fakes } = supervised('a', 'b');
    await supervisor.start();
    deepStrictEqual(await supervisor.send('b', 'rerun the tests', { from: 'a' }), { agentId: 'b', result: 'taken' });
    deepStrictEqual(fake(fakes.get('b')).calls, ['start', 'send rerun the tests from a']);
    const message = supervisor.history('b').find((event) => event.type === 'message' && event.role === 'user');
    strictEqual(message?.type === 'message' ? message.from : undefined, 'a');
    throws(() => supervisor.send('b', 'hi', { from: 'nobody' }), UnknownAgentError);
});
test('what an agent says to another agent is sent on to it, from the sender', async () => {
    const { supervisor, fakes } = supervised('a', 'b');
    await supervisor.start();
    fake(fakes.get('a')).emit({ type: 'message', role: 'agent', messageId: 'm1', text: 'rerun the tests', append: false, to: 'b' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(fake(fakes.get('b')).calls, ['start', 'send rerun the tests from a']);
    const received = supervisor.history('b').find((event) => event.type === 'message' && event.role === 'user');
    deepStrictEqual(received?.type === 'message' ? [received.text, received.from] : undefined, ['rerun the tests', 'a']);
    deepStrictEqual(supervisor.history('a').map((event) => event.type), ['status', 'message'], 'the sender sees its message, and nothing else');
});
test('a message to another agent that cannot be delivered is a line in the tab of the sender', async () => {
    const { fleet, fakes, createAgent } = fakeFleet('a', 'b');
    const supervisor = new Supervisor(fleet, { createAgent });
    await supervisor.start();
    fake(fakes.get('b')).broken = true;
    const a = fake(fakes.get('a'));
    a.emit({ type: 'message', role: 'agent', messageId: 'm1', text: 'hi', append: false, to: 'nobody' });
    a.emit({ type: 'message', role: 'agent', messageId: 'm2', text: 'hi', append: false, to: 'a' });
    a.emit({ type: 'message', role: 'agent', messageId: 'm3', text: 'hi', append: false, to: 'b' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    a.emit({ type: 'turn-end', reason: 'end_turn' });
    const history = supervisor.history('a', 1);
    deepStrictEqual(history.map((event) => (event.type === 'log' ? event.text : event.type)), [
        'message',
        'could not deliver the message to "nobody": there is no such agent in the fleet',
        'message',
        'could not deliver the message to "a": an agent does not send messages to itself',
        'message',
        'could not deliver the message to "b": b is broken',
        'turn-end'
    ]);
    deepStrictEqual(history.map((event) => event.seq), [2, 3, 4, 5, 6, 7, 8], 'the lines take numbers of their own, and the events after them go on');
    deepStrictEqual(a.calls, ['start'], 'the sender is not sent anything');
});
