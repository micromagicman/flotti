import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { Quote } from '../../src/agent-events.js';
import { AgentPanel } from './components/AgentPanel.js';
import type { Jump } from './components/Feed.js';
import { BroadcastPanel } from './components/BroadcastPanel.js';
import { GroupPanel } from './components/GroupPanel.js';
import { Logo } from './components/Logo.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { Sidebar } from './components/Sidebar.js';
import { api } from './api.js';
import { useFleet } from './connection.js';
import { useT } from './i18n/I18n.js';
import { quotedMessage } from './feed.js';
import type { AgentFeed } from './feed.js';
import type { Link } from './fleet-state.js';
import { everyoneGroup, groupOf } from './groups.js';
import { groupTabId } from '../../src/dashboard-protocol.js';
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
/** The settings opened at the form of a group (#152), from Edit in its tab: `_edit-group:<id>`. */
const EDIT_GROUP = '_edit-group:';
function editGroupOf(tab: string): string | undefined {
    return tab.startsWith(EDIT_GROUP) && tab.length > EDIT_GROUP.length ? tab.slice(EDIT_GROUP.length) : undefined;
}
/** Whether the tab is the settings page itself: opened by the gear, or at a group by Edit. */
function isSettingsTab(tab: string): boolean {
    return tab === SETTINGS || editGroupOf(tab) !== undefined;
}
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
/** What the open tab has shown: the last event of an agent, or the last message of a group. */
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
    return { quotes, jump };
}
/** The group whose tab is open (#152), while it is in the fleet, and what the page has of it. */
function useOpenGroup(state: FleetState, tab: string) {
    const id = groupOf(tab);
    const open = id === undefined ? undefined : state.groups.find((group) => group.id === id);
    return { open, feed: open === undefined ? undefined : state.groupFeeds[open.id] };
}
type OpenGroup = ReturnType<typeof useOpenGroup>;
function isPanelTab(tab: string, group: unknown): boolean {
    return [BROADCAST, ADD_AGENT].includes(tab) || isSettingsTab(tab) || group !== undefined;
}
type FleetState = ReturnType<typeof useFleet>[0];
type AgentSummary = FleetState['agents'][number];
/** The agent whose tab is open: the one the tab names, else the first one, unless another panel is open. */
function openAgent(state: FleetState, tab: string, group: unknown): AgentSummary | undefined {
    return state.agents.find((candidate) => candidate.id === tab) ?? (isPanelTab(tab, group) ? undefined : state.agents[0]);
}
function feedOf(state: FleetState, agent: AgentSummary | undefined): AgentFeed | undefined {
    return agent === undefined ? undefined : state.feeds[agent.id];
}
/** The open tab that marks what it has shown: an agent or a group. */
function seenTab(agent: AgentSummary | undefined, group: OpenGroup): string | undefined {
    return agent?.id ?? (group.open === undefined ? undefined : groupTabId(group.open.id));
}
/** What the open tab has shown: the last event of the agent, or the last message of the group. */
function seenCount(feed: AgentFeed | undefined, group: OpenGroup): number | undefined {
    return feed?.lastSeq ?? group.feed?.lastSeq;
}
/** The one click of the Groups section (docs/groups.md, open question 2): every agent of the fleet in one group, and its tab opens. */
function useEveryone(state: FleetState, setTab: (tab: string) => void) {
    return async (): Promise<void> => {
        const group = await api.createGroup(everyoneGroup(state.agents));
        setTab(groupTabId(group.id));
    };
}
function useAppModel() {
    const [state, dispatch] = useFleet();
    const [tab, setTab] = useTab();
    const attention = useAttention(state, setTab, useT());
    const colors = useAgentColors(state.agents.map((summary) => summary.id));
    const group = useOpenGroup(state, tab);
    const agent = openAgent(state, tab, group.open);
    const feed = feedOf(state, agent);
    const seenSeq = useSeen(seenTab(agent, group), seenCount(feed, group));
    const live = state.agents.map((summary) => ({ ...summary, status: state.feeds[summary.id]?.status ?? summary.status }));
    const { quotes, jump } = useQuotes(state.feeds, tab, setTab);
    const onEveryone = useEveryone(state, setTab);
    return { state, dispatch, tab, setTab, attention, colors, group, seenSeq, agent, feed, live, quotes, jump, onEveryone };
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
type Panel = (props: { readonly model: AppModel }) => JSX.Element;
function SettingsMain({ model }: { readonly model: AppModel }) {
    const { state, tab, attention, live } = model;
    const notify = { permission: attention.permission, onAsk: attention.askPermission };
    return <SettingsPanel key={tab} agents={live} groups={state.groups} notify={notify} atAgents={tab === ADD_AGENT} atGroup={editGroupOf(tab)} />;
}
/** The tab of a group (#152), while the group is in the fleet. */
function GroupMain({ model }: { readonly model: AppModel }) {
    const { state, tab, setTab, colors, group, quotes } = model;
    if (group.open === undefined) {
        return <AgentMain model={model} />;
    }
    return <GroupPanel key={tab} group={group.open} feed={group.feed} agents={state.agents} colors={colors} quotes={quotes}
        onEdit={() => setTab(`${EDIT_GROUP}${group.open?.id ?? ''}`)} />;
}
function AgentMain({ model }: { readonly model: AppModel }) {
    const { state, dispatch, setTab, colors, agent, feed, live, quotes, jump } = model;
    if (agent === undefined || feed === undefined) {
        return <BroadcastPanel agents={live} deliveries={state.deliveries} empty={state.agents.length === 0} onSettings={() => setTab(SETTINGS)} />;
    }
    const groups = state.groups.filter((group) => group.members.includes(agent.id));
    return <AgentPanel key={agent.id} agent={agent} feed={feed} agents={state.agents} colors={colors} groups={groups} onOpenGroup={(id) => setTab(groupTabId(id))}
        dispatch={dispatch} quotes={quotes} jump={jump} />;
}
/** The panels a tab of their own opens. */
const PANELS: ReadonlyMap<string, Panel> = new Map([
    [ SETTINGS, SettingsMain ],
    [ ADD_AGENT, SettingsMain ]
]);
/** The panel of a tab that is none of the groups': one of its own, else an agent or the broadcast. */
function plainPanelOf(model: AppModel): Panel {
    return PANELS.get(model.tab) ?? AgentMain;
}
/** The panel the open tab opens: the settings at a group, the tab of a group, or one of the others. */
function panelOf(model: AppModel): Panel {
    if (editGroupOf(model.tab) !== undefined) {
        return SettingsMain;
    }
    return model.group.open === undefined ? plainPanelOf(model) : GroupMain;
}
function Main({ model }: { readonly model: AppModel }) {
    const Panel = panelOf(model);
    return <main className="main"><Panel model={model} /></main>;
}
/** The tab the sidebar marks: an agent, a group, or one of the others. */
function selectedTab({ tab, agent, group }: AppModel): string {
    if (agent !== undefined) {
        return agent.id;
    }
    return group.open === undefined ? otherTab(tab) : groupTabId(group.open.id);
}
/** One of the tabs that are neither an agent nor a group; the broadcast when the tab is none of them. */
function otherTab(tab: string): string {
    if (editGroupOf(tab) !== undefined) {
        return SETTINGS;
    }
    return [SETTINGS, ADD_AGENT].includes(tab) ? tab : BROADCAST;
}
function App() {
    const model = useAppModel();
    const { state, tab, setTab, colors, seenSeq, onEveryone } = model;
    const tabs = { broadcastId: BROADCAST, addAgentId: ADD_AGENT };
    const selected = selectedTab(model);
    const [section, setSection] = useSidebarSection(tab, sectionOf(selected, state.agents.map((summary) => summary.id), tabs));
    return (
        <div className="app">
            <Topbar link={state.link} settingsOpen={isSettingsTab(tab)} onSettings={() => setTab(SETTINGS)} />
            <Sidebar agents={state.agents} feeds={state.feeds} colors={colors} groups={state.groups} groupFeeds={state.groupFeeds}
                onEveryone={onEveryone} seenSeq={seenSeq} selected={selected} onSelect={setTab} section={section} onSection={setSection} {...tabs} />
            <Main model={model} />
        </div>
    );
}
export { App };
