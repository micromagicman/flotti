import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AgentConfig, AgentSummary, FleetInfo } from '../../../src/dashboard-protocol.js';
import { fromConfig, newDraft } from '../agent-draft.js';
import type { Draft } from '../agent-draft.js';
import { api } from '../api.js';
import { AgentForm } from './AgentForm.js';
import { ConnectionHealthView } from './ConnectionHealth.js';
import { StatusBadge } from './StatusBadge.js';
type SettingsPanelProps = {
    /** The fleet as the socket says it, with live statuses. */
    readonly agents: readonly AgentSummary[];
};
/** What is being edited: nothing, a new agent of a kind, or an agent of the fleet. */
type Editing =
    | { readonly mode: 'new'; readonly kind: 'local' | 'remote' }
    | { readonly mode: 'edit'; readonly id: string };
function errorText(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
}
function sourceText(info: FleetInfo): string {
    switch (info.source) {
        case 'argument':
            return 'given with --fleet for this run';
        case 'environment':
            return 'given by FLOTTI_FLEET for this run';
        case 'settings':
            return info.settingsFile === undefined ? 'saved in the settings' : `saved in ${info.settingsFile}`;
        case 'default':
            return 'the default';
    }
}
/** Shows the fleet `found`: its path, and the path field with it. */
function showFleet(setInfo: (info: FleetInfo) => void, setPath: (path: string) => void): (found: FleetInfo) => void {
    return (found) => {
        setInfo(found);
        setPath(found.path);
    };
}
function useFleetDirectory() {
    const [info, setInfo] = useState<FleetInfo>();
    const [path, setPath] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    useEffect(() => {
        api.fleet().then(showFleet(setInfo, setPath), (reason: unknown) => setError(errorText(reason)));
    }, []);
    const submit = (event: FormEvent): void => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        api.switchFleet(path).then(showFleet(setInfo, setPath), (reason: unknown) => setError(errorText(reason))).finally(() => setBusy(false));
    };
    return { info, path, setPath, busy, error, submit };
}
function FleetHint({ info }: { readonly info: FleetInfo | undefined }) {
    return (
        <p className="field-hint">
            Switching stops the agents of this fleet and starts those of the new one; a directory that is not there
            yet is created. The choice is saved, and the next flotti run opens it too
            {info?.pinnedBy === undefined ? '.' : ` — unless it is started with ${info.pinnedBy === 'argument' ? '--fleet' : 'FLOTTI_FLEET'} again, as this one was.`}
        </p>
    );
}
/** Where the fleet lives: shown, and changed — the agents of the old one stop, those of the new one start. */
function FleetDirectory() {
    const { info, path, setPath, busy, error, submit } = useFleetDirectory();
    return (
        <form className="settings-section" aria-label="Fleet directory" onSubmit={submit}>
            <h2>Fleet directory</h2>
            {info === undefined
                ? null
                : <p className="muted">{info.path} — {sourceText(info)}.</p>}
            <div className="field-inline">
                <input aria-label="Fleet directory path" value={path} onChange={(event) => setPath(event.target.value)} />
                <button type="submit" disabled={busy || path.trim() === '' || path.trim() === info?.path}>Switch</button>
            </div>
            <FleetHint info={info} />
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </form>
    );
}
function addedText(answer: Awaited<ReturnType<typeof api.addOverSsh>>): string {
    return `Added ${answer.added.map((agent) => agent.name).join(', ')}`
        + `${answer.present === undefined ? '' : `; already in the fleet: ${answer.present.join(', ')}`}.`;
}
function useSshConnect() {
    const [target, setTarget] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [added, setAdded] = useState<string>();
    const submit = (event: FormEvent): void => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        setAdded(undefined);
        api.addOverSsh(target.trim()).then((answer) => {
            setTarget('');
            setAdded(addedText(answer));
        }, (reason: unknown) => setError(errorText(reason))).finally(() => setBusy(false));
    };
    return { target, setTarget, busy, error, added, submit };
}
/**
 * A remote agent in one step: its user@host, and nothing else. flotti asks the
 * host over SSH what it publishes, adds the agents and keeps a tunnel to them.
 */
function SshConnect() {
    const { target, setTarget, busy, error, added, submit } = useSshConnect();
    return (
        <form className="settings-section" aria-label="Connect over SSH" onSubmit={submit}>
            <h2>Connect over SSH</h2>
            <div className="field-inline">
                <input aria-label="SSH address" placeholder="user@host" value={target} onChange={(event) => setTarget(event.target.value)} />
                <button type="submit" className="primary" disabled={busy || target.trim() === ''}>{busy ? 'Connecting…' : 'Connect'}</button>
            </div>
            <p className="field-hint">
                Your public key has to be on the host already. flotti asks the host which agents it publishes, adds them,
                and keeps an SSH tunnel to each one up: no port, no token to copy.
            </p>
            {added === undefined ? null : <p className="note" role="status">{added}</p>}
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </form>
    );
}
type Run = (action: () => Promise<unknown>) => void;
function AgentRowTitle({ agent }: { readonly agent: AgentSummary }) {
    return (
        <div className="settings-agent-title">
            <span className="settings-agent-name">{agent.name}</span>
            <span className="kind">{agent.id} · {agent.kind === 'local' ? 'local · ACP' : 'remote · A2A'}</span>
            <StatusBadge status={agent.status} />
        </div>
    );
}
function ConfirmDelete({ agent, run, onKeep }: { readonly agent: AgentSummary; readonly run: Run; readonly onKeep: () => void }) {
    return (
        <div className="actions">
            <span className="note">Stop {agent.name} and move its directory to .trash in the fleet directory?</span>
            <button type="button" className="danger" onClick={() => run(() => api.remove(agent.id))}>Delete</button>
            <button type="button" onClick={onKeep}>Keep</button>
        </div>
    );
}
type AgentActionsProps = {
    readonly agent: AgentSummary;
    readonly run: Run;
    readonly onEdit: () => void;
    readonly onDelete: () => void;
};
function AgentActions({ agent, run, onEdit, onDelete }: AgentActionsProps) {
    const stopped = agent.status === 'stopped' || agent.status === 'error';
    return (
        <div className="actions">
            {stopped
                ? <button type="button" onClick={() => run(() => api.start(agent.id))}>Start</button>
                : <button type="button" onClick={() => run(() => api.stop(agent.id))}>Stop</button>}
            <button type="button" onClick={() => run(() => api.restart(agent.id))}>Restart</button>
            <button type="button" onClick={onEdit}>Edit</button>
            <button type="button" onClick={onDelete}>Delete</button>
        </div>
    );
}
function AgentRow({ agent, onEdit }: { readonly agent: AgentSummary; readonly onEdit: () => void }) {
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string>();
    const run = (action: () => Promise<unknown>): void => {
        setError(undefined);
        action().catch((reason: unknown) => setError(errorText(reason)));
    };
    return (
        <li className="settings-agent" data-agent={agent.id} aria-label={agent.name}>
            <AgentRowTitle agent={agent} />
            {agent.health === undefined ? null : <ConnectionHealthView health={agent.health} />}
            {confirming
                ? <ConfirmDelete agent={agent} run={run} onKeep={() => setConfirming(false)} />
                : <AgentActions agent={agent} run={run} onEdit={onEdit} onDelete={() => setConfirming(true)} />}
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </li>
    );
}
function ManifestLoading({ error, onDone }: { readonly error: string | undefined; readonly onDone: () => void }) {
    return (
        <div className="settings-section">
            {error === undefined ? <p className="muted">Reading the manifest…</p> : <p className="error" role="alert">{error}</p>}
            <div className="actions"><button type="button" onClick={onDone}>Back</button></div>
        </div>
    );
}
/** Reads the manifest of the agent being changed, then shows the form with it. */
function AgentEditor({ editing, onDone }: { readonly editing: Editing; readonly onDone: () => void }) {
    const [draft, setDraft] = useState<Draft | undefined>(editing.mode === 'new' ? newDraft(editing.kind) : undefined);
    const [error, setError] = useState<string>();
    useEffect(() => {
        if (editing.mode === 'edit') {
            api.config(editing.id).then((config) => setDraft(fromConfig(config)), (reason: unknown) => setError(errorText(reason)));
        }
    }, [editing]);
    const save = async (config: AgentConfig): Promise<void> => {
        await (editing.mode === 'new' ? api.create(config) : api.update(config));
        onDone();
    };
    if (draft === undefined) {
        return <ManifestLoading error={error} onDone={onDone} />;
    }
    return <AgentForm initial={draft} isNew={editing.mode === 'new'} onSave={save} onCancel={onDone} />;
}
function AgentList({ agents, onEditing }: { readonly agents: readonly AgentSummary[]; readonly onEditing: (editing: Editing) => void }) {
    return (
        <div className="settings-section">
            <h2>Agents</h2>
            {agents.length === 0 ? <p className="muted">No agents yet.</p> : null}
            <ul className="settings-agents" aria-label="Agents">
                {agents.map((agent) => (
                    <AgentRow key={agent.id} agent={agent} onEdit={() => onEditing({ mode: 'edit', id: agent.id })} />
                ))}
            </ul>
            <div className="actions">
                <button type="button" onClick={() => onEditing({ mode: 'new', kind: 'local' })}>Add local agent</button>
                <button type="button" onClick={() => onEditing({ mode: 'new', kind: 'remote' })}>Add remote agent</button>
            </div>
        </div>
    );
}
/**
 * The fleet set up from the page: its directory, its agents added, changed,
 * removed, started and stopped. Everything is written to the agent
 * directories, so the files stay the truth and can still be edited by hand.
 */
function SettingsPanel({ agents }: SettingsPanelProps) {
    const [editing, setEditing] = useState<Editing>();
    return (
        <section className="settings" aria-label="Fleet settings">
            <h1>Fleet settings</h1>
            {editing === undefined
                ? (
                    <>
                        <SshConnect />
                        <FleetDirectory />
                        <AgentList agents={agents} onEditing={setEditing} />
                    </>
                )
                : <AgentEditor editing={editing} onDone={() => setEditing(undefined)} />}
        </section>
    );
}
export { SettingsPanel };
