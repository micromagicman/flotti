import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent, AgentEventBody, AgentStatus } from '../src/agent-events.js';
import type { AgentSummary } from '../src/dashboard-protocol.js';
import { newlyWaiting, notificationText, pageTitle, waitingAgents } from '../web/src/attention.js';
import { applyEvent, emptyFeed } from '../web/src/feed.js';
import type { AgentFeed } from '../web/src/feed.js';
import { en } from '../web/src/i18n/en.js';
import { ru } from '../web/src/i18n/ru.js';
function agent(id: string, status: AgentStatus = 'idle'): AgentSummary {
    return { id, name: id, kind: 'local', status };
}
function feedOf(...bodies: AgentEventBody[]): AgentFeed {
    return bodies.reduce((feed: AgentFeed, body, index) =>
        applyEvent(feed, { ...body, agentId: 'a', seq: index + 1, time: '' } as AgentEvent), emptyFeed('idle'));
}
test('the waiting agents are those whose feed says so, in the order of the tabs', () => {
    const agents = [agent('a'), agent('b', 'waiting'), agent('c')];
    const feeds = {
        a: feedOf({ type: 'status', status: 'waiting', reason: undefined }),
        b: feedOf({ type: 'status', status: 'working', reason: undefined })
    };
    deepStrictEqual(waitingAgents(agents, feeds).map((one) => one.id), ['a']);
    deepStrictEqual(waitingAgents([agent('x', 'waiting')], {}).map((one) => one.id), ['x']);
});
test('the title counts the waiting agents, and is plain when none wait', () => {
    strictEqual(pageTitle(0), 'flotti');
    strictEqual(pageTitle(2), '(2) flotti');
});
test('only an agent that has just started waiting is notified about', () => {
    const now = [agent('a', 'waiting'), agent('b', 'waiting')];
    deepStrictEqual(newlyWaiting(new Set(['a']), now).map((one) => one.id), ['b']);
    deepStrictEqual(newlyWaiting(new Set(['a', 'b']), now), []);
});
test('a notification names the permission asked for, or else why the agent waits', () => {
    const asking = feedOf(
        { type: 'permission', requestId: 'r', title: 'Run npm test', options: [] },
        { type: 'status', status: 'waiting', reason: undefined }
    );
    deepStrictEqual(notificationText(agent('claude'), asking, en), { title: 'claude is waiting for you', body: 'Asks for permission: Run npm test' });
    const question = feedOf({ type: 'status', status: 'waiting', reason: 'input required' });
    strictEqual(notificationText(agent('eva'), question, en).body, 'input required');
    strictEqual(notificationText(agent('eva'), undefined, en).body, 'Open flotti to answer.');
    deepStrictEqual(notificationText(agent('claude'), asking, ru), { title: 'claude ждёт вас', body: 'Просит разрешения: Run npm test' });
});
