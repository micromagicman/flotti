import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent, AgentEventBody } from '../src/agent-events.js';
import { pairId } from '../web/src/conversations.js';
import { applyEvent, emptyFeed } from '../web/src/feed.js';
import type { AgentFeed } from '../web/src/feed.js';
import { FLEET_FEED_SIZE, fleetMessages, messagesOf, placeOf } from '../web/src/fleet-feed.js';
import type { FleetMessage } from '../web/src/fleet-feed.js';
/** The feed of `agentId`, from events that happened at the given seconds. */
function feedOf(agentId: string, ...events: [number, AgentEventBody][]): AgentFeed {
    return events.reduce((feed: AgentFeed, [second, body], index) => applyEvent(feed, {
        ...body, agentId, seq: index + 1, time: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString()
    } as AgentEvent), emptyFeed('idle'));
}
const person = (text: string): AgentEventBody => ({ type: 'message', role: 'user', messageId: text, text, append: false });
const from = (sender: string, text: string, extra: Partial<AgentEventBody & { type: 'message' }> = {}): AgentEventBody =>
    ({ type: 'message', role: 'user', messageId: text, text, append: false, from: sender, ...extra });
const says = (text: string, to?: string): AgentEventBody =>
    ({ type: 'message', role: 'agent', messageId: text, text, append: false, ...(to === undefined ? {} : { to }) });
const turnEnd: AgentEventBody = { type: 'turn-end', reason: 'end_turn' };
const lines = (messages: readonly FleetMessage[]): string[] =>
    messages.map((message) => `${message.from ?? 'you'}>${message.to ?? 'you'}: ${message.text}`);
test('the feed takes every message of the fleet once, from the tab it lives in, oldest first', () => {
    const feeds = {
        scout: feedOf('scout', [1, person('plan it')], [2, says('asking builder', 'builder')], [3, says('on it')], [4, turnEnd],
            [7, from('builder', 'built', { turnAnswer: true })]),
        builder: feedOf('builder', [5, from('scout', 'asking builder')], [6, says('built')], [6, turnEnd])
    };
    deepStrictEqual(lines(fleetMessages(['scout', 'builder'], feeds)), [
        'you>scout: plan it',
        'scout>you: on it',
        'scout>builder: asking builder',
        'builder>scout: built'
    ], 'what builder said for scout goes back to scout, and is taken there once');
});
test('only messages: no turn ends, statuses, tool calls, thoughts or logs', () => {
    const feeds = {
        scout: feedOf('scout', [1, person('hi')], [2, { type: 'thought', text: 'hm' }], [3, { type: 'tool-call', toolCallId: 't', title: 'ls' }],
            [4, { type: 'status', status: 'error', reason: 'crashed' }], [5, { type: 'log', source: 'agent', text: 'warn' }], [6, says('hello')], [7, turnEnd])
    };
    deepStrictEqual(lines(fleetMessages(['scout'], feeds)), ['you>scout: hi', 'scout>you: hello']);
});
test('a message to all agents shows once for each agent, as it went', () => {
    const feeds = { scout: feedOf('scout', [1, person('stand up')]), builder: feedOf('builder', [1, person('stand up')]) };
    deepStrictEqual(lines(fleetMessages(['scout', 'builder'], feeds)), ['you>builder: stand up', 'you>scout: stand up']);
});
test('the feed keeps the latest messages of the fleet', () => {
    const many = Array.from({ length: FLEET_FEED_SIZE + 5 }, (_, index): [number, AgentEventBody] => [index, person(`m${index}`)]);
    const all = fleetMessages(['scout'], { scout: feedOf('scout', ...many) });
    strictEqual(FLEET_FEED_SIZE, 200);
    strictEqual(all.length, 200);
    strictEqual(all.at(-1)?.text, `m${FLEET_FEED_SIZE + 4}`, 'the newest stays');
});
test('an agent gone from the fleet takes its messages with it', () => {
    deepStrictEqual(fleetMessages(['scout'], { scout: feedOf('scout', [1, from('ghost', 'boo')]) }), []);
});
test('a message sent on, a task and its outcome are told apart', () => {
    const feeds = {
        scout: feedOf('scout', [1, from('builder', 'done it', { delegation: { id: 'd', state: 'completed' } })]),
        builder: feedOf('builder', [0, from('scout', 'build it', { delegation: { id: 'd' } })],
            [2, from('scout', '', { forwarded: { text: 'as the person said' } })])
    };
    const all = fleetMessages(['scout', 'builder'], feeds);
    deepStrictEqual(all.map((message) => [message.kind, message.text]), [
        ['task', 'build it'], ['result', 'done it'], ['forwarded', 'as the person said']
    ]);
});
test('the filter keeps what the agent wrote or got', () => {
    const feeds = {
        scout: feedOf('scout', [1, person('hi scout')], [4, from('builder', 'to scout')]),
        builder: feedOf('builder', [2, person('hi builder')], [3, says('to you')]),
        tester: feedOf('tester', [5, from('builder', 'to tester')])
    };
    const all = fleetMessages(['scout', 'builder', 'tester'], feeds);
    deepStrictEqual(lines(messagesOf(all, 'builder')), ['you>builder: hi builder', 'builder>you: to you', 'builder>scout: to scout', 'builder>tester: to tester']);
    deepStrictEqual(lines(messagesOf(all, 'scout')), ['you>scout: hi scout', 'builder>scout: to scout']);
    strictEqual(messagesOf(all, undefined), all, 'no agent picked: all of them');
});
test('a message between a person and an agent opens in the tab of the agent, one between two agents in their conversation', () => {
    const feeds = { scout: feedOf('scout', [1, person('hi')], [2, from('builder', 'yo')]) };
    const [toScout, fromBuilder] = fleetMessages(['scout', 'builder'], feeds) as [FleetMessage, FleetMessage];
    deepStrictEqual(placeOf(toScout), { tab: 'agent', agentId: 'scout', seq: 1 });
    deepStrictEqual(placeOf(fromBuilder), { tab: 'pair', pairId: pairId('builder', 'scout'), key: 'scout:2' });
});
