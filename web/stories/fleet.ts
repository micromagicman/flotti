/**
 * A pretend fleet for the stories: agents, their feeds, their colours and
 * their conversations, made without a server. The messages are built the way
 * the page keeps them, so the pure functions of the page (conversations.ts)
 * work on them as on a live fleet.
 */
import type { AgentStatus, Quote } from '../../src/agent-events.js';
import type { ConnectionHealth } from '../../src/connection-health.js';
import type { AgentSummary, Delivery, GroupMessage, GroupSummary } from '../../src/dashboard-protocol.js';
import type { AgentColors } from '../src/agent-colors.js';
import { conversations } from '../src/conversations.js';
import type { Conversation } from '../src/conversations.js';
import type { AgentFeed, FeedItem, MessageItem, QueuedMessage } from '../src/feed.js';
import type { GroupFeed } from '../src/groups.js';
/** The ids of the tabs that are not an agent's, as App.tsx names them. */
const TABS = { broadcastId: 'all', addAgentId: '_add-agent', conversationsId: '_conversations' } as const;
const SCOUT: AgentSummary = { id: 'scout', name: 'Scout', kind: 'local', harness: 'claude', status: 'idle', description: 'Reads the code and answers questions about it.', memory: { state: 'on', policy: 1, skill: 'builtin' } };
const BUILDER: AgentSummary = { id: 'builder', name: 'Builder', kind: 'local', harness: 'codex', status: 'working', description: 'Writes the code, runs the tests.', admin: true };
const REVIEWER: AgentSummary = { id: 'reviewer', name: 'Reviewer', kind: 'remote', status: 'waiting', description: 'Reviews pull requests on the build host.', health: healthOf('fine') };
const ARCHIVIST: AgentSummary = { id: 'archivist', name: 'Archivist', kind: 'local', harness: 'claude', status: 'stopped', description: 'Keeps the notes of the fleet.' };
/** Four agents, one of each kind of day: idle, working, waiting for a person, stopped. */
const AGENTS: readonly AgentSummary[] = [SCOUT, BUILDER, REVIEWER, ARCHIVIST];
const COLORS: AgentColors = { scout: 0, builder: 1, reviewer: 2, archivist: 3 };
/** A time before now: the feed shows today's messages by the hour, older ones by the weekday. */
function ago(minutes: number): string {
    return new Date(Date.now() - minutes * 60_000).toISOString();
}
function healthOf(state: 'fine' | 'poor' | 'down'): ConnectionHealth {
    const reconnects = state === 'fine' ? 1 : 7;
    return {
        latencyMs: state === 'poor' ? 1_800 : 45,
        reconnects,
        reconnectsLastHour: state === 'fine' ? 0 : 5,
        lastReconnectAt: ago(state === 'fine' ? 240 : 3),
        lastActivityAt: ago(state === 'down' ? 12 : 1),
        ...(state === 'down' ? {} : { upSince: ago(state === 'fine' ? 240 : 3) }),
        poor: state === 'fine' ? [] : ['5 reconnects in the last hour']
    };
}
type MessageInput = {
    readonly seq: number;
    readonly role: 'user' | 'agent';
    readonly text: string;
    readonly minutesAgo: number;
    readonly from?: string;
    readonly to?: string;
    readonly replyTo?: Quote;
    readonly forwarded?: { readonly author?: string; readonly text: string };
    readonly delegation?: MessageItem['delegation'];
};
function message({ seq, minutesAgo, ...rest }: MessageInput): MessageItem {
    return { kind: 'message', key: `m${seq}`, messageId: `msg-${seq}`, seq, time: ago(minutesAgo), ...rest };
}
function feed(items: readonly FeedItem[], status: AgentStatus, extras: Partial<Pick<AgentFeed, 'queue' | 'reason'>> = {}): AgentFeed {
    const lastSeq = items.reduce((last, item) => ('seq' in item ? Math.max(last, item.seq) : last), 0);
    return { items, queue: extras.queue ?? [], lastSeq, status, reason: extras.reason };
}
/** A talk with Scout: a question, an answer with a link, a reply to that answer, a message sent on. */
const SCOUT_ITEMS: readonly FeedItem[] = [
    message({ seq: 1, role: 'user', minutesAgo: 95, text: 'Where does the page keep the language a person picked?' }),
    message({ seq: 2, role: 'agent', minutesAgo: 94, text: 'In localStorage, under `flotti.language`; the provider in web/src/i18n/I18n.tsx reads it once and writes every change.\n\nThe rule is in the README: https://github.com/micromagicman/flotti#settings' }),
    message({ seq: 3, role: 'user', minutesAgo: 60, text: 'And when the storage is shut?', replyTo: { agentId: 'scout', messageId: 'msg-2', seq: 2, author: 'scout', text: 'In localStorage, under `flotti.language`; the provider in web/src/i18n/I18n.tsx reads it once and writes every change.' } }),
    message({ seq: 4, role: 'agent', minutesAgo: 59, text: 'Then the choice lasts until the page is closed: `save` swallows the error and the state still switches.' }),
    message({ seq: 5, role: 'user', minutesAgo: 20, text: 'Builder asked me to pass this on.', forwarded: { author: 'builder', text: 'The tests of the release branch are green; the tag can go.' } }),
    { kind: 'turn-end', key: 't5', reason: 'end_turn' }
];
/** Builder in a turn: a task from a person, a tool call, a task it gave Reviewer, and the outcome. */
const BUILDER_ITEMS: readonly FeedItem[] = [
    message({ seq: 1, role: 'user', minutesAgo: 40, text: 'Run the tests of the release branch and tell Reviewer what fails.' }),
    { kind: 'thought', key: 'th1', text: 'Checking out release/0.6.0 and running the suite.' },
    { kind: 'tool', key: 'tool1', toolCallId: 'call-1', title: 'npm test', status: 'completed' },
    message({ seq: 2, role: 'agent', minutesAgo: 38, text: 'Two tests of the notifier fail on the release branch: the payload of a web push lost its `tag`. Please review the fix in #142.', to: 'reviewer', delegation: { id: 'task-1', deadline: ago(-120) } }),
    message({ seq: 3, role: 'user', minutesAgo: 25, text: 'Reviewed #142: the fix is right, and the test now names the tag it expects.', from: 'reviewer', delegation: { id: 'task-1', state: 'completed' } }),
    { kind: 'tool', key: 'tool2', toolCallId: 'call-2', title: 'git push origin release/0.6.0', status: 'in_progress' }
];
/** Reviewer waits: a permission request the person has not answered. */
const REVIEWER_ITEMS: readonly FeedItem[] = [
    message({ seq: 1, role: 'user', minutesAgo: 39, text: 'Two tests of the notifier fail on the release branch: the payload of a web push lost its `tag`. Please review the fix in #142.', from: 'builder', delegation: { id: 'task-1' } }),
    message({ seq: 2, role: 'agent', minutesAgo: 26, text: 'Reviewed #142: the fix is right, and the test now names the tag it expects.', to: 'builder', delegation: { id: 'task-1', state: 'completed' } }),
    message({ seq: 3, role: 'user', minutesAgo: 5, text: 'Merge #142 once the checks are green.' }),
    { kind: 'permission', key: 'p1', requestId: 'perm-1', title: 'Run `gh pr merge 142 --squash`?', settled: false, options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'no', name: 'Refuse', kind: 'reject_once' }
    ] }
];
const ARCHIVIST_ITEMS: readonly FeedItem[] = [
    message({ seq: 1, role: 'user', minutesAgo: 1_500, text: 'Write down what was decided about the license.' }),
    message({ seq: 2, role: 'agent', minutesAgo: 1_499, text: 'Noted: from 0.6.0 flotti is under PolyForm Noncommercial 1.0.0; versions up to 0.5.0 stay under ISC.' }),
    { kind: 'status', key: 's3', status: 'stopped', reason: 'stopped by a person' }
];
const FEEDS: Readonly<Record<string, AgentFeed>> = {
    scout: feed(SCOUT_ITEMS, 'idle'),
    builder: feed(BUILDER_ITEMS, 'working'),
    reviewer: feed(REVIEWER_ITEMS, 'waiting'),
    archivist: feed(ARCHIVIST_ITEMS, 'stopped', { reason: 'stopped by a person' })
};
/** What the page had seen of each tab: Scout and Reviewer have something new, the rest not. */
const SEEN_SEQ: Readonly<Record<string, number>> = { scout: 3, builder: 3, reviewer: 1, archivist: 2 };
const CONVERSATIONS: readonly Conversation[] = conversations(AGENTS.map((agent) => agent.id), FEEDS);
/** Messages in line for an agent that is busy. */
const QUEUE: readonly QueuedMessage[] = [
    { messageId: 'q-1', seq: 10, time: ago(3), text: 'When the push is done, bump the version to 0.6.0.' },
    { messageId: 'q-2', seq: 11, time: ago(1), text: 'Builder, please also update the changelog.', from: 'scout' }
];
/** The groups of the fleet (docs/groups.md, #152): a release team with a member gone, a pair for the docs, a watch of four. */
const RELEASE: GroupSummary = { id: 'release', name: 'Release 0.6.0', topic: 'Ship 0.6.0: the groups feature, its docs and the release notes.', members: ['builder', 'reviewer', 'tester'] };
const GROUPS: readonly GroupSummary[] = [
    RELEASE,
    { id: 'docs', name: 'Docs', topic: 'Keep the README true to the code.', members: ['scout', 'archivist'] },
    { id: 'watch', name: 'Night watch', members: ['scout', 'builder', 'reviewer', 'archivist', 'tester'] }
];
const took = (...results: [string, Delivery['result'], string?][]): Delivery[] =>
    results.map(([agentId, result, error]) => ({ agentId, result, ...(error === undefined ? {} : { error }) }));
type GroupMessageInput = Omit<GroupMessage, 'groupId' | 'messageId' | 'time'> & { readonly minutesAgo: number };
function groupMessage(groupId: string, { minutesAgo, ...rest }: GroupMessageInput): GroupMessage {
    return { groupId, messageId: `g-${rest.seq}`, time: ago(minutesAgo), ...rest };
}
const RELEASE_TEXT = 'Release 0.6.0 is due Friday. Builder: run the release suite; Reviewer: check #142 once it\'s green.';
/** What was said in the release group: a person's message, the answers of the round, a reply, a forward; Tester never gets anything. */
const RELEASE_MESSAGES: readonly GroupMessage[] = [
    groupMessage('release', { seq: 1, minutesAgo: 50, text: RELEASE_TEXT, deliveries: took(['builder', 'taken'], ['reviewer', 'taken'], ['tester', 'failed', 'not in the fleet']) }),
    groupMessage('release', { seq: 2, minutesAgo: 47, from: 'builder', turnAnswer: true, text: 'Suite is green on release/0.6.0 except two notifier tests: the push payload lost its `tag`. The fix is in #142.',
        replyTo: { agentId: 'builder', messageId: 'tab-1', text: RELEASE_TEXT }, deliveries: took(['reviewer', 'taken'], ['tester', 'failed', 'not in the fleet']) }),
    groupMessage('release', { seq: 3, minutesAgo: 32, from: 'reviewer', turnAnswer: true, text: 'Reviewed #142: the fix is right, and the test now names the tag it expects.',
        replyTo: { agentId: 'reviewer', messageId: 'tab-1', text: RELEASE_TEXT }, deliveries: took(['builder', 'queued'], ['tester', 'failed', 'not in the fleet']) }),
    groupMessage('release', { seq: 4, minutesAgo: 11, from: 'builder', text: 'Thanks — merging once the checks are green.',
        replyTo: { agentId: '_group:release', messageId: 'g-3', seq: 3, author: 'reviewer', text: 'Reviewed #142: the fix is right, and the test now names the tag it expects.' },
        deliveries: took(['reviewer', 'taken'], ['tester', 'failed', 'not in the fleet']) }),
    groupMessage('release', { seq: 5, minutesAgo: 4, text: 'Scout found this while reading the README — one of you take it.',
        forwarded: { author: 'scout', text: 'The README still says every agent sees every other one; the Groups section of 0.6.0 is not there yet.' },
        deliveries: took(['builder', 'taken'], ['reviewer', 'queued'], ['tester', 'failed', 'not in the fleet']) })
];
const GROUP_FEEDS: Readonly<Record<string, GroupFeed>> = {
    release: { messages: RELEASE_MESSAGES, lastSeq: 5 },
    docs: { messages: [groupMessage('docs', { seq: 1, minutesAgo: 1_440, text: 'The README still says every agent sees every other one.', deliveries: took(['scout', 'taken'], ['archivist', 'failed', 'the agent is stopped']) })], lastSeq: 1 },
    watch: { messages: [], lastSeq: 0 }
};
/** A word that goes on: names of agents, texts of messages, too long for one line. */
const LONG_NAME = 'An agent with a name so long that no tab, chip or header of the dashboard can show all of it';
const LONG_TEXT = 'A message that goes on for a while, to see where the row cuts it and how a long word like https://example.invalid/a/path/that/does/not/end/and/keeps/going/until/the/edge/of/the/row wraps or is cut in the tab of an agent.';
/** A big fleet: `n` agents of every status, each with a talk in its tab. */
function manyAgents(n: number): { readonly agents: readonly AgentSummary[]; readonly feeds: Readonly<Record<string, AgentFeed>>; readonly colors: AgentColors } {
    const statuses: readonly AgentStatus[] = ['idle', 'working', 'waiting', 'error', 'stopped', 'starting'];
    const agents = Array.from({ length: n }, (_, i): AgentSummary => ({
        id: `agent-${i + 1}`, name: `Agent ${i + 1}`, kind: i % 3 === 2 ? 'remote' : 'local', status: statuses[i % statuses.length] ?? 'idle'
    }));
    const feeds = Object.fromEntries(agents.map((agent, i) => [agent.id, feed([
        message({ seq: 1, role: 'user', minutesAgo: 30 + i, text: `A question for ${agent.name}.` }),
        message({ seq: 2, role: 'agent', minutesAgo: 29 + i, text: `An answer of ${agent.name}.` })
    ], agent.status)]));
    const colors = Object.fromEntries(agents.map((agent, i) => [agent.id, i % 6]));
    return { agents, feeds, colors };
}
export { AGENTS, ARCHIVIST, BUILDER, COLORS, CONVERSATIONS, FEEDS, GROUPS, GROUP_FEEDS, LONG_NAME, LONG_TEXT, QUEUE, RELEASE, REVIEWER, SCOUT, SEEN_SEQ, TABS, ago, feed, groupMessage, healthOf, manyAgents, message, took };
export type { MessageInput };
