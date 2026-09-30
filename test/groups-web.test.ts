import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSummary, Delivery, GroupMessage, ServerMessage } from '../src/dashboard-protocol.js';
import { groupTabId } from '../src/dashboard-protocol.js';
import { fleetReducer, initialState, seen } from '../web/src/fleet-state.js';
import { EMPTY_GROUP_FEED, everyoneGroup, groupAfter, groupMessageKey, groupOf, laneItem, outcomeOf, quotedInLane, taskOf, tookNames, withGroupMessage } from '../web/src/groups.js';
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
test('a message the page has, sent again with how a member in line took it, takes the place of the one the page had (#162)', () => {
    const queued: Delivery[] = [{ agentId: 'a', result: 'taken' }, { agentId: 'b', result: 'queued' }];
    const taken: Delivery[] = [{ agentId: 'a', result: 'taken' }, { agentId: 'b', result: 'taken' }];
    const feed = withGroupMessage(withGroupMessage(EMPTY_GROUP_FEED, message(1, 'first', { deliveries: queued })), message(2, 'second'));
    const settled = withGroupMessage(feed, message(1, 'first', { deliveries: taken }));
    deepStrictEqual(settled.messages.map((found) => [found.seq, found.text, found.deliveries]), [[1, 'first', taken], [2, 'second', []]]);
    strictEqual(settled.lastSeq, 2, 'what the page has seen does not change');
    strictEqual(withGroupMessage(settled, message(1, 'first', { deliveries: taken })), settled, 'the same line again changes nothing');
    const failed: Delivery[] = [{ agentId: 'a', result: 'taken' }, { agentId: 'b', result: 'failed', error: 'gone' }];
    deepStrictEqual(withGroupMessage(settled, message(1, 'first', { deliveries: failed })).messages[0]?.deliveries, failed, 'a failure with its reason is taken as well');
    strictEqual(withGroupMessage(settled, message(0, 'lost', { deliveries: taken })), settled, 'a line the page does not hold is dropped');
    const fleet = fleetReducer(fleetReducer(initialState, server({ type: 'fleet', agents: [agent('a'), agent('b')], groups: [{ id: 'team', name: 'Team', members: ['a', 'b'] }] })), server({ type: 'group-message', message: message(1, 'first', { deliveries: queued }) }));
    deepStrictEqual(fleetReducer(fleet, server({ type: 'group-message', message: message(1, 'first', { deliveries: taken }) })).groupFeeds['team']?.messages[0]?.deliveries, taken);
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
test('the fleet of a server older than the page — a 0.5.x still running while the files under it were upgraded, so its fleet names no groups — is taken as a fleet with no groups (#167)', () => {
    const older = fleetReducer(initialState, { type: 'server', message: { type: 'fleet', agents: [agent('scout')] } });
    deepStrictEqual(older.agents, [agent('scout')]);
    deepStrictEqual(older.groups, []);
    deepStrictEqual(older.groupFeeds, {});
    deepStrictEqual(seen(older), { scout: 0 }, 'the page asks the older server only for what it knows of');
    const current = fleetReducer(older, server({ type: 'fleet', agents: [agent('scout')], groups: [{ id: 'team', name: 'Team', members: ['scout'] }] }));
    deepStrictEqual(current.groupFeeds, { team: EMPTY_GROUP_FEED }, 'once the server is restarted, its groups come as usual');
});
test('a task given in the group is one card on its line, in the state of its last line, without the result; the outcome is a line of its own (#171)', () => {
    const task = { delegationId: 't-1', from: 'eva', to: 'reviewer', group: 'team', text: 'review the diff', state: 'working' as const, deadline: '2026-01-01T01:00:00.000Z' };
    const given = message(1, '@reviewer review the diff', { from: 'eva', delegation: task });
    const other = message(2, 'meanwhile', { from: 'eva' });
    const outcome = message(3, 'two remarks', { from: 'reviewer', delegation: { ...task, state: 'completed', result: 'two remarks' } });
    deepStrictEqual(taskOf([given, other], given), task, 'working while no outcome is posted');
    deepStrictEqual(taskOf([given, other, outcome], given), { ...task, state: 'completed' }, 'the state of the outcome, not its result');
    strictEqual(taskOf([given, other, outcome], outcome), undefined, 'the line of the outcome is a message, not a card');
    strictEqual(taskOf([given, other, outcome], other), undefined);
    strictEqual(outcomeOf(outcome), 'completed');
    strictEqual(outcomeOf(given), undefined);
    strictEqual(outcomeOf(other), undefined);
});
test('a group deleted from its tab leads to the next group of the section, to the one before when it was the last, to none when it was the only one (#175)', () => {
    const groups = [{ id: 'release' }, { id: 'docs' }, { id: 'watch' }];
    strictEqual(groupAfter(groups, 'release'), 'docs');
    strictEqual(groupAfter(groups, 'docs'), 'watch');
    strictEqual(groupAfter(groups, 'watch'), 'docs');
    strictEqual(groupAfter([{ id: 'release' }], 'release'), undefined);
    strictEqual(groupAfter([], 'release'), undefined);
    strictEqual(groupAfter(groups.slice(1), 'release'), 'docs', 'a group the fleet no longer lists: the first one left');
});
