import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent, AgentEventBody } from '../src/agent-events.js';
import { conversations, pairId, pairOf, shownInSidebar } from '../web/src/conversations.js';
import type { Conversation } from '../web/src/conversations.js';
import { applyEvent, emptyFeed } from '../web/src/feed.js';
import type { AgentFeed } from '../web/src/feed.js';
/** The feed of `agentId`, from events that happened at the given seconds. */
function feedOf(agentId: string, ...events: [number, AgentEventBody][]): AgentFeed {
    return events.reduce((feed: AgentFeed, [second, body], index) => applyEvent(feed, {
        ...body, agentId, seq: index + 1, time: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString()
    } as AgentEvent), emptyFeed('idle'));
}
const from = (sender: string, text: string, id = text): AgentEventBody =>
    ({ type: 'message', role: 'user', messageId: id, text, append: false, from: sender });
const answer = (text: string, to?: string): AgentEventBody =>
    ({ type: 'message', role: 'agent', messageId: text, text, append: false, ...(to === undefined ? {} : { to }) });
const texts = (conversation: Conversation | undefined): string[] =>
    (conversation?.messages ?? []).map((message) => `${message.from}>${message.to}: ${message.item.text}`);
test('a conversation takes from each tab what the other agent sent, once, in the order it was sent', () => {
    const feeds = {
        scout: feedOf('scout', [1, answer('ask builder', 'builder')], [3, from('builder', 'built')], [4, from('reviewer', 'looks fine')]),
        builder: feedOf('builder', [2, from('scout', 'ask builder')], [2, answer('working')], [5, from('scout', 'thanks')]),
        reviewer: feedOf('reviewer', [0, { type: 'message', role: 'user', messageId: 'p', text: 'typed by a person', append: false }])
    };
    const all = conversations(['scout', 'builder', 'reviewer'], feeds);
    deepStrictEqual(all.map((conversation) => conversation.id), [pairId('scout', 'builder'), pairId('reviewer', 'scout')], 'the newest first');
    const [pair] = all;
    deepStrictEqual([pair?.first, pair?.second], ['scout', 'builder'], 'who wrote first stands first');
    deepStrictEqual(texts(pair), ['scout>builder: ask builder', 'builder>scout: built', 'scout>builder: thanks']);
    strictEqual(pair?.messages[0]?.key, 'builder:1', 'a message is where it was received');
});
test('an answer that quotes the message it answers comes in as any other message, with its quote', () => {
    const quote = { agentId: 'builder', messageId: 'ask', seq: 1, author: 'scout', text: 'ask' };
    const feeds = {
        scout: feedOf('scout', [2, { type: 'message', role: 'user', messageId: 'done', text: 'done', append: false, from: 'builder', replyTo: quote }]),
        builder: feedOf('builder', [1, from('scout', 'ask')])
    };
    const [pair] = conversations(['scout', 'builder'], feeds);
    deepStrictEqual(pair?.messages[1]?.item.replyTo, quote);
});
test('an agent gone from the fleet takes its conversations with it', () => {
    const feeds = { scout: feedOf('scout', [1, from('ghost', 'boo')]) };
    deepStrictEqual(conversations(['scout'], feeds), []);
});
test('the tab of a conversation is the same whoever wrote first, and names both agents again', () => {
    strictEqual(pairId('scout', 'builder'), pairId('builder', 'scout'));
    deepStrictEqual(pairOf(pairId('scout', 'builder')), ['builder', 'scout']);
    strictEqual(pairOf('scout'), undefined);
    strictEqual(pairOf('_pair:one'), undefined);
});
test('the sidebar lists the newest conversations, and the open one when it is older', () => {
    const all = ['a', 'b', 'c', 'd', 'e', 'f'].map((id): Conversation => ({ id, first: id, second: 'x', messages: [] }));
    deepStrictEqual(shownInSidebar(all, 4, undefined).map((conversation) => conversation.id), ['a', 'b', 'c', 'd']);
    deepStrictEqual(shownInSidebar(all, 4, 'f').map((conversation) => conversation.id), ['a', 'b', 'c', 'd', 'f']);
    deepStrictEqual(shownInSidebar(all, 4, 'b').map((conversation) => conversation.id), ['a', 'b', 'c', 'd']);
});
