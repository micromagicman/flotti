import { useEffect, useState } from 'react';
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
function App() {
    const [state, dispatch] = useFleet();
    const [tab, setTab] = useTab();
    const attention = useAttention(state, setTab);
    const colors = useAgentColors(state.agents.map((summary) => summary.id));
    const [seenSeq, setSeenSeq] = useState<Record<string, number>>({});
    const agent = state.agents.find((candidate) => candidate.id === tab)
        ?? (tab === BROADCAST || tab === SETTINGS ? undefined : state.agents[0]);
    const feed = agent === undefined ? undefined : state.feeds[agent.id];
    const shownSeq = feed?.lastSeq;
    const live = state.agents.map((summary) => ({ ...summary, status: state.feeds[summary.id]?.status ?? summary.status }));
    useEffect(() => {
        if (agent !== undefined && shownSeq !== undefined) {
            setSeenSeq((seen) => (seen[agent.id] === shownSeq ? seen : { ...seen, [agent.id]: shownSeq }));
        }
    }, [agent, shownSeq]);
    return (
        <div className="app">
            <header className="topbar">
                <span className="brand">flotti</span>
                <span className="topbar-side">
                    <NotifyButton permission={attention.permission} onAsk={attention.askPermission} />
                    <span className={`link link-${state.link}`} role="status">{LINK_TEXT[state.link]}</span>
                </span>
            </header>
            <Sidebar
                agents={state.agents}
                feeds={state.feeds}
                seenSeq={seenSeq}
                selected={agent?.id ?? (tab === SETTINGS ? SETTINGS : BROADCAST)}
                broadcastId={BROADCAST}
                settingsId={SETTINGS}
                onSelect={setTab}
            />
            <main className="main">
                {tab === SETTINGS
                    ? <SettingsPanel agents={live} />
                    : agent === undefined || feed === undefined
                        ? <BroadcastPanel agents={live} deliveries={state.deliveries} empty={state.agents.length === 0} onSettings={() => setTab(SETTINGS)} />
                        : <AgentPanel key={agent.id} agent={agent} feed={feed} agents={state.agents} colors={colors} dispatch={dispatch} />}
            </main>
        </div>
    );
}
export { App };
