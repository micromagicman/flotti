/**
 * The rule of #157 — an answer reaches the tab piece by piece or whole — is
 * applied in the supervisor, on the way of every event to the history and the
 * pages, for every agent alike: a fleet of fakes emitting pieces, the pretend
 * ACP agent streaming chunks as a child process, the pretend A2A server
 * streaming an artifact.
 */
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { TaskState } from '@a2a-js/sdk';
import { A2AAgent } from '../src/a2a-agent.js';
import type { AgentEvent } from '../src/agent-events.js';
import type { AnswerDelivery } from '../src/answer-delivery.js';
import { Supervisor } from '../src/supervisor.js';
import type { SupervisorNotice } from '../src/supervisor.js';
import type { Agent, Fleet, RemoteAgent } from '../src/types.js';
import { FakeAgent, artifact, statusUpdate, task } from './a2a-fake-server.js';
import { FakeFleetAgent, fakeFleet } from './fake-fleet-agent.js';
import { Harness, eventually, workspace } from './local-agent-helpers.js';
/** The rule as a fleet of fakes sees it, with the choice changeable at any moment. */
function supervised(mode: AnswerDelivery, ...ids: string[]) {
    const { fleet, fakes, createAgent } = fakeFleet(...ids);
    const choice = { mode };
    const supervisor = new Supervisor(fleet, { createAgent, queuedAfterMs: 50, answerDelivery: () => choice.mode });
    const notices: SupervisorNotice[] = [];
    supervisor.subscribe((notice) => notices.push(notice));
    const fake = (id: string): FakeFleetAgent => {
        const found = fakes.get(id);
        if (found === undefined) {
            throw new Error(`no fake ${id}`);
        }
        return found;
    };
    return { supervisor, fake, notices, choice };
}
/** The events the pages were told, as they came. */
function told(notices: readonly SupervisorNotice[]): AgentEvent[] {
    return notices.flatMap((notice) => notice.type === 'event' ? [notice.event] : []);
}
/** The messages of the agent among the events: what was said, and whether it added to the message before. */
function answers(events: readonly AgentEvent[]): { text: string; append: boolean; messageId: string }[] {
    return events.flatMap((event) => event.type === 'message' && event.role === 'agent'
        ? [{ text: event.text, append: event.append, messageId: event.messageId }]
        : []);
}
/** The kinds of the events, in order, with the text of a message. */
function shape(events: readonly AgentEvent[]): string[] {
    return events.map((event) => event.type === 'message' ? `${event.type}:${event.role}:${event.text}` : event.type);
}
/** A turn of a fake agent: the message it takes, the pieces of its answer, the end. */
function turn(fake: FakeFleetAgent, question: string, pieces: readonly string[], between: () => void = () => undefined): void {
    fake.emit({ type: 'message', role: 'user', messageId: `q-${question}`, text: question, append: false });
    pieces.forEach((piece, index) => {
        fake.emit({ type: 'message', role: 'agent', messageId: `a-${question}`, text: piece, append: index > 0 });
        if (index === 0) {
            between();
        }
    });
    fake.emit({ type: 'turn-end', reason: 'end_turn' });
}
describe('answer delivery: the rule in the supervisor, one message at a time', () => {
    it('streamed: every piece reaches the tab as it comes, growing the message in place', async () => {
        const { supervisor, fake, notices } = supervised('streamed', 'a');
        await supervisor.start();
        turn(fake('a'), 'status?', ['all ', 'green']);
        deepStrictEqual(answers(told(notices)), [
            { text: 'all ', append: false, messageId: 'a-status?' },
            { text: 'green', append: true, messageId: 'a-status?' }
        ]);
        deepStrictEqual(answers(supervisor.history('a')), answers(told(notices)), 'the history keeps what the tab got');
    });
    it('whole: the pieces reach the tab as one message, when the turn is over, and nothing partial before', async () => {
        const { supervisor, fake, notices } = supervised('whole', 'a');
        await supervisor.start();
        fake('a').emit({ type: 'message', role: 'user', messageId: 'q', text: 'status?', append: false });
        fake('a').emit({ type: 'message', role: 'agent', messageId: 'r', text: 'all ', append: false });
        fake('a').emit({ type: 'message', role: 'agent', messageId: 'r', text: 'green', append: true });
        deepStrictEqual(answers(told(notices)), [], 'nothing of the answer yet');
        fake('a').emit({ type: 'turn-end', reason: 'end_turn' });
        deepStrictEqual(answers(told(notices)), [{ text: 'all green', append: false, messageId: 'r' }]);
        deepStrictEqual(shape(supervisor.history('a')), ['status', 'message:user:status?', 'message:agent:all green', 'turn-end']);
        const numbers = supervisor.history('a').map((event) => event.seq);
        deepStrictEqual(numbers, [...numbers].sort((left, right) => left - right), 'the numbers keep growing');
        strictEqual(new Set(numbers).size, numbers.length, 'and no two are the same');
    });
    it('whole: a new message of the turn lets the one before go; a piece that starts over replaces what was held', async () => {
        const { supervisor, fake, notices } = supervised('whole', 'a');
        await supervisor.start();
        const a = fake('a');
        a.emit({ type: 'message', role: 'user', messageId: 'q', text: 'go', append: false });
        a.emit({ type: 'message', role: 'agent', messageId: 'r1', text: 'first ', append: false });
        a.emit({ type: 'message', role: 'agent', messageId: 'r1', text: 'draft', append: true });
        a.emit({ type: 'message', role: 'agent', messageId: 'r1', text: 'first, again', append: false });
        a.emit({ type: 'message', role: 'agent', messageId: 'r2', text: 'second', append: false });
        deepStrictEqual(answers(told(notices)), [{ text: 'first, again', append: false, messageId: 'r1' }]);
        a.emit({ type: 'turn-end', reason: 'end_turn' });
        deepStrictEqual(answers(told(notices)).map((answer) => answer.text), ['first, again', 'second']);
    });
});
describe('answer delivery: what is not held, and the choice taken per message', () => {
    it('whole: what happens between the pieces — a tool call, a thought — goes on at once, and the message follows it', async () => {
        const { supervisor, fake, notices } = supervised('whole', 'a');
        await supervisor.start();
        turn(fake('a'), 'go', ['let me ', 'see'], () => {
            fake('a').emit({ type: 'tool-call', toolCallId: 'c1', title: 'Look', status: 'completed' });
            fake('a').emit({ type: 'thought', text: 'hm' });
        });
        deepStrictEqual(shape(told(notices)), ['status', 'message:user:go', 'tool-call', 'thought', 'message:agent:let me see', 'turn-end']);
    });
    it('whole: an agent that stops in the middle of a message leaves what came of it, as the message', async () => {
        const { supervisor, fake, notices } = supervised('whole', 'a');
        await supervisor.start();
        fake('a').emit({ type: 'message', role: 'user', messageId: 'q', text: 'go', append: false });
        fake('a').emit({ type: 'message', role: 'agent', messageId: 'r', text: 'half', append: false });
        await supervisor.stopAgent('a');
        deepStrictEqual(shape(told(notices)), ['status', 'message:user:go', 'message:agent:half', 'status']);
    });
    it('whole: what an agent says outside a turn has no end to wait for, and goes on as it comes', async () => {
        const { supervisor, fake, notices } = supervised('whole', 'a');
        await supervisor.start();
        fake('a').emit({ type: 'message', role: 'agent', messageId: 'own', text: 'CI is ', append: false });
        fake('a').emit({ type: 'message', role: 'agent', messageId: 'own', text: 'green', append: true });
        deepStrictEqual(answers(told(notices)).map((answer) => answer.text), ['CI is ', 'green']);
    });
    it('the choice holds for the next message, with no restart: a change in the middle of a message does not tear it', async () => {
        const { supervisor, fake, notices, choice } = supervised('whole', 'a');
        await supervisor.start();
        const a = fake('a');
        a.emit({ type: 'message', role: 'user', messageId: 'q1', text: 'one', append: false });
        a.emit({ type: 'message', role: 'agent', messageId: 'r1', text: 'held ', append: false });
        choice.mode = 'streamed';
        a.emit({ type: 'message', role: 'agent', messageId: 'r1', text: 'still', append: true });
        a.emit({ type: 'turn-end', reason: 'end_turn' });
        turn(a, 'two', ['now ', 'streamed']);
        choice.mode = 'whole';
        turn(a, 'three', ['whole ', 'again']);
        deepStrictEqual(answers(told(notices)), [
            { text: 'held still', append: false, messageId: 'r1' },
            { text: 'now ', append: false, messageId: 'a-two' },
            { text: 'streamed', append: true, messageId: 'a-two' },
            { text: 'whole again', append: false, messageId: 'a-three' }
        ]);
        deepStrictEqual(a.calls.filter((call) => call === 'start'), ['start'], 'started once');
    });
});
describe('answer delivery: what agents say to one another', () => {
    it('what an agent says to its group reaches the other members, whatever the rule; its tab shows it before what came back', async () => {
        const { supervisor, fake, notices } = supervised('whole', 'a', 'b');
        await supervisor.start();
        fake('a').emit({ type: 'message', role: 'user', messageId: 'q', text: 'go', append: false });
        fake('a').emit({ type: 'message', role: 'agent', messageId: 'r1', text: 'rerun the tests', append: false, group: 'everyone' });
        await eventually(() => told(notices).filter((event) => event.agentId === 'a').length >= 4);
        deepStrictEqual(fake('b').calls.filter((call) => call.startsWith('send')), ['send rerun the tests from a'], 'b has it');
        // b answered at once, and the answer came back to a through the group as a message it got: after what a said, not before.
        deepStrictEqual(shape(told(notices).filter((event) => event.agentId === 'a')).slice(0, 4), [
            'status', 'message:user:go', 'message:agent:rerun the tests', 'message:user:you said: rerun the tests'
        ]);
    });
});
/** A fleet of one agent, whatever runs it, under the rule with the choice given. */
function fleetOf(agent: Agent, running: () => A2AAgent | Harness['agent'], mode: () => AnswerDelivery) {
    const fleet: Fleet = { location: { path: workspace, source: 'argument' }, exists: true, agents: [agent], groups: [] };
    const supervisor = new Supervisor(fleet, { createAgent: running, answerDelivery: mode, queuedAfterMs: 50 });
    const notices: SupervisorNotice[] = [];
    supervisor.subscribe((notice) => notices.push(notice));
    const turnEnds = () => told(notices).filter((event) => event.type === 'turn-end').length;
    return { supervisor, notices, turnEnds };
}
const remotes: FakeAgent[] = [];
after(() => Promise.all(remotes.map((remote) => remote.close())));
/** An A2A agent that answers `hi` with an artifact in two pieces. */
async function remote(): Promise<RemoteAgent> {
    const fake = await new FakeAgent({
        script: async (context, bus) => {
            bus.publish(task(context, TaskState.TASK_STATE_WORKING));
            bus.publish(artifact(context, 'a1', 'Hello', false));
            bus.publish(artifact(context, 'a1', ', world', true));
            bus.publish(statusUpdate(context.taskId, context.contextId, TaskState.TASK_STATE_COMPLETED));
            bus.finished();
        }
    }).listen();
    remotes.push(fake);
    return {
        kind: 'remote',
        id: 'remote',
        name: 'Remote',
        directory: '/fleet/remote/remote',
        manifestPath: '/fleet/remote/remote/agent.json',
        protocol: 'a2a',
        url: fake.url,
        auth: { type: 'none' }
    };
}
describe('answer delivery: the same rule for the chunks of ACP and the artifacts of A2A', () => {
    it('ACP chunks: one message in the tab when whole, pieces when streamed, the choice taken per message', async (t) => {
        const harness = new Harness();
        const choice: { mode: AnswerDelivery } = { mode: 'whole' };
        const { supervisor, notices, turnEnds } = fleetOf(harness.manifest, () => harness.agent, () => choice.mode);
        t.after(() => supervisor.stop());
        await supervisor.start();
        await supervisor.send(harness.manifest.id, 'stream');
        await eventually(() => turnEnds() === 1);
        deepStrictEqual(answers(told(notices)).map(({ text, append }) => [text, append]), [['one two', false]]);
        choice.mode = 'streamed';
        await supervisor.send(harness.manifest.id, 'stream');
        await eventually(() => turnEnds() === 2);
        deepStrictEqual(answers(told(notices)).map(({ text, append }) => [text, append]), [['one two', false], ['one ', false], ['two', true]]);
        strictEqual(harness.recorded('started').length, 1, 'the agent was not restarted for the change');
    });
    it('A2A artifacts: one message in the tab when whole, pieces when streamed, the choice taken per message', async (t) => {
        const agent = await remote();
        const choice: { mode: AnswerDelivery } = { mode: 'whole' };
        const running = new A2AAgent(agent, { reconnectDelayMs: 10, pollIntervalMs: 10, restartTimeoutMs: 2_000 });
        const { supervisor, notices, turnEnds } = fleetOf(agent, () => running, () => choice.mode);
        t.after(() => supervisor.stop());
        await supervisor.start();
        await supervisor.send('remote', 'hi');
        await eventually(() => turnEnds() === 1);
        deepStrictEqual(answers(told(notices)).map(({ text, append }) => [text, append]), [['Hello, world', false]]);
        choice.mode = 'streamed';
        await supervisor.send('remote', 'hi');
        await eventually(() => turnEnds() === 2);
        deepStrictEqual(answers(told(notices)).map(({ text, append }) => [text, append]), [['Hello, world', false], ['Hello', false], [', world', true]]);
    });
});
