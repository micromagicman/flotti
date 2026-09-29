import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSummary, GroupMessage, ServerMessage } from '../src/dashboard-protocol.js';
import { groupTabId } from '../src/dashboard-protocol.js';
import { fleetReducer, initialState, seen } from '../web/src/fleet-state.js';
import { EMPTY_GROUP_FEED, everyoneGroup, groupMessageKey, groupOf, laneItem, quotedInLane, tookNames, withGroupMessage } from '../web/src/groups.js';
const agent = (id: string): AgentSummary => ({ id, name: id.toUpperCase(), kind: 'local', status: 'idle' });
function message(seq: number, text: string, extra: Partial<GroupMessage> = {}): GroupMessage {
    return { groupId: 'team', seq, messageId: `g${seq}`, time: `2026-01-01T00:00:0${seq}.000Z`, text, deliveries: [], ...extra };
}
const server = (message: ServerMessage) => ({ type: 'server' as const, message });
test('the tab of a group names its group, and no other tab does', () => {
    strictEqual(groupOf(groupTabId('release')), 'release');
    strictEqual(groupOf('_group:'), undefined);
    strictEqual(groupOf('_pair:a:b'), undefined);
    strictEqual(groupOf('release'), undefined);
    strictEqual(groupMessageKey(message(4, 'x')), '_group:team:4');
});
test('the history of a group grows with its messages, each once: a replay after a reconnect is not taken again', () => {
    const one = withGroupMessage(EMPTY_GROUP_FEED, message(1, 'first'));
    const two = withGroupMessage(one, message(2, 'second'));
    strictEqual(withGroupMessage(two, message(2, 'second')), two);
    strictEqual(withGroupMessage(two, message(1, 'first')), two);
    deepStrictEqual(two.messages.map((found) => found.text), ['first', 'second']);
    strictEqual(two.lastSeq, 2);
});
test('the page keeps the groups of the fleet and their histories, and says what it has seen of each under the tab id of the group', () => {
    const fleet = server({ type: 'fleet', agents: [agent('scout')], groups: [{ id: 'team', name: 'Team', members: ['scout'] }] });
    const withGroup = fleetReducer(fleetReducer(initialState, fleet), server({ type: 'group-message', message: message(3, 'hello') }));
    deepStrictEqual(withGroup.groupFeeds['team']?.messages.map((found) => found.text), ['hello']);
    deepStrictEqual(seen(withGroup), { scout: 0, [groupTabId('team')]: 3 });
    const unknown = fleetReducer(withGroup, server({ type: 'group-message', message: { ...message(1, 'lost'), groupId: 'other' } }));
    strictEqual(unknown, withGroup, 'a message of a group the page does not know is dropped');
    const without = fleetReducer(withGroup, server({ type: 'fleet', agents: [agent('scout')], groups: [] }));
    deepStrictEqual(without.groupFeeds, {}, 'a group gone from the fleet takes its history with it');
});
test('the message as the lane shows it has the shape of a message of a tab, on the side of whoever wrote it', () => {
    const item = laneItem(message(2, 'hi', { from: 'scout', replyTo: { agentId: 'scout', messageId: 'm', text: 'q' } }));
    deepStrictEqual(item, { kind: 'message', key: '_group:team:2', role: 'user', messageId: 'g2', seq: 2, time: '2026-01-01T00:00:02.000Z', text: 'hi', from: 'scout', replyTo: { agentId: 'scout', messageId: 'm', text: 'q' } });
    strictEqual(laneItem(message(1, 'you')).from, undefined, 'a person wrote it');
});
test('who took a message, by name: got it, in line, failed', () => {
    const deliveries = [{ agentId: 'a', result: 'taken' as const }, { agentId: 'b', result: 'failed' as const, error: 'not in the fleet' }, { agentId: 'c', result: 'queued' as const }, { agentId: 'd', result: 'taken' as const }];
    deepStrictEqual(tookNames(deliveries, (id) => id.toUpperCase()), { taken: ['A', 'D'], queued: ['C'], failed: ['B'] });
});
test('a quote leads to its message in the lane: by its key when a person quoted the group, by author and words when a member answered what its tab got', () => {
    const messages = [message(1, 'plan it'), message(2, 'plan it', { from: 'scout' }), message(3, 'built', { from: 'builder', turnAnswer: true })];
    strictEqual(quotedInLane(messages, 'team', { agentId: groupTabId('team'), messageId: 'g3', seq: 3, text: 'built' })?.seq, 3);
    strictEqual(quotedInLane(messages, 'team', { agentId: groupTabId('team'), messageId: 'g2', text: 'plan it' })?.seq, 2, 'by id without a seq');
    strictEqual(quotedInLane(messages, 'team', { agentId: 'builder', messageId: 'tab-7', text: 'plan it' }, 3)?.seq, 1, 'the person\'s message, the last before the answer');
    strictEqual(quotedInLane(messages, 'team', { agentId: 'builder', messageId: 'tab-7', author: 'scout', text: 'plan it' })?.seq, 2, 'the same words by scout');
    strictEqual(quotedInLane(messages, 'team', { agentId: 'builder', messageId: 'tab-7', text: 'gone' }), undefined);
});
test('the one click makes the group Everyone with every agent of the fleet', () => {
    deepStrictEqual(everyoneGroup([agent('scout'), agent('builder')]), { id: 'everyone', name: 'Everyone', members: ['scout', 'builder'] });
});
