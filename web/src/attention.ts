/**
 * Which agents wait for a person — a permission to give, a question to
 * answer, an action of an administrator to allow — and what the page says
 * about it: the title and the notifications.
 * Pure functions, no React and no browser: the hook in use-attention.ts and
 * the tests share them.
 */
import type { AgentSummary } from '../../src/dashboard-protocol.js';
import { adminActionText, awaitsAllowance } from './feed.js';
import type { AgentFeed, FeedItem } from './feed.js';
import type { Messages } from './i18n/en.js';
const TITLE = 'flotti';
/** Agents waiting for a person, in the order of the tabs. */
function waitingAgents(agents: readonly AgentSummary[], feeds: Readonly<Record<string, AgentFeed>>): AgentSummary[] {
    return agents.filter((agent) => (feeds[agent.id]?.status ?? agent.status) === 'waiting' || awaitsAllowance(feeds[agent.id], agent.id));
}
/** The title of the page: how many agents wait, when any do. */
function pageTitle(waiting: number): string {
    return waiting > 0 ? `(${waiting}) ${TITLE}` : TITLE;
}
/** Agents waiting now that were not waiting before: each earns one notification. */
function newlyWaiting(before: ReadonlySet<string>, now: readonly AgentSummary[]): AgentSummary[] {
    return now.filter((agent) => !before.has(agent.id));
}
/**
 * What a notification about a waiting agent says: the permission asked for,
 * when it is one, or else why the agent waits.
 */
function notificationText(agent: AgentSummary, feed: AgentFeed | undefined, t: Messages): { readonly title: string; readonly body: string } {
    const why = waitReason(feed, t);
    return { title: t.attention.waitingTitle(agent.name), body: why === undefined || why === '' ? t.attention.openToAnswer : why };
}
type OpenRequest = FeedItem & { kind: 'permission' | 'admin-action' };
/** Why the agent waits: the latest request still open, or else the reason of the feed. */
function waitReason(feed: AgentFeed | undefined, t: Messages): string | undefined {
    if (feed === undefined) {
        return undefined;
    }
    const asked = [...feed.items].reverse().find(isOpenRequest);
    return asked === undefined ? feed.reason : requestText(asked, t);
}
function requestText(asked: OpenRequest, t: Messages): string {
    return asked.kind === 'permission'
        ? t.attention.asksPermission(asked.title)
        : t.attention.allowIt(adminActionText(asked, (id) => id, t));
}
function isOpenRequest(item: FeedItem): item is OpenRequest {
    return (item.kind === 'permission' || (item.kind === 'admin-action' && item.state === 'pending')) && !item.settled;
}
export { newlyWaiting, notificationText, pageTitle, waitingAgents };
