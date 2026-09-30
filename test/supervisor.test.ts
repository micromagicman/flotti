import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { Supervisor, UnknownAgentError, UnknownGroupError } from '../src/supervisor.js';
import type { SupervisorNotice } from '../src/supervisor.js';
import type { ConnectionHealth } from '../src/connection-health.js';
import type { Delivery } from '../src/dashboard-protocol.js';
import type { Agent, RemoteAgent } from '../src/types.js';
import { FakeFleetAgent, fakeFleet, group } from './fake-fleet-agent.js';
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
test('what an agent says to another agent by "to" is not sent on: agents talk inside groups, and the tab of the sender says so (0.7.0, #171)', async () => {
    const { supervisor, fakes } = supervised('a', 'b');
    await supervisor.start();
    fake(fakes.get('a')).emit({ type: 'message', role: 'agent', messageId: 'm1', text: 'rerun the tests', append: false, to: 'b' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(fake(fakes.get('b')).calls, ['start'], 'a peer gets nothing');
    deepStrictEqual(supervisor.history('a').map((event) => (event.type === 'log' ? event.text : event.type)), [
        'status',
        'message',
        'could not deliver the message to "b": a message to another agent goes through a group; name it in "group"'
    ], 'the sender sees its message, and why it went nowhere');
    fake(fakes.get('a')).emit({ type: 'message', role: 'agent', messageId: 'm2', text: 'rerun the tests', append: false, group: 'everyone' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(fake(fakes.get('b')).calls, ['start', 'send rerun the tests from a'], 'through the group it gets it');
});
test('the answer to a message from another agent goes back to the sender, quoting the message', async () => {
    const { supervisor, fakes } = supervised('a', 'b');
    await supervisor.start();
    await supervisor.send('b', 'rerun the tests', { from: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(fake(fakes.get('a')).calls, ['start', 'send you said: rerun the tests from b']);
    const answer = supervisor.history('a').find((event) => event.type === 'message' && event.role === 'user');
    // The answer has an id of its own in the tab of the receiver: a `reply` of the fleet tools quotes it.
    deepStrictEqual(fake(fakes.get('a')).options, [{
        from: 'b',
        messageId: answer?.type === 'message' ? answer.messageId : undefined,
        replyTo: { agentId: 'b', messageId: 'u-rerun the tests', author: 'a', text: 'rerun the tests' },
        turnAnswer: true
    }]);
    deepStrictEqual(answer?.type === 'message' ? [answer.text, answer.from] : undefined, ['you said: rerun the tests', 'b']);
    deepStrictEqual(fake(fakes.get('b')).calls, ['start', 'send rerun the tests from a'], 'the answer to the answer goes nowhere');
    deepStrictEqual(supervisor.history('b').map((event) => event.type), ['status', 'message', 'message', 'turn-end'], 'the tab of the receiver is as before');
});
test('a message of a person, and an answer flotti sent back, get no answer sent anywhere', async () => {
    const { supervisor, fakes } = supervised('a', 'b');
    await supervisor.start();
    await supervisor.send('b', 'hi');
    await supervisor.send('b', 'thanks', { from: 'a', replyTo: { agentId: 'a', messageId: 'm1', author: 'b', text: 'done' }, turnAnswer: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(fake(fakes.get('a')).calls, ['start']);
});
test('a reply an agent sends itself is a message: the answer to it goes back, and gets none in turn', async () => {
    const { supervisor, fakes } = supervised('a', 'b');
    await supervisor.start();
    await supervisor.send('b', 'which host?', { from: 'a', replyTo: { agentId: 'a', messageId: 'm1', author: 'b', text: 'deploy it' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(fake(fakes.get('a')).calls, ['start', 'send you said: which host? from b']);
    deepStrictEqual(fake(fakes.get('a')).options.map((options) => [options.replyTo?.text, options.turnAnswer]), [['which host?', true]]);
    deepStrictEqual(fake(fakes.get('b')).calls, ['start', 'send which host? from a'], 'the answer to the answer goes nowhere');
});
test('the answer is what the agent said in its messages of the turn; a cancelled turn and progress send nothing', async () => {
    const { supervisor, fakes } = supervised('a', 'b');
    await supervisor.start();
    const b = fake(fakes.get('b'));
    b.emit({ type: 'message', role: 'user', messageId: 'q1', text: 'status?', append: false, from: 'a' });
    b.emit({ type: 'progress', text: 'looking' });
    b.emit({ type: 'message', role: 'agent', messageId: 'r1', text: 'all ', append: false });
    b.emit({ type: 'message', role: 'agent', messageId: 'r1', text: 'green', append: true });
    b.emit({ type: 'message', role: 'agent', messageId: 'r2', text: 'rerun c', append: false, to: 'c' });
    b.emit({ type: 'message', role: 'agent', messageId: 'r3', text: 'the build is ready', append: false });
    b.emit({ type: 'turn-end', reason: 'end_turn' });
    b.emit({ type: 'message', role: 'user', messageId: 'q2', text: 'and now?', append: false, from: 'a' });
    b.emit({ type: 'message', role: 'agent', messageId: 'r4', text: 'wait', append: false });
    b.emit({ type: 'turn-end', reason: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(fake(fakes.get('a')).calls, ['start', 'send all green\n\nthe build is ready from b']);
});
test('an answer that cannot be delivered is a line in the tab of the one who answers', async () => {
    const { fleet, fakes, createAgent } = fakeFleet('a', 'b');
    const supervisor = new Supervisor(fleet, { createAgent });
    await supervisor.start();
    fake(fakes.get('a')).broken = true;
    await supervisor.send('b', 'hi', { from: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const lines = supervisor.history('b').flatMap((event) => event.type === 'log' ? [event.text] : []);
    deepStrictEqual(lines, ['could not deliver the answer to "a": a is broken']);
});
test('a message to another agent by "to" is a line in the tab of the sender, whoever it names (0.7.0, #171)', async () => {
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
        'could not deliver the message to "nobody": a message to another agent goes through a group; name it in "group"',
        'message',
        'could not deliver the message to "a": a message to another agent goes through a group; name it in "group"',
        'message',
        'could not deliver the message to "b": a message to another agent goes through a group; name it in "group"',
        'turn-end'
    ]);
    deepStrictEqual(history.map((event) => event.seq), [2, 3, 4, 5, 6, 7, 8], 'the lines take numbers of their own, and the events after them go on');
    deepStrictEqual(a.calls, ['start'], 'the sender is not sent anything');
});
test('a message by "to" is refused before the groups are asked, to a peer and to an agent out of sight alike (0.7.0, #171)', async () => {
    const { fleet, fakes, createAgent } = fakeFleet('a', 'b', 'c');
    const supervisor = new Supervisor({ ...fleet, groups: [group('pair', ['a', 'b'])] }, { createAgent });
    await supervisor.start();
    const a = fake(fakes.get('a'));
    a.emit({ type: 'message', role: 'agent', messageId: 'm1', text: 'hi', append: false, to: 'c' });
    a.emit({ type: 'message', role: 'agent', messageId: 'm2', text: 'hi', append: false, to: 'b' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(supervisor.history('a').flatMap((event) => (event.type === 'log' ? [event.text] : [])), [
        'could not deliver the message to "c": a message to another agent goes through a group; name it in "group"',
        'could not deliver the message to "b": a message to another agent goes through a group; name it in "group"'
    ], 'the same words: the agent learns nothing of who is out of sight');
    deepStrictEqual(fake(fakes.get('c')).calls, ['start'], 'the agent out of sight gets nothing');
    deepStrictEqual(fake(fakes.get('b')).calls, ['start'], 'nor does a peer');
    ok(supervisor.canReach('a', 'b') && !supervisor.canReach('a', 'c') && !supervisor.canReach('c', 'a'));
});
test('the answer at the end of a turn goes back even when the two no longer share a group; a new message does not', async () => {
    const { fleet, fakes, createAgent } = fakeFleet('a', 'b');
    const supervisor = new Supervisor(fleet, { createAgent });
    await supervisor.start();
    const b = fake(fakes.get('b'));
    b.slow = true;
    await supervisor.send('b', 'rerun the tests', { from: 'a' });
    supervisor.replaceGroup(group('everyone', ['a']));
    b.finish('all green');
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(fake(fakes.get('a')).calls, ['start', 'send all green from b'], 'the exchange was allowed on its way in');
    b.emit({ type: 'message', role: 'agent', messageId: 'm1', text: 'one more thing', append: false, to: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(fake(fakes.get('a')).calls, ['start', 'send all green from b'], 'a message on purpose is a new exchange');
    deepStrictEqual(supervisor.history('b').flatMap((event) => (event.type === 'log' ? [event.text] : [])), [
        'could not deliver the message to "a": a message to another agent goes through a group; name it in "group"'
    ]);
});
test('peers and groupsOf: what an agent sees of the fleet, and nothing for an agent in no group with anyone', async () => {
    const { fleet, createAgent } = fakeFleet('eva', 'loner', 'reviewer', 'writer');
    const groups = [group('docs', ['writer', 'eva']), group('release', ['eva', 'reviewer', 'gone'], { name: 'Release', topic: 'Ship it.' })];
    const supervisor = new Supervisor({ ...fleet, groups }, { createAgent });
    await supervisor.start();
    deepStrictEqual(supervisor.peers('eva').map((agent) => [agent.id, agent.groups]), [['eva', ['docs', 'release']], ['reviewer', ['release']], ['writer', ['docs']]]);
    deepStrictEqual(supervisor.peers('writer').map((agent) => [agent.id, agent.groups]), [['eva', ['docs']], ['writer', ['docs']]]);
    deepStrictEqual(supervisor.peers('loner'), [], 'in no group: not even itself, so the fleet is not taken for empty');
    supervisor.addGroup(group('solo', ['loner']));
    deepStrictEqual(supervisor.peers('loner'), [], 'alone in a group: the same');
    deepStrictEqual(supervisor.groupsOf('eva'), [
        { id: 'docs', name: 'docs', members: [{ id: 'writer', name: 'WRITER' }, { id: 'eva', name: 'EVA' }] },
        { id: 'release', name: 'Release', topic: 'Ship it.', members: [{ id: 'eva', name: 'EVA' }, { id: 'reviewer', name: 'REVIEWER' }] }
    ], 'a member not in the fleet is not listed to the agents');
    deepStrictEqual(supervisor.groupsOf('reviewer').map((found) => found.id), ['release']);
});
test('passes on the health of a connection, in the summary and as it changes', () => {
    const { fleet, fakes, createAgent } = fakeFleet('relay', 'plain');
    let current: ConnectionHealth = { reconnects: 0, reconnectsLastHour: 0, poor: [] };
    const listeners = new Set<(health: ConnectionHealth) => void>();
    const relay = fake(fakes.get('relay'));
    Object.defineProperty(relay, 'health', { get: () => current });
    Object.assign(relay, {
        onHealth(listener: (health: ConnectionHealth) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    });
    const supervisor = new Supervisor(fleet, { createAgent });
    const notices: SupervisorNotice[] = [];
    supervisor.subscribe((notice) => notices.push(notice));
    deepStrictEqual(supervisor.agents().map((agent) => [agent.id, agent.health]), [['plain', undefined], ['relay', current]]);
    current = { latencyMs: 20, reconnects: 1, reconnectsLastHour: 1, poor: [] };
    for (const listener of listeners) {
        listener(current);
    }
    deepStrictEqual(notices, [{ type: 'health', agentId: 'relay', health: current }]);
    deepStrictEqual(supervisor.agents()[1]?.health, current);
    deepStrictEqual(supervisor.history('relay'), [], 'the health is not kept in the history');
});
test('stops listening to the health of an agent that is removed', async () => {
    const { fleet, fakes, createAgent } = fakeFleet('relay');
    const listeners = new Set<(health: ConnectionHealth) => void>();
    Object.assign(fake(fakes.get('relay')), {
        onHealth(listener: (health: ConnectionHealth) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    });
    const supervisor = new Supervisor(fleet, { createAgent });
    strictEqual(listeners.size, 1);
    await supervisor.remove('relay');
    strictEqual(listeners.size, 0);
});
test('a broadcast to busy agents puts the message in line in the tab of each', async () => {
    const { supervisor, fakes } = supervised('a', 'b');
    await supervisor.start();
    fake(fakes.get('a')).busy = true;
    fake(fakes.get('b')).busy = true;
    await supervisor.broadcast('hello');
    for (const id of ['a', 'b']) {
        const queued = supervisor.history(id).flatMap((event) => (event.type === 'queued' ? [event.text] : []));
        deepStrictEqual(queued, ['hello'], `in line for ${id}`);
    }
});
test('a message is taken back out of the line: the tab says so, and the late delivery says it failed', async () => {
    const { supervisor, fakes, notices } = supervised('a');
    await supervisor.start();
    fake(fakes.get('a')).busy = true;
    deepStrictEqual(await supervisor.send('a', 'wait for me', { messageId: 'q-1' }), { agentId: 'a', result: 'queued' });
    strictEqual(supervisor.withdraw('a', 'q-1'), true);
    strictEqual(supervisor.withdraw('a', 'q-1'), false, 'it is not in line any more');
    throws(() => supervisor.withdraw('nobody', 'q-1'), UnknownAgentError);
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(supervisor.history('a').flatMap((event) => (event.type === 'unqueued' ? [event.outcome] : [])), ['withdrawn']);
    deepStrictEqual(notices.filter((notice) => notice.type === 'delivery'), [
        { type: 'delivery', delivery: { agentId: 'a', result: 'failed', error: 'the message was taken out of the line' } }
    ]);
});
test('a message sent again names the one it replaces, in its events', async () => {
    const { supervisor, fakes } = supervised('a');
    await supervisor.start();
    await supervisor.send('a', 'once more', { retryOf: 'lost-1' });
    deepStrictEqual(fake(fakes.get('a')).options.map((options) => options.retryOf), ['lost-1']);
    const message = supervisor.history('a').find((event) => event.type === 'message' && event.role === 'user');
    strictEqual(message?.type === 'message' ? message.retryOf : undefined, 'lost-1');
});
/** Waits for the condition, a little at a time; fails once two seconds are up. */
async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('the condition did not come true in time');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
/** The lines of the group as `[from, text, turnAnswer]`. */
function lines(supervisor: Supervisor, groupId: string): [string | undefined, string, true | undefined][] {
    return supervisor.groupHistory(groupId).map((message) => [message.from, message.text, message.turnAnswer]);
}
test('a message of a person to a group reaches every member on its own, and is one line of the history with how each took it (docs/groups.md)', async () => {
    const { supervisor, fakes, notices } = supervised('a', 'b', 'c', 'd');
    await supervisor.start();
    fake(fakes.get('c')).busy = true;
    fake(fakes.get('d')).broken = true;
    const posted = await supervisor.sendToGroup('everyone', 'hello');
    deepStrictEqual(posted.deliveries, [
        { agentId: 'a', result: 'taken' },
        { agentId: 'b', result: 'taken' },
        { agentId: 'c', result: 'queued' },
        { agentId: 'd', result: 'failed', error: 'd is broken' }
    ]);
    deepStrictEqual([posted.groupId, posted.seq, posted.from, posted.text, posted.turnAnswer], ['everyone', 1, undefined, 'hello', undefined]);
    ok(posted.messageId !== '' && typeof posted.time === 'string');
    const got = supervisor.history('a').find((event) => event.type === 'message' && event.role === 'user');
    deepStrictEqual(got?.type === 'message' ? [got.text, got.from, got.group] : undefined, ['hello', undefined, 'everyone'], 'the tab of a member shows the group');
    deepStrictEqual(fake(fakes.get('a')).options.map((options) => [options.group, options.from]), [['everyone', undefined]]);
    deepStrictEqual(notices.find((notice) => notice.type === 'group-message'), { type: 'group-message', message: posted });
    throws(() => supervisor.groupHistory('nowhere'), UnknownGroupError);
    await rejects(supervisor.sendToGroup('nowhere', 'hi'), UnknownGroupError);
});
/** The deliveries of the line numbered `seq` as every `group-message` notice of the socket showed them, in order. */
function noticedDeliveries(notices: readonly SupervisorNotice[], seq: number): Delivery[][] {
    return notices.flatMap((notice) => (notice.type === 'group-message' && notice.message.seq === seq ? [[...notice.message.deliveries]] : []));
}
test('a member in line for a group message: the line of the history and the socket learn how it ended — taken, or failed with why (#162)', async () => {
    const { supervisor, fakes, notices } = supervised('a', 'b', 'c');
    await supervisor.start();
    const b = fake(fakes.get('b'));
    const c = fake(fakes.get('c'));
    b.busy = true;
    c.busy = true;
    const posted = await supervisor.sendToGroup('everyone', 'hello');
    deepStrictEqual(posted.deliveries, [{ agentId: 'a', result: 'taken' }, { agentId: 'b', result: 'queued' }, { agentId: 'c', result: 'queued' }]);
    b.release();
    await until(() => supervisor.groupHistory('everyone')[0]?.deliveries[1]?.result === 'taken');
    const taken: Delivery[] = [{ agentId: 'a', result: 'taken' }, { agentId: 'b', result: 'taken' }, { agentId: 'c', result: 'queued' }];
    deepStrictEqual(supervisor.groupHistory('everyone')[0]?.deliveries, taken, 'the line says b took it; a, taken at once, is as it was');
    deepStrictEqual(noticedDeliveries(notices, 1), [posted.deliveries, taken], 'the line went out again with the outcome');
    deepStrictEqual(notices.filter((notice) => notice.type === 'delivery').map((notice) => notice.delivery), [{ agentId: 'b', result: 'taken' }], 'the notice of the agent is as before');
    const inLineForC = c.options[0]?.messageId ?? '';
    strictEqual(supervisor.withdraw('c', inLineForC), true);
    await until(() => supervisor.groupHistory('everyone')[0]?.deliveries[2]?.result === 'failed');
    const failedC: Delivery = { agentId: 'c', result: 'failed', error: 'the message was taken out of the line' };
    deepStrictEqual(supervisor.groupHistory('everyone')[0]?.deliveries[2], failedC, 'the line says why c never got it');
    deepStrictEqual(noticedDeliveries(notices, 1).at(-1), [taken[0], taken[1], failedC]);
    strictEqual(noticedDeliveries(notices, 1).length, 3, 'one notice per outcome, and none for the member that took it at once');
    ok(supervisor.groupHistory('everyone').every((message) => message.seq !== 1 || message.messageId === posted.messageId), 'the line is corrected, not added');
});
test('what a member answers to a group message is posted to the group once, as an answer, and the turns on it post nothing back', async () => {
    const { supervisor, fakes } = supervised('a', 'b', 'c');
    await supervisor.start();
    fake(fakes.get('c')).busy = true;
    await supervisor.sendToGroup('everyone', 'hello');
    await until(() => supervisor.groupHistory('everyone').length === 3);
    deepStrictEqual(lines(supervisor, 'everyone'), [
        [undefined, 'hello', undefined],
        ['a', 'you said: hello', true],
        ['b', 'you said: hello', true]
    ]);
    const a = fake(fakes.get('a'));
    deepStrictEqual(a.calls, ['start', 'send hello', 'send you said: hello from b'], 'the answer of b reaches a once; a answers it in its tab and posts nothing');
    deepStrictEqual(fake(fakes.get('b')).calls, ['start', 'send hello', 'send you said: hello from a']);
    const answer = a.options[1];
    const inTabOfB = fake(fakes.get('b')).options[0]?.messageId;
    ok(inTabOfB !== undefined && inTabOfB !== a.options[0]?.messageId, 'each member got the message under a messageId of its own tab');
    deepStrictEqual([answer?.from, answer?.group, answer?.turnAnswer, answer?.replyTo], ['b', 'everyone', true, { agentId: 'b', messageId: inTabOfB, text: 'hello' }]);
    deepStrictEqual(supervisor.groupHistory('everyone')[1]?.deliveries, [
        { agentId: 'b', result: 'taken' },
        { agentId: 'c', result: 'queued' }
    ], 'the answer is delivered to the other members, not to the one who answered');
    deepStrictEqual(supervisor.groupHistory('everyone', 2).map((message) => message.seq), [3], 'the history is asked for after a number');
});
test('what an agent says to a group goes to every other member, from the sender, and the fleet tools are told of each that took it', async () => {
    const told: string[] = [];
    const { fleet, fakes, createAgent } = fakeFleet('a', 'b', 'c');
    const supervisor = new Supervisor(fleet, { createAgent, fleetTools: { access: () => ({ port: 0, token: '' }), delivered: (message) => told.push(`${message.from} -> ${message.to} in ${message.group ?? '-'}`) } });
    await supervisor.start();
    const a = fake(fakes.get('a'));
    a.emit({ type: 'message', role: 'agent', messageId: 'm1', text: 'ship it', append: false, group: 'everyone' });
    await until(() => supervisor.groupHistory('everyone').length === 3);
    deepStrictEqual(lines(supervisor, 'everyone'), [['a', 'ship it', undefined], ['b', 'you said: ship it', true], ['c', 'you said: ship it', true]]);
    deepStrictEqual(fake(fakes.get('b')).calls, ['start', 'send ship it from a', 'send you said: ship it from c']);
    deepStrictEqual(fake(fakes.get('b')).options[0]?.group, 'everyone');
    deepStrictEqual(a.calls, ['start', 'send you said: ship it from b', 'send you said: ship it from c'], 'the sender gets the answers, not its own message');
    deepStrictEqual(told.sort(), ['a -> b in everyone', 'a -> c in everyone', 'b -> a in everyone', 'b -> c in everyone', 'c -> a in everyone', 'c -> b in everyone']);
});
test('a message to a group the agent is not in, or to no group, is a line in the tab of the sender saying why; the tools are told the real reason', async () => {
    const { fleet, fakes, createAgent } = fakeFleet('a', 'b', 'c');
    const supervisor = new Supervisor({ ...fleet, groups: [group('pair', ['a', 'b'])] }, { createAgent });
    await supervisor.start();
    const c = fake(fakes.get('c'));
    c.emit({ type: 'message', role: 'agent', messageId: 'm1', text: 'hi', append: false, group: 'pair' });
    c.emit({ type: 'message', role: 'agent', messageId: 'm2', text: 'hi', append: false, group: 'nowhere' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    deepStrictEqual(supervisor.history('c').flatMap((event) => (event.type === 'log' ? [event.text] : [])), [
        'could not post the message to group "pair": "c" is not in group "pair"',
        'could not post the message to group "nowhere": there is no such group in the fleet'
    ]);
    deepStrictEqual(fake(fakes.get('a')).calls, ['start'], 'the members get nothing');
    deepStrictEqual(supervisor.groupHistory('pair'), []);
    ok(supervisor.mayPost('a', 'pair') && !supervisor.mayPost('c', 'pair') && !supervisor.mayPost('a', 'nowhere'));
    deepStrictEqual(supervisor.history('c').filter((event) => event.type === 'log').length, 3, 'mayPost says why in the tab, as mayWrite does; an unknown group says nothing');
});
test('a group made again in one run numbers its messages on; the numbers of another fleet start anew', async () => {
    const { supervisor, fakes } = supervised('a', 'b');
    await supervisor.start();
    fake(fakes.get('b')).slow = true;
    fake(fakes.get('a')).slow = true;
    strictEqual((await supervisor.sendToGroup('everyone', 'one')).seq, 1);
    supervisor.removeGroup('everyone');
    supervisor.addGroup(group('everyone', ['a', 'b']));
    deepStrictEqual(supervisor.groupHistory('everyone'), [], 'the messages of the group that went are not the new group\'s');
    strictEqual((await supervisor.sendToGroup('everyone', 'two')).seq, 2, 'a page that saw 1 is not shown a second 1');
});
