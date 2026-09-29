import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { Quote } from '../../src/agent-events.js';
import { AgentPanel } from './components/AgentPanel.js';
import type { Jump } from './components/Feed.js';
import { BroadcastPanel } from './components/BroadcastPanel.js';
import { ConversationPanel, ConversationsPanel } from './components/ConversationPanel.js';
import { FleetFeedPanel } from './components/FleetFeedPanel.js';
import { Logo } from './components/Logo.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { Sidebar } from './components/Sidebar.js';
import { useFleet } from './connection.js';
import { useT } from './i18n/I18n.js';
import { conversations as conversationsOf, pairOf } from './conversations.js';
import type { Conversation } from './conversations.js';
import { quotedMessage } from './feed.js';
import type { AgentFeed } from './feed.js';
import { placeOf } from './fleet-feed.js';
import type { FleetMessage } from './fleet-feed.js';
import type { Link } from './fleet-state.js';
import { useAgentColors } from './use-agent-colors.js';
import { useAttention } from './use-attention.js';
import { sectionOf } from './sidebar-sections.js';
import { useSidebarSection } from './use-sidebar-section.js';
/** The tab is kept in the address, so a reload opens the same one. */
const BROADCAST = 'all';
/** No agent id starts with `_`, so the settings tab cannot hide an agent. */
const SETTINGS = '_settings';
/** The settings opened at the agents, to add one (#116). */
const ADD_AGENT = '_add-agent';
/** The list of every conversation of agents; a conversation of two has a tab of its own, `_pair:…`. */
const CONVERSATIONS = '_conversations';
/** Every message of the fleet in one feed (#114). */
const FEED = '_feed';
function tabFromHash(): string {
    return decodeURIComponent(window.location.hash.replace(/^#\/?/, ''));
}
function useTab(): [string, (tab: string) => void] {
    const [tab, setTab] = useState(tabFromHash);
    useEffect(() => {
        const follow = (): void => setTab(tabFromHash());
        window.addEventListener('hashchange', follow);
        return () => window.removeEventListener('hashchange', follow);
    }, []);
    return [tab, (next: string) => {
        window.location.hash = `/${encodeURIComponent(next)}`;
    }];
}
function SettingsIcon() {
    return (
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
            <path d="M12.92 6.31 14.87 6.66 14.87 9.34 12.92 9.69 12.67 10.28 13.80 11.91 11.91 13.80 10.28 12.67 9.69 12.92 9.34 14.87 6.66 14.87 6.31 12.92 5.72 12.67 4.09 13.80 2.20 11.91 3.33 10.28 3.08 9.69 1.13 9.34 1.13 6.66 3.08 6.31 3.33 5.72 2.20 4.09 4.09 2.20 5.72 3.33 6.31 3.08 6.66 1.13 9.34 1.13 9.69 3.08 10.28 3.33 11.91 2.20 13.80 4.09 12.67 5.72Z" />
            <circle cx="8" cy="8" r="2.1" />
        </svg>
    );
}
/** The settings as an icon, right of the connection status (#116): the name for a screen reader, the tooltip for a mouse. */
function SettingsButton({ open, onOpen }: { readonly open: boolean; readonly onOpen: () => void }) {
    const t = useT();
    return (
        <button type="button" className="btn btn-sm btn-ghost icon-btn topbar-settings" aria-label={t.topbar.settings} title={t.topbar.settings}
            aria-current={open ? 'page' : undefined} onClick={onOpen}>
            <SettingsIcon />
        </button>
    );
}
/** What the open tab has shown: the last event of an agent, or how many messages of a conversation. */
function useSeen(tab: string | undefined, shown: number | undefined): Record<string, number> {
    const [seen, setSeen] = useState<Record<string, number>>({});
    useEffect(() => {
        if (tab !== undefined && shown !== undefined) {
            setSeen((last) => (last[tab] === shown ? last : { ...last, [tab]: shown }));
        }
    }, [tab, shown]);
    return seen;
}
/**
 * Where the quote of a reply leads: to the quoted message, in this tab or in
 * the tab of the agent it is in. A jump holds while its tab is open.
 */
function useQuotes(feeds: Readonly<Record<string, AgentFeed>>, tab: string, setTab: (tab: string) => void) {
    const [jump, setJump] = useState<Jump>();
    useEffect(() => {
        setJump((last) => (last === undefined || last.agentId === tab ? last : undefined));
    }, [tab]);
    const jumpTo = (agentId: string, seq: number): void => {
        setTab(agentId);
        setJump((last) => ({ agentId, seq, n: (last?.n ?? 0) + 1 }));
    };
    const quotes = {
        hasQuoted: (quote: Quote): boolean => quotedMessage(feeds[quote.agentId], quote) !== undefined,
        onOpenQuote: (quote: Quote): void => {
            const target = quotedMessage(feeds[quote.agentId], quote);
            if (target !== undefined) {
                jumpTo(quote.agentId, target.seq);
            }
        }
    };
    return { quotes, jump, jumpTo };
}
/** A message to bring into view in the conversation of two agents; `n` tells one ask from the next. */
type LaneJump = { readonly pairId: string; readonly key: string; readonly n: number };
/**
 * Where a message of the feed of the fleet leads (#114): the tab of its agent
 * or the conversation of the two, scrolled to it. A jump holds while its tab is open.
 */
function useFeedOpen(tab: string, setTab: (tab: string) => void, jumpTo: (agentId: string, seq: number) => void) {
    const [laneJump, setLaneJump] = useState<LaneJump>();
    useEffect(() => {
        setLaneJump((last) => (last === undefined || last.pairId === tab ? last : undefined));
    }, [tab]);
    const onOpen = (message: FleetMessage): void => {
        const place = placeOf(message);
        if (place.tab === 'agent') {
            jumpTo(place.agentId, place.seq);
            return;
        }
        setTab(place.pairId);
        setLaneJump((last) => ({ pairId: place.pairId, key: place.key, n: (last?.n ?? 0) + 1 }));
    };
    return { onOpen, laneJump };
}
/** The conversations of the fleet, and the one open, if a conversation tab is. */
function useConversations(state: ReturnType<typeof useFleet>[0], tab: string) {
    const ids = state.agents.map((summary) => summary.id);
    const all = useMemo(() => conversationsOf(ids, state.feeds), [ids.join('\n'), state.feeds]);
    const pair = pairOf(tab);
    const open = pair === undefined ? undefined : all.find((conversation) => conversation.id === tab);
    return { all, open, pair: knownPair(open === undefined ? pair : [open.first, open.second] as const, ids) };
}
/** The two agents of a conversation tab, while both are in the fleet. */
function knownPair(pair: readonly [string, string] | undefined, ids: readonly string[]): readonly [string, string] | undefined {
    return pair !== undefined && pair.every((id) => ids.includes(id)) ? pair : undefined;
}
function isPanelTab(tab: string, pair: unknown): boolean {
    return [BROADCAST, SETTINGS, ADD_AGENT, CONVERSATIONS, FEED].includes(tab) || pair !== undefined;
}
type FleetState = ReturnType<typeof useFleet>[0];
type AgentSummary = FleetState['agents'][number];
/** The agent whose tab is open: the one the tab names, else the first one, unless another panel is open. */
function openAgent(state: FleetState, tab: string, pair: unknown): AgentSummary | undefined {
    return state.agents.find((candidate) => candidate.id === tab) ?? (isPanelTab(tab, pair) ? undefined : state.agents[0]);
}
function feedOf(state: FleetState, agent: AgentSummary | undefined): AgentFeed | undefined {
    return agent === undefined ? undefined : state.feeds[agent.id];
}
/** The open tab that marks what it has shown: an agent or a conversation. */
function seenTab(agent: AgentSummary | undefined, open: Conversation | undefined): string | undefined {
    return agent?.id ?? open?.id;
}
/** What the open tab has shown: the last event of the agent, or how many messages of the conversation. */
function seenCount(feed: AgentFeed | undefined, open: Conversation | undefined): number | undefined {
    return feed?.lastSeq ?? open?.messages.length;
}
function useAppModel() {
    const [state, dispatch] = useFleet();
    const [tab, setTab] = useTab();
    const attention = useAttention(state, setTab, useT());
    const colors = useAgentColors(state.agents.map((summary) => summary.id));
    const conversations = useConversations(state, tab);
    const agent = openAgent(state, tab, conversations.pair);
    const feed = feedOf(state, agent);
    const seenSeq = useSeen(seenTab(agent, conversations.open), seenCount(feed, conversations.open));
    const live = state.agents.map((summary) => ({ ...summary, status: state.feeds[summary.id]?.status ?? summary.status }));
    const { quotes, jump, jumpTo } = useQuotes(state.feeds, tab, setTab);
    const feedOpen = useFeedOpen(tab, setTab, jumpTo);
    return { state, dispatch, tab, setTab, attention, colors, conversations, seenSeq, agent, feed, live, quotes, jump, feedOpen };
}
type AppModel = ReturnType<typeof useAppModel>;
function Topbar({ link, settingsOpen, onSettings }: { readonly link: Link; readonly settingsOpen: boolean; readonly onSettings: () => void }) {
    const t = useT();
    return (
        <header className="topbar">
            <Logo />
            <span className="topbar-side">
                <span className={`link link-${link}`} role="status">{t.link[link]}</span>
                <SettingsButton open={settingsOpen} onOpen={onSettings} />
            </span>
        </header>
    );
}
/** The jump into the conversation, while its tab is the open one. */
function openedJump(jump: LaneJump | undefined, tab: string): LaneJump | undefined {
    return jump?.pairId === tab ? jump : undefined;
}
function ConversationMain({ model }: { readonly model: AppModel }) {
    const { state, tab, setTab, colors, conversations, quotes, feedOpen } = model;
    const fleet = { agents: state.agents, colors };
    const opened = openedJump(feedOpen.laneJump, tab);
    return conversations.pair === undefined || tab === CONVERSATIONS
        ? <ConversationsPanel conversations={conversations.all} onOpen={setTab} {...fleet} />
        : <ConversationPanel key={tab} pair={conversations.pair} conversation={conversations.open} feeds={state.feeds} quotes={quotes} onOpen={setTab} conversationsId={CONVERSATIONS} opened={opened} {...fleet} />;
}
type Panel = (props: { readonly model: AppModel }) => JSX.Element;
function SettingsMain({ model }: { readonly model: AppModel }) {
    const { tab, attention, live } = model;
    const notify = { permission: attention.permission, onAsk: attention.askPermission };
    return <SettingsPanel key={tab} agents={live} notify={notify} atAgents={tab === ADD_AGENT} />;
}
function FeedMain({ model }: { readonly model: AppModel }) {
    const { state, colors, feedOpen } = model;
    return <FleetFeedPanel agents={state.agents} feeds={state.feeds} colors={colors} onOpen={feedOpen.onOpen} />;
}
function AgentMain({ model }: { readonly model: AppModel }) {
    const { state, dispatch, setTab, colors, agent, feed, live, quotes, jump } = model;
    return agent === undefined || feed === undefined
        ? <BroadcastPanel agents={live} deliveries={state.deliveries} empty={state.agents.length === 0} onSettings={() => setTab(SETTINGS)} />
        : <AgentPanel key={agent.id} agent={agent} feed={feed} agents={state.agents} colors={colors} dispatch={dispatch} quotes={quotes} jump={jump} />;
}
/** The panels a tab of their own opens. */
const PANELS: ReadonlyMap<string, Panel> = new Map([
    [ SETTINGS, SettingsMain ],
    [ ADD_AGENT, SettingsMain ],
    [ FEED, FeedMain ]
]);
/** Whether the open tab is the list of conversations or one of them, and not an agent. */
function isConversationMain({ tab, agent, conversations }: AppModel): boolean {
    return agent === undefined && (tab === CONVERSATIONS || conversations.pair !== undefined);
}
function Main({ model }: { readonly model: AppModel }) {
    const Panel = PANELS.get(model.tab) ?? (isConversationMain(model) ? ConversationMain : AgentMain);
    return <main className="main"><Panel model={model} /></main>;
}
/** The tab the sidebar marks: an agent, a conversation, or one of the others. */
function selectedTab({ tab, agent, conversations }: AppModel): string {
    if (agent !== undefined) {
        return agent.id;
    }
    return conversations.pair === undefined ? otherTab(tab) : conversationTab(conversations.open, tab);
}
function conversationTab(open: Conversation | undefined, tab: string): string {
    return open?.id ?? tab;
}
/** One of the tabs that are neither an agent nor a conversation; the broadcast when the tab is none of them. */
function otherTab(tab: string): string {
    return [SETTINGS, ADD_AGENT, CONVERSATIONS, FEED].includes(tab) ? tab : BROADCAST;
}
function App() {
    const model = useAppModel();
    const { state, tab, setTab, colors, conversations, seenSeq } = model;
    const tabs = { broadcastId: BROADCAST, feedId: FEED, addAgentId: ADD_AGENT, conversationsId: CONVERSATIONS };
    const selected = selectedTab(model);
    const [section, setSection] = useSidebarSection(tab, sectionOf(selected, state.agents.map((summary) => summary.id), tabs));
    return (
        <div className="app">
            <Topbar link={state.link} settingsOpen={tab === SETTINGS} onSettings={() => setTab(SETTINGS)} />
            <Sidebar agents={state.agents} feeds={state.feeds} colors={colors} conversations={conversations.all}
                seenSeq={seenSeq} selected={selected} onSelect={setTab} section={section} onSection={setSection} {...tabs} />
            <Main model={model} />
        </div>
    );
}
export { App };
