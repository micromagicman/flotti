import { useEffect, useState } from 'react';
import type { AgentSummary } from '../../src/dashboard-protocol.js';
import { AgentPanel } from './components/AgentPanel.js';
import { BroadcastPanel } from './components/BroadcastPanel.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { Sidebar } from './components/Sidebar.js';
import { useFleet } from './connection.js';
import type { Link } from './fleet-state.js';
import { useAgentColors } from './use-agent-colors.js';
import { useAttention } from './use-attention.js';
import type { Permission } from './use-attention.js';
/** The tab is kept in the address, so a reload opens the same one. */
const BROADCAST = 'all';
/** No agent id starts with `_`, so the settings tab cannot hide an agent. */
const SETTINGS = '_settings';
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
        ? <button type="button" className="notify" onClick={onAsk} title="A notification when an agent waits for you and flotti is out of sight">Notify me</button>
        : null;
}
function useSeenSeq(agent: AgentSummary | undefined, shownSeq: number | undefined): Record<string, number> {
    const [seenSeq, setSeenSeq] = useState<Record<string, number>>({});
    useEffect(() => {
        if (agent !== undefined && shownSeq !== undefined) {
            setSeenSeq((seen) => (seen[agent.id] === shownSeq ? seen : { ...seen, [agent.id]: shownSeq }));
        }
    }, [agent, shownSeq]);
    return seenSeq;
}
function useAppModel() {
    const [state, dispatch] = useFleet();
    const [tab, setTab] = useTab();
    const attention = useAttention(state, setTab);
    const colors = useAgentColors(state.agents.map((summary) => summary.id));
    const agent = state.agents.find((candidate) => candidate.id === tab)
        ?? (tab === BROADCAST || tab === SETTINGS ? undefined : state.agents[0]);
    const feed = agent === undefined ? undefined : state.feeds[agent.id];
    const shownSeq = feed?.lastSeq;
    const seenSeq = useSeenSeq(agent, shownSeq);
    const live = state.agents.map((summary) => ({ ...summary, status: state.feeds[summary.id]?.status ?? summary.status }));
    return { state, dispatch, tab, setTab, attention, colors, seenSeq, agent, feed, live };
}
type AppModel = ReturnType<typeof useAppModel>;
function Topbar({ attention, link }: { readonly attention: ReturnType<typeof useAttention>; readonly link: Link }) {
    return (
        <header className="topbar">
            <span className="brand">flotti</span>
            <span className="topbar-side">
                <NotifyButton permission={attention.permission} onAsk={attention.askPermission} />
                <span className={`link link-${link}`} role="status">{LINK_TEXT[link]}</span>
            </span>
        </header>
    );
}
function Main({ model }: { readonly model: AppModel }) {
    const { state, dispatch, tab, setTab, colors, agent, feed, live } = model;
    return (
        <main className="main">
            {tab === SETTINGS
                ? <SettingsPanel agents={live} />
                : agent === undefined || feed === undefined
                    ? <BroadcastPanel agents={live} deliveries={state.deliveries} empty={state.agents.length === 0} onSettings={() => setTab(SETTINGS)} />
                    : <AgentPanel key={agent.id} agent={agent} feed={feed} agents={state.agents} colors={colors} dispatch={dispatch} />}
        </main>
    );
}
function App() {
    const model = useAppModel();
    const { state, tab, setTab, attention, seenSeq, agent } = model;
    return (
        <div className="app">
            <Topbar attention={attention} link={state.link} />
            <Sidebar
                agents={state.agents}
                feeds={state.feeds}
                seenSeq={seenSeq}
                selected={agent?.id ?? (tab === SETTINGS ? SETTINGS : BROADCAST)}
                broadcastId={BROADCAST}
                settingsId={SETTINGS}
                onSelect={setTab}
            />
            <Main model={model} />
        </div>
    );
}
export { App };
