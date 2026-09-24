/**
 * Which agents wait for a person — a permission to give, a question to
 * answer, an action of an administrator to allow — and what the page says
 * about it: the title and the notifications.
 * Pure functions, no React and no browser: the hook in use-attention.ts and
 * the tests share them.
 */
import type { AgentSummary } from '../../src/dashboard-protocol.js';
import { adminActionText, awaitsAllowance } from './feed.js';
import type { AgentFeed } from './feed.js';
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
    const asked = [...feed?.items ?? []].reverse()
        .find((item) => (item.kind === 'permission' || (item.kind === 'admin-action' && item.state === 'pending')) && !item.settled);
    const why = asked?.kind === 'permission'
        ? t.attention.asksPermission(asked.title)
        : asked?.kind === 'admin-action' ? t.attention.allowIt(adminActionText(asked, (id) => id, t)) : feed?.reason;
    return { title: t.attention.waitingTitle(agent.name), body: why === undefined || why === '' ? t.attention.openToAnswer : why };
}
export { newlyWaiting, notificationText, pageTitle, waitingAgents };
