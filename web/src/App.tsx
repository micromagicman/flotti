import { useEffect, useMemo, useState } from 'react';
import type { Quote } from '../../src/agent-events.js';
import { AgentPanel } from './components/AgentPanel.js';
import type { Jump } from './components/Feed.js';
import { BroadcastPanel } from './components/BroadcastPanel.js';
import { ConversationPanel, ConversationsPanel } from './components/ConversationPanel.js';
import { Logo } from './components/Logo.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { Sidebar } from './components/Sidebar.js';
import { useFleet } from './connection.js';
import { conversations as conversationsOf, pairOf } from './conversations.js';
import { quotedMessage } from './feed.js';
import type { AgentFeed } from './feed.js';
import type { Link } from './fleet-state.js';
import { useAgentColors } from './use-agent-colors.js';
import { useAttention } from './use-attention.js';
import type { Permission } from './use-attention.js';
/** The tab is kept in the address, so a reload opens the same one. */
const BROADCAST = 'all';
/** No agent id starts with `_`, so the settings tab cannot hide an agent. */
const SETTINGS = '_settings';
/** The list of every conversation of agents; a conversation of two has a tab of its own, `_pair:…`. */
const CONVERSATIONS = '_conversations';
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
const LINK_TEXT: Readonly<Record<Link, string>> = {
    connecting: 'Connecting…',
    open: 'Connected',
    closed: 'Connection lost, reconnecting…',
    gone: 'flotti has stopped'
};
/** Offered while the browser has not been told yes or no; a refusal is the person's to undo in the browser. */
function NotifyButton({ permission, onAsk }: { readonly permission: Permission; readonly onAsk: () => void }) {
    return permission === 'default'
        ? <button type="button" className="btn btn-sm notify" onClick={onAsk} title="A notification when an agent waits for you and flotti is out of sight">Notify me</button>
        : null;
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
    const quotes = {
        hasQuoted: (quote: Quote): boolean => quotedMessage(feeds[quote.agentId], quote) !== undefined,
        onOpenQuote: (quote: Quote): void => {
            const target = quotedMessage(feeds[quote.agentId], quote);
            if (target !== undefined) {
                setTab(quote.agentId);
                setJump((last) => ({ agentId: quote.agentId, seq: target.seq, n: (last?.n ?? 0) + 1 }));
            }
        }
    };
    return { quotes, jump };
}
/** The conversations of the fleet, and the one open, if a conversation tab is. */
function useConversations(state: ReturnType<typeof useFleet>[0], tab: string) {
    const ids = state.agents.map((summary) => summary.id);
    const all = useMemo(() => conversationsOf(ids, state.feeds), [ids.join('\n'), state.feeds]);
    const pair = pairOf(tab);
    const open = pair === undefined ? undefined : all.find((conversation) => conversation.id === tab);
    const lanePair = open === undefined ? pair : [open.first, open.second] as const;
    return { all, open, pair: lanePair !== undefined && lanePair.every((id) => ids.includes(id)) ? lanePair : undefined };
}
function isPanelTab(tab: string, pair: unknown): boolean {
    return tab === BROADCAST || tab === SETTINGS || tab === CONVERSATIONS || pair !== undefined;
}
function useAppModel() {
    const [state, dispatch] = useFleet();
    const [tab, setTab] = useTab();
    const attention = useAttention(state, setTab);
    const colors = useAgentColors(state.agents.map((summary) => summary.id));
    const conversations = useConversations(state, tab);
    const agent = state.agents.find((candidate) => candidate.id === tab) ?? (isPanelTab(tab, conversations.pair) ? undefined : state.agents[0]);
    const feed = agent === undefined ? undefined : state.feeds[agent.id];
    const seenSeq = useSeen(agent?.id ?? conversations.open?.id, feed?.lastSeq ?? conversations.open?.messages.length);
    const live = state.agents.map((summary) => ({ ...summary, status: state.feeds[summary.id]?.status ?? summary.status }));
    const { quotes, jump } = useQuotes(state.feeds, tab, setTab);
    return { state, dispatch, tab, setTab, attention, colors, conversations, seenSeq, agent, feed, live, quotes, jump };
}
type AppModel = ReturnType<typeof useAppModel>;
function Topbar({ attention, link }: { readonly attention: ReturnType<typeof useAttention>; readonly link: Link }) {
    return (
        <header className="topbar">
            <Logo />
            <span className="topbar-side">
                <NotifyButton permission={attention.permission} onAsk={attention.askPermission} />
                <span className={`link link-${link}`} role="status">{LINK_TEXT[link]}</span>
            </span>
        </header>
    );
}
function ConversationMain({ model }: { readonly model: AppModel }) {
    const { state, tab, setTab, colors, conversations, quotes } = model;
    const fleet = { agents: state.agents, colors };
    return conversations.pair === undefined || tab === CONVERSATIONS
        ? <ConversationsPanel conversations={conversations.all} onOpen={setTab} {...fleet} />
        : <ConversationPanel key={tab} pair={conversations.pair} conversation={conversations.open} feeds={state.feeds} quotes={quotes} onOpen={setTab} conversationsId={CONVERSATIONS} {...fleet} />;
}
function Main({ model }: { readonly model: AppModel }) {
    const { state, dispatch, tab, setTab, colors, conversations, agent, feed, live, quotes, jump } = model;
    if (tab === SETTINGS) {
        return <main className="main"><SettingsPanel agents={live} /></main>;
    }
    if (agent === undefined && (tab === CONVERSATIONS || conversations.pair !== undefined)) {
        return <main className="main"><ConversationMain model={model} /></main>;
    }
    return (
        <main className="main">
            {agent === undefined || feed === undefined
                ? <BroadcastPanel agents={live} deliveries={state.deliveries} empty={state.agents.length === 0} onSettings={() => setTab(SETTINGS)} />
                : <AgentPanel key={agent.id} agent={agent} feed={feed} agents={state.agents} colors={colors} dispatch={dispatch} quotes={quotes} jump={jump} />}
        </main>
    );
}
/** The tab the sidebar marks: an agent, a conversation, or one of the others. */
function selectedTab({ tab, agent, conversations }: AppModel): string {
    if (agent !== undefined) {
        return agent.id;
    }
    if (conversations.pair !== undefined) {
        return conversations.open?.id ?? tab;
    }
    return tab === SETTINGS || tab === CONVERSATIONS ? tab : BROADCAST;
}
function App() {
    const model = useAppModel();
    const { state, setTab, attention, colors, conversations, seenSeq } = model;
    const tabs = { broadcastId: BROADCAST, settingsId: SETTINGS, conversationsId: CONVERSATIONS };
    return (
        <div className="app">
            <Topbar attention={attention} link={state.link} />
            <Sidebar agents={state.agents} feeds={state.feeds} colors={colors} conversations={conversations.all}
                seenSeq={seenSeq} selected={selectedTab(model)} onSelect={setTab} {...tabs} />
            <Main model={model} />
        </div>
    );
}
export { App };
