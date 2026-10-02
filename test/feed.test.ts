import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent, AgentEventBody } from '../src/agent-events.js';
import { applyEvent, emptyFeed, forwardOf, inAgentTab, quoteOf, quotedMessage, settlePermission } from '../web/src/feed.js';
import type { AgentFeed, MessageItem } from '../web/src/feed.js';
function feedOf(...bodies: AgentEventBody[]): AgentFeed {
    return bodies.reduce((feed: AgentFeed, body, index) =>
        applyEvent(feed, { ...body, agentId: 'a', seq: index + 1, time: '' } as AgentEvent), emptyFeed('idle'));
}
test('pieces of one message make one message', () => {
    const feed = feedOf(
        { type: 'message', role: 'user', messageId: 'u', text: 'hi', append: false },
        { type: 'message', role: 'agent', messageId: 'm', text: 'Hel', append: false },
        { type: 'message', role: 'agent', messageId: 'm', text: 'lo', append: true },
        { type: 'thought', text: 'hmm, ' },
        { type: 'thought', text: 'yes' },
        { type: 'message', role: 'agent', messageId: 'm', text: 'Bye', append: false }
    );
    deepStrictEqual(feed.items.map((item) => (item.kind === 'message' || item.kind === 'thought' ? `${item.kind}:${item.text}` : item.kind)), [
        'message:hi',
        'message:Bye',
        'thought:hmm, yes'
    ]);
});
test('an id used again after the turn ended starts a new message', () => {
    const feed = feedOf(
        { type: 'message', role: 'agent', messageId: 'm1', text: 'one', append: false },
        { type: 'turn-end', reason: 'end_turn' },
        { type: 'message', role: 'agent', messageId: 'm1', text: 'two', append: false }
    );
    deepStrictEqual(feed.items.flatMap((item) => (item.kind === 'message' ? [item.text] : [])), ['one', 'two']);
});
test('the progress of the agent is a line of its own, shown as it comes', () => {
    const feed = feedOf(
        { type: 'progress', text: 'Running the tests' },
        { type: 'progress', text: 'Tests are green' }
    );
    deepStrictEqual(feed.items, [
        { kind: 'progress', key: 'e1', text: 'Running the tests' },
        { kind: 'progress', key: 'e2', text: 'Tests are green' }
    ]);
});
test('a message between agents keeps who sent it and whom it went to', () => {
    const feed = feedOf(
        { type: 'message', role: 'user', messageId: 'u', text: 'rerun the tests', append: false, from: 'reviewer' },
        { type: 'message', role: 'agent', messageId: 'm', text: 'on it', append: false, to: 'reviewer' },
        { type: 'message', role: 'user', messageId: 'p', text: 'typed by hand', append: false }
    );
    deepStrictEqual(feed.items, [
        { kind: 'message', key: 'm1', seq: 1, time: '', role: 'user', messageId: 'u', text: 'rerun the tests', from: 'reviewer' },
        { kind: 'message', key: 'm2', seq: 2, time: '', role: 'agent', messageId: 'm', text: 'on it', to: 'reviewer' },
        { kind: 'message', key: 'm3', seq: 3, time: '', role: 'user', messageId: 'p', text: 'typed by hand' }
    ]);
});
test('updates of a tool call fold into one card', () => {
    const feed = feedOf(
        { type: 'tool-call', toolCallId: 'c', title: 'Read file', status: 'pending' },
        { type: 'tool-call', toolCallId: 'c', status: 'completed' }
    );
    deepStrictEqual(feed.items, [{ kind: 'tool', key: 'c1', toolCallId: 'c', title: 'Read file', status: 'completed' }]);
});
test('an event already seen changes nothing: a reconnect may repeat the tail', () => {
    const feed = feedOf({ type: 'message', role: 'agent', messageId: 'm', text: 'a', append: false });
    const again = applyEvent(feed, { type: 'message', role: 'agent', messageId: 'm', text: 'a', append: true, agentId: 'a', seq: 1, time: '' });
    strictEqual(again, feed);
});
test('the status follows status events; busy ones stay out of the feed', () => {
    const feed = feedOf(
        { type: 'status', status: 'working' },
        { type: 'status', status: 'idle' },
        { type: 'status', status: 'error', reason: 'gone' }
    );
    deepStrictEqual([feed.status, feed.reason, feed.lastSeq], ['error', 'gone', 3]);
    deepStrictEqual(feed.items.map((item) => item.kind), ['status']);
});
test('a permission request settles when answered here or when the agent moves on', () => {
    const asked = feedOf(
        { type: 'permission', requestId: 'r1', title: 'Delete?', options: [] },
        { type: 'status', status: 'waiting' }
    );
    const settled = (feed: AgentFeed) => feed.items.flatMap((item) => (item.kind === 'permission' ? [item.settled] : []));
    deepStrictEqual(settled(asked), [false]);
    deepStrictEqual(settled(settlePermission(asked, 'r1')), [true]);
    deepStrictEqual(settled(applyEvent(asked, { type: 'status', status: 'working', agentId: 'a', seq: 3, time: '' })), [true]);
});
test('a reply quotes a message by its seq too: an agent may use one message id turn after turn', () => {
    const feed = feedOf(
        { type: 'message', role: 'agent', messageId: 'm1', text: 'one', append: false },
        { type: 'turn-end', reason: 'end_turn' },
        { type: 'message', role: 'agent', messageId: 'm1', text: 'two', append: false }
    );
    const first = feed.items[0];
    strictEqual(first?.kind, 'message');
    const quote = quoteOf(first as MessageItem, 'a');
    deepStrictEqual(quote, { agentId: 'a', messageId: 'm1', seq: 1, author: 'a', text: 'one' });
    strictEqual(quotedMessage(feed, quote)?.text, 'one');
    strictEqual(quotedMessage(feed, { messageId: 'm1' })?.text, 'two', 'with no seq, the last message of that id');
    strictEqual(quotedMessage(feed, { messageId: 'm1', seq: 99 }), undefined, 'a message gone from the feed');
});
test('a reply and a forward keep what they carry; a forward sent on again names who wrote it first', () => {
    const replyTo = { agentId: 'b', messageId: 'x', author: 'b', text: 'red' };
    const forwarded = { author: 'c', text: 'green' };
    const feed = feedOf(
        { type: 'message', role: 'user', messageId: 'u1', text: 'why?', append: false, replyTo },
        { type: 'message', role: 'user', messageId: 'u2', text: '', append: false, from: 'b', forwarded }
    );
    const [reply, forward] = feed.items as MessageItem[];
    deepStrictEqual(reply?.replyTo, replyTo);
    deepStrictEqual(forwardOf(reply as MessageItem, 'a'), { text: 'why?' }, 'a person wrote it');
    deepStrictEqual(forwardOf(forward as MessageItem, 'a'), forwarded);
    deepStrictEqual(quoteOf(forward as MessageItem, 'a'), { agentId: 'a', messageId: 'u2', seq: 2, author: 'c', text: 'green' });
});
test('a message in line waits after the feed, in order, and joins the feed where its turn starts once taken', () => {
    const feed = feedOf(
        { type: 'message', role: 'user', messageId: 'u1', text: 'first', append: false },
        { type: 'queued', messageId: 'q1', text: 'second' },
        { type: 'queued', messageId: 'q2', text: 'third', from: 'reviewer' },
        { type: 'progress', text: 'Working on the first' }
    );
    deepStrictEqual(feed.queue, [
        { messageId: 'q1', seq: 2, time: '', text: 'second' },
        { messageId: 'q2', seq: 3, time: '', text: 'third', from: 'reviewer' }
    ]);
    deepStrictEqual(feed.items.map((item) => item.kind), ['message', 'progress'], 'nothing of the line in the feed itself');
    const taken = applyEvent(feed, { type: 'message', role: 'user', messageId: 'q1', text: 'second', append: false, agentId: 'a', seq: 5, time: '' });
    deepStrictEqual(taken.queue.map((queued) => queued.messageId), ['q2']);
    const last = taken.items.at(-1);
    strictEqual(last?.kind === 'message' ? last.text : undefined, 'second');
});
test('a message taken back leaves the line and nothing in the feed', () => {
    const feed = feedOf(
        { type: 'queued', messageId: 'q1', text: 'oops' },
        { type: 'unqueued', messageId: 'q1', outcome: 'withdrawn' }
    );
    deepStrictEqual(feed.queue, []);
    deepStrictEqual(feed.items, []);
});
test('a dropped message stays in the feed as not delivered, and a message sent again in its place settles it', () => {
    const replyTo = { agentId: 'a', messageId: 'm1', text: 'the build is red' };
    const feed = feedOf(
        { type: 'queued', messageId: 'q1', text: 'rerun it', replyTo },
        { type: 'log', source: 'flotti', text: 'flotti was started again; everything above is from before.' },
        { type: 'unqueued', messageId: 'q1', outcome: 'dropped', reason: 'flotti restarted' }
    );
    deepStrictEqual(feed.queue, []);
    deepStrictEqual(feed.items.at(-1), {
        kind: 'undelivered', key: 'u1', messageId: 'q1', time: '', text: 'rerun it', replyTo, reason: 'flotti restarted', resent: false
    });
    const again = applyEvent(feed, { type: 'queued', messageId: 'q9', text: 'rerun it', replyTo, retryOf: 'q1', agentId: 'a', seq: 4, time: '' });
    const settled = again.items.at(-1);
    strictEqual(settled?.kind === 'undelivered' ? settled.resent : undefined, true);
    const taken = applyEvent(feedOf(
        { type: 'queued', messageId: 'q1', text: 'hi' },
        { type: 'unqueued', messageId: 'q1', outcome: 'dropped', reason: 'agent stopped' },
        { type: 'message', role: 'user', messageId: 'q2', text: 'hi', append: false, retryOf: 'q1' }
    ), { type: 'turn-end', reason: 'end_turn', agentId: 'a', seq: 4, time: '' });
    strictEqual(taken.items.some((item) => item.kind === 'undelivered' && item.resent), true);
});
test('the line is counted from the events again after a reconnect: nothing twice', () => {
    const events = [
        { type: 'queued', messageId: 'q1', text: 'one' },
        { type: 'queued', messageId: 'q2', text: 'two' }
    ] as const;
    const feed = feedOf(...events);
    const again = applyEvent(feed, { ...events[0], agentId: 'a', seq: 1, time: '' });
    deepStrictEqual(again.queue.map((queued) => queued.messageId), ['q1', 'q2']);
});
test('a task shows once, where it was given, and its card follows what becomes of it', () => {
    const task = { type: 'delegation', delegationId: 't1', from: 'a', to: 'b', text: 'rerun the job' } as const;
    const deadline = '2026-09-24T12:00:00.000Z';
    const feed = feedOf(
        { ...task, state: 'working', deadline },
        { type: 'message', role: 'agent', messageId: 'm', text: 'meanwhile', append: false },
        { type: 'cancel-delegation', delegationId: 't1' },
        { ...task, state: 'failed', deadline, result: 'its deadline passed' }
    );
    deepStrictEqual(feed.items.map((item) => item.kind), ['delegation', 'message']);
    deepStrictEqual(feed.items[0], {
        kind: 'delegation',
        key: 'd1',
        delegationId: 't1',
        from: 'a',
        to: 'b',
        text: 'rerun the job',
        state: 'failed',
        deadline,
        result: 'its deadline passed'
    });
});
/** The events of a turn a group message started, marked with the group as the supervisor keeps them (0.7.0, #172). */
const GROUP_TURN: readonly AgentEventBody[] = [
    { type: 'message', role: 'user', messageId: 'g1', text: 'ship it?', append: false, from: 'eva', group: 'release' },
    { type: 'status', status: 'working' },
    { type: 'thought', text: 'the tests are green' },
    { type: 'tool-call', toolCallId: 'c1', title: 'npm test', status: 'completed' },
    { type: 'progress', text: 'checking the changelog' },
    { type: 'message', role: 'agent', messageId: 'r1', text: 'yes, ship it', append: false },
    { type: 'turn-end', reason: 'end_turn' }
].map((body) => (body.type === 'status' || 'group' in body ? body : { ...body, group: 'release' })) as AgentEventBody[];
test('a group message and the turn it started produce no rows in the tab of the member; the badge still follows the status (0.7.0, #172)', () => {
    const feed = feedOf(...GROUP_TURN);
    deepStrictEqual(feed.items, [], 'neither the message nor the answer, the thought, the tool call, the progress or the turn end');
    strictEqual(feed.lastSeq, GROUP_TURN.length, 'every event is taken in: a reconnecting page asks for what came after it');
    strictEqual(feed.status, 'working', 'a status is not traffic');
    strictEqual(feed.shownSeq, 0, 'nothing the tab shows changed');
});
test('a permission request of a group turn stays in the tab of the agent, marked with the group, and is settled with the turn (0.7.0, #172)', () => {
    const [taken, ...rest] = GROUP_TURN;
    const asked: AgentEventBody = { type: 'permission', requestId: 'p1', title: 'Push the tag', options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }], group: 'release' } as AgentEventBody;
    const waiting = feedOf(taken as AgentEventBody, asked);
    deepStrictEqual(waiting.items, [
        { kind: 'permission', key: 'e2', requestId: 'p1', title: 'Push the tag', options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }], settled: false, group: 'release' }
    ]);
    strictEqual(waiting.shownSeq, 2, 'the request is what the tab shows new');
    const over = feedOf(taken as AgentEventBody, asked, ...rest);
    deepStrictEqual(over.items.map((item) => (item.kind === 'permission' ? [item.kind, item.settled] : [item.kind])), [['permission', true]], 'the end of the hidden turn still settles what it asked');
});
test('a direct turn shows as ever, after a group turn and between two (0.7.0, #172)', () => {
    const feed = feedOf(
        ...GROUP_TURN,
        { type: 'message', role: 'user', messageId: 'd1', text: 'what did you tell eva?', append: false },
        { type: 'message', role: 'agent', messageId: 'r1', text: 'to ship it', append: false },
        { type: 'turn-end', reason: 'end_turn' },
        ...GROUP_TURN
    );
    deepStrictEqual(feed.items.map((item) => (item.kind === 'message' ? `${item.role}:${item.text}` : item.kind)), [
        'user:what did you tell eva?',
        'agent:to ship it',
        'turn-end'
    ]);
    strictEqual(feed.shownSeq, GROUP_TURN.length + 3, 'the unread mark follows the last event shown, not the last one kept');
});
test('the rule of the tab: what carries a group is left to the tab of the group, but a status, a permission request and an action of an administrator (0.7.0, #172)', () => {
    const event = (body: AgentEventBody, group?: string): AgentEvent => ({ ...body, agentId: 'a', seq: 1, time: '', ...(group === undefined ? {} : { group }) } as AgentEvent);
    strictEqual(inAgentTab(event({ type: 'message', role: 'user', messageId: 'u', text: 'hi', append: false })), true, 'a direct message');
    strictEqual(inAgentTab(event({ type: 'message', role: 'user', messageId: 'u', text: 'hi', append: false, from: 'eva' })), true, 'a row of 0.6.x between two agents stays in sight (open question 2)');
    strictEqual(inAgentTab(event({ type: 'message', role: 'agent', messageId: 'm', text: 'ok', append: false }, 'release')), false);
    strictEqual(inAgentTab(event({ type: 'queued', messageId: 'q', text: 'hi' }, 'release')), false, 'a group message waiting in line is the group\'s too');
    strictEqual(inAgentTab(event({ type: 'status', status: 'working' }, 'release')), true);
    strictEqual(inAgentTab(event({ type: 'permission', requestId: 'p', title: 't', options: [] }, 'release')), true);
    strictEqual(inAgentTab(event({ type: 'admin-action', actionId: 'x', action: 'restart', admin: 'a', target: 'b', state: 'pending' }, 'release')), true);
});
test('a group message of 0.6.x is hidden, the answer that followed it — unmarked then — stays as a row (0.7.0, #172)', () => {
    const feed = feedOf(
        { type: 'message', role: 'user', messageId: 'g1', text: 'ship it?', append: false, from: 'eva', group: 'release' },
        { type: 'message', role: 'agent', messageId: 'r1', text: 'yes', append: false },
        { type: 'turn-end', reason: 'end_turn' }
    );
    deepStrictEqual(feed.items.map((item) => item.kind === 'message' ? `${item.role}:${item.text}` : item.kind), ['agent:yes', 'turn-end']);
});
