/**
 * The sections of the sidebar as tabs (#136, Groups with #152, no Fleet
 * since #173): which one a tab of the sidebar belongs to, and what a closed
 * section carries on its tab.
 */
import type { AgentStatus } from '../../src/agent-events.js';
import type { AgentSummary, GroupSummary } from '../../src/dashboard-protocol.js';
import { groupTabId } from '../../src/dashboard-protocol.js';
import { pairOf } from './conversations.js';
import type { Conversation } from './conversations.js';
import type { AgentFeed } from './feed.js';
import { groupOf } from './groups.js';
import type { GroupFeed } from './groups.js';
const SECTIONS = ['agents', 'groups', 'conversations'] as const;
type Section = typeof SECTIONS[number];
/**
 * The first time the sidebar opens on the agents, and on a saved pick the
 * sidebar no longer has — `fleet` of 0.6.x (#173).
 */
const FIRST_SECTION: Section = SECTIONS[0];
function isSection(value: unknown): value is Section {
    return SECTIONS.includes(value as Section);
}
/** The ids of the tabs that are not an agent's nor a conversation's. */
type OtherTabs = { readonly broadcastId: string; readonly conversationsId: string };
/**
 * The section a tab of the sidebar is in: an agent and the broadcast in
 * Agents, a group in Groups, a conversation or the list of them in
 * Conversations. None for a tab of every section, such as Add agent or the
 * settings.
 */
function sectionOf(tab: string, agentIds: readonly string[], { broadcastId, conversationsId }: OtherTabs): Section | undefined {
    if (agentIds.includes(tab)) {
        return 'agents';
    }
    if (groupOf(tab) !== undefined) {
        return 'groups';
    }
    if (pairOf(tab) !== undefined) {
        return 'conversations';
    }
    return new Map<string, Section>([[broadcastId, 'agents'], [conversationsId, 'conversations']]).get(tab);
}
/** The live status of the agent: its feed knows it first. */
function statusOf(agent: AgentSummary, feed: AgentFeed | undefined): AgentStatus {
    return feed?.status ?? agent.status;
}
/**
 * Whether a tab not open has more than it showed when it was: the last event
 * of an agent, or how many messages of a conversation.
 */
function hasUnread(id: string, selected: string, shown: number, seenSeq: Readonly<Record<string, number>>): boolean {
    return id !== selected && shown > (seenSeq[id] ?? 0);
}
/** What a closed section says on its tab: who waits for a person, and how many of its tabs have something new. */
type Marker = { readonly waiting: readonly string[]; readonly unread: number };
type MarkerInput = {
    readonly agents: readonly AgentSummary[];
    readonly feeds: Readonly<Record<string, AgentFeed>>;
    readonly conversations: readonly Conversation[];
    readonly groups: readonly GroupSummary[];
    readonly groupFeeds: Readonly<Record<string, GroupFeed>>;
    readonly seenSeq: Readonly<Record<string, number>>;
    readonly selected: string;
};
function agentsMarker({ agents, feeds, seenSeq, selected }: MarkerInput): Marker {
    return {
        waiting: agents.filter((agent) => statusOf(agent, feeds[agent.id]) === 'waiting').map((agent) => agent.name),
        unread: agents.filter((agent) => hasUnread(agent.id, selected, feeds[agent.id]?.lastSeq ?? 0, seenSeq)).length
    };
}
function conversationsMarker({ conversations, seenSeq, selected }: MarkerInput): Marker {
    return {
        waiting: [],
        unread: conversations.filter((conversation) => hasUnread(conversation.id, selected, conversation.messages.length, seenSeq)).length
    };
}
/** The last message of a group the page has: what its tab shows. */
function groupLastSeq(feeds: Readonly<Record<string, GroupFeed>>, group: GroupSummary): number {
    return feeds[group.id]?.lastSeq ?? 0;
}
/** No group waits for a person: a closed Groups carries the unread dot only. */
function groupsMarker({ groups, groupFeeds, seenSeq, selected }: MarkerInput): Marker {
    return {
        waiting: [],
        unread: groups.filter((group) => hasUnread(groupTabId(group.id), selected, groupLastSeq(groupFeeds, group), seenSeq)).length
    };
}
const MARKERS: Readonly<Record<Section, (input: MarkerInput) => Marker>> = {
    agents: agentsMarker, groups: groupsMarker, conversations: conversationsMarker
};
/** What the tab of a closed section carries; the open one carries nothing. */
function markerOf(section: Section, open: Section, input: MarkerInput): Marker | undefined {
    if (section === open) {
        return undefined;
    }
    return MARKERS[section](input);
}
/** The dot a marker shows: the waiting one takes the place of the unread one. */
function markerDot(marker: Marker | undefined): 'waiting' | 'unread' | undefined {
    if (marker === undefined) {
        return undefined;
    }
    if (marker.waiting.length > 0) {
        return 'waiting';
    }
    return marker.unread > 0 ? 'unread' : undefined;
}
/** The next section for a key of the switch, WAI-ARIA tabs: arrows go round, Home and End to the ends. */
function sectionForKey(current: Section, key: string): Section | undefined {
    const at = SECTIONS.indexOf(current);
    const moves: Readonly<Record<string, number>> = {
        ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: SECTIONS.length - 1
    };
    const to = moves[key];
    return to === undefined ? undefined : SECTIONS[(to + SECTIONS.length) % SECTIONS.length];
}
export { FIRST_SECTION, SECTIONS, groupLastSeq, hasUnread, isSection, markerDot, markerOf, sectionForKey, sectionOf, statusOf };
export type { Marker, MarkerInput, Section };
