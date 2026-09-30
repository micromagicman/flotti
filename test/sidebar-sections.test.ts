import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentStatus } from '../src/agent-events.js';
import type { AgentSummary, GroupSummary } from '../src/dashboard-protocol.js';
import { groupTabId } from '../src/dashboard-protocol.js';
import { pairId } from '../web/src/conversations.js';
import type { Conversation } from '../web/src/conversations.js';
import { emptyFeed } from '../web/src/feed.js';
import type { AgentFeed } from '../web/src/feed.js';
import type { GroupFeed } from '../web/src/groups.js';
import { SECTIONS, markerDot, markerOf, sectionForKey, sectionOf } from '../web/src/sidebar-sections.js';
import type { MarkerInput } from '../web/src/sidebar-sections.js';
const OTHER = { broadcastId: 'all', feedId: '_feed', conversationsId: '_conversations' };
const agent = (id: string, status: AgentStatus = 'idle'): AgentSummary => ({ id, name: id, kind: 'local', status });
const feed = (lastSeq: number, status: AgentStatus = 'idle'): AgentFeed => ({ ...emptyFeed(status), lastSeq });
const conversation = (first: string, second: string, messages: number): Conversation =>
    ({ id: pairId(first, second), first, second, messages: Array.from({ length: messages }) } as unknown as Conversation);
const group = (id: string, members: readonly string[] = []): GroupSummary => ({ id, name: id, members });
const groupFeed = (lastSeq: number): GroupFeed => ({ messages: [], lastSeq });
function input(over: Partial<MarkerInput> = {}): MarkerInput {
    return { agents: [agent('scout'), agent('builder')], feeds: {}, conversations: [], groups: [], groupFeeds: {}, seenSeq: {}, selected: 'scout', ...over };
}
test('the sidebar has four sections, Groups between Agents and Conversations (#152)', () => {
    deepStrictEqual([...SECTIONS], ['fleet', 'agents', 'groups', 'conversations']);
});
test('a tab of the sidebar is in its section: an agent in Agents, a group in Groups, a pair and the list of them in Conversations, the broadcast and the feed in Fleet', () => {
    const ids = ['scout', 'builder'];
    strictEqual(sectionOf('scout', ids, OTHER), 'agents');
    strictEqual(sectionOf(groupTabId('release'), ids, OTHER), 'groups');
    strictEqual(sectionOf('_group:', ids, OTHER), undefined, 'a group tab names its group');
    strictEqual(sectionOf(pairId('scout', 'builder'), ids, OTHER), 'conversations');
    strictEqual(sectionOf('_conversations', ids, OTHER), 'conversations');
    strictEqual(sectionOf('all', ids, OTHER), 'fleet');
    strictEqual(sectionOf('_feed', ids, OTHER), 'fleet');
    strictEqual(sectionOf('_add-agent', ids, OTHER), undefined, 'Add agent is under every section and moves none');
    strictEqual(sectionOf('_settings', ids, OTHER), undefined);
});
test('the open section and Fleet carry no marker', () => {
    const busy = input({ feeds: { builder: feed(3, 'waiting') } });
    strictEqual(markerOf('agents', 'agents', busy), undefined);
    strictEqual(markerOf('fleet', 'agents', busy), undefined);
});
test('closed Agents says who waits for a person and how many agents have something new', () => {
    const marker = markerOf('agents', 'fleet', input({
        agents: [agent('scout'), agent('builder'), agent('reviewer', 'waiting')],
        feeds: { scout: feed(2), builder: feed(5, 'waiting') },
        seenSeq: { scout: 2, builder: 1 },
        selected: 'scout'
    }));
    deepStrictEqual(marker, { waiting: ['builder', 'reviewer'], unread: 1 }, 'the live status of the feed first; the open agent has nothing new');
    strictEqual(markerDot(marker), 'waiting', 'the waiting dot takes the place of the unread one');
});
test('closed Conversations counts the pairs with messages not seen, the ones out of the sidebar as well', () => {
    const conversations = [conversation('a', 'b', 3), conversation('a', 'c', 1), conversation('b', 'c', 2)];
    const marker = markerOf('conversations', 'agents', input({ conversations, seenSeq: { [pairId('a', 'b')]: 3, [pairId('a', 'c')]: 0 } }));
    deepStrictEqual(marker, { waiting: [], unread: 2 });
    strictEqual(markerDot(marker), 'unread');
    strictEqual(markerDot({ waiting: [], unread: 0 }), undefined, 'nothing new, no dot');
});
test('closed Groups counts the groups with messages not seen, by the tab id of the group; no group waits for a person', () => {
    const groups = [group('release'), group('docs'), group('watch')];
    const groupFeeds = { release: groupFeed(5), docs: groupFeed(1), watch: groupFeed(0) };
    const marker = markerOf('groups', 'agents', input({ groups, groupFeeds, seenSeq: { [groupTabId('release')]: 3 } }));
    deepStrictEqual(marker, { waiting: [], unread: 2 }, 'release has new messages, docs was never opened, watch has none');
    strictEqual(markerDot(marker), 'unread');
    const opened = markerOf('groups', 'agents', input({ groups, groupFeeds, seenSeq: { [groupTabId('docs')]: 1 }, selected: groupTabId('release') }));
    deepStrictEqual(opened, { waiting: [], unread: 0 }, 'the open group has nothing new, docs was read');
    strictEqual(markerOf('groups', 'groups', input({ groups, groupFeeds })), undefined, 'the open section carries nothing');
});
test('the keys of the switch go round with the arrows, both ways, and Home and End go to the ends', () => {
    strictEqual(sectionForKey('fleet', 'ArrowDown'), 'agents');
    strictEqual(sectionForKey('fleet', 'ArrowRight'), 'agents');
    strictEqual(sectionForKey('fleet', 'ArrowUp'), 'conversations');
    strictEqual(sectionForKey('agents', 'ArrowDown'), 'groups');
    strictEqual(sectionForKey('conversations', 'ArrowLeft'), 'groups');
    strictEqual(sectionForKey('conversations', 'ArrowDown'), 'fleet');
    strictEqual(sectionForKey('agents', 'Home'), 'fleet');
    strictEqual(sectionForKey('agents', 'End'), 'conversations');
    strictEqual(sectionForKey('agents', 'Enter'), undefined);
});
