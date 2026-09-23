import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent, AgentEventBody } from '../src/agent-events.js';
import { applyEvent, emptyFeed, settlePermission } from '../web/src/feed.js';
import type { AgentFeed } from '../web/src/feed.js';
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
