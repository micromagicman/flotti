import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AgentConfig, AgentSummary, FleetInfo } from '../../../src/dashboard-protocol.js';
import { fromConfig, newDraft } from '../agent-draft.js';
import type { Draft } from '../agent-draft.js';
import { api } from '../api.js';
import { AgentForm } from './AgentForm.js';
import { ConnectionHealthView } from './ConnectionHealth.js';
import { NotificationSettingsSection } from './NotificationSettings.js';
import { LanguageSection } from './LanguageSection.js';
import { StatusBadge } from './StatusBadge.js';
import { useT } from '../i18n/I18n.js';
import { errorText } from '../i18n/errors.js';
import type { Messages } from '../i18n/en.js';
type SettingsPanelProps = {
    /** The fleet as the socket says it, with live statuses. */
    readonly agents: readonly AgentSummary[];
};
/** What is being edited: nothing, a new agent of a kind, or an agent of the fleet. */
type Editing =
    | { readonly mode: 'new'; readonly kind: 'local' | 'remote' }
    | { readonly mode: 'edit'; readonly id: string };
function sourceText(info: FleetInfo, t: Messages): string {
    switch (info.source) {
        case 'argument':
            return t.settings.sourceArgument;
        case 'environment':
            return t.settings.sourceEnvironment;
        case 'settings':
            return info.settingsFile === undefined ? t.settings.sourceSettings : t.settings.sourceSettingsFile(info.settingsFile);
        case 'default':
            return t.settings.sourceDefault;
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
    const t = useT();
    useEffect(() => {
        api.fleet().then(showFleet(setInfo, setPath), (reason: unknown) => setError(errorText(reason, t)));
    }, []);
    const submit = (event: FormEvent): void => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        api.switchFleet(path).then(showFleet(setInfo, setPath), (reason: unknown) => setError(errorText(reason, t))).finally(() => setBusy(false));
    };
    return { info, path, setPath, busy, error, submit };
}
function FleetHint({ info }: { readonly info: FleetInfo | undefined }) {
    const t = useT();
    return (
        <p className="field-hint">
            {t.settings.fleetHint}
            {info?.pinnedBy === undefined ? '.' : t.settings.fleetPinned(info.pinnedBy === 'argument' ? '--fleet' : 'FLOTTI_FLEET')}
        </p>
    );
}
/** Where the fleet lives: shown, and changed — the agents of the old one stop, those of the new one start. */
function FleetDirectory() {
    const { info, path, setPath, busy, error, submit } = useFleetDirectory();
    const t = useT();
    return (
        <form className="settings-section" aria-label={t.settings.fleetTitle} onSubmit={submit}>
            <h2>{t.settings.fleetTitle}</h2>
            {info === undefined
                ? null
                : <p className="muted">{info.path} — {sourceText(info, t)}.</p>}
            <div className="field-inline">
                <input className="input" aria-label={t.settings.fleetPath} value={path} onChange={(event) => setPath(event.target.value)} />
                <button type="submit" className="btn" disabled={busy || path.trim() === '' || path.trim() === info?.path}>{t.settings.switch}</button>
            </div>
            <FleetHint info={info} />
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </form>
    );
}
function addedText(answer: Awaited<ReturnType<typeof api.addOverSsh>>, t: Messages): string {
    return t.settings.added(answer.added.map((agent) => agent.name).join(', '), answer.present?.join(', '));
}
function useSshConnect() {
    const [target, setTarget] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [added, setAdded] = useState<string>();
    const t = useT();
    const submit = (event: FormEvent): void => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        setAdded(undefined);
        api.addOverSsh(target.trim()).then((answer) => {
            setTarget('');
            setAdded(addedText(answer, t));
        }, (reason: unknown) => setError(errorText(reason, t))).finally(() => setBusy(false));
    };
    return { target, setTarget, busy, error, added, submit };
}
/**
 * A remote agent in one step: its user@host, and nothing else. flotti asks the
 * host over SSH what it publishes, adds the agents and keeps a tunnel to them.
 */
function SshConnect() {
    const { target, setTarget, busy, error, added, submit } = useSshConnect();
    const t = useT();
    return (
        <form className="settings-section" aria-label={t.settings.sshTitle} onSubmit={submit}>
            <h2>{t.settings.sshTitle}</h2>
            <div className="field-inline">
                <input className="input" aria-label={t.settings.sshAddress} placeholder="user@host" value={target} onChange={(event) => setTarget(event.target.value)} />
                <button type="submit" className="btn btn-primary" aria-busy={busy} disabled={busy || target.trim() === ''}>{busy ? t.settings.connecting : t.settings.connect}</button>
            </div>
            <p className="field-hint">{t.settings.sshHint}</p>
            {added === undefined ? null : <p className="note" role="status">{added}</p>}
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </form>
    );
}
/** The checkbox of the confirmation, as the server has it: saved at once, read back from the answer. */
function useAdminConfirm() {
    const [confirm, setConfirm] = useState<boolean>();
    const [error, setError] = useState<string>();
    const t = useT();
    useEffect(() => {
        api.adminSettings().then((found) => setConfirm(found.confirmActions), (reason: unknown) => setError(errorText(reason, t)));
    }, []);
    const change = (next: boolean): void => {
        const before = confirm;
        setError(undefined);
        // The box follows the click at once; what the server saved, or the state before, comes after.
        setConfirm(next);
        api.setAdminSettings({ confirmActions: next }).then((found) => setConfirm(found.confirmActions), (reason: unknown) => {
            setConfirm(before);
            setError(errorText(reason, t));
        });
    };
    return { confirm, error, change };
}
/** Whether actions of administrators wait for a person: a restart or a clear waits for Allow in the dashboard. */
function AdminConfirm() {
    const { confirm, error, change } = useAdminConfirm();
    const t = useT();
    return (
        <div className="settings-section" role="group" aria-label={t.settings.adminTitle}>
            <h2>{t.settings.adminTitle}</h2>
            <label className="check">
                <input type="checkbox" checked={confirm === true} disabled={confirm === undefined} onChange={(event) => change(event.target.checked)} />
                {' '}{t.settings.adminConfirm}
            </label>
            <p className="field-hint">{t.settings.adminHint}</p>
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </div>
    );
}
type Run = (action: () => Promise<unknown>) => void;
function AgentRowTitle({ agent }: { readonly agent: AgentSummary }) {
    const t = useT();
    return (
        <div className="settings-agent-title">
            <span className="settings-agent-name">{agent.name}</span>
            <span className="kind">{agent.id} · {agent.kind === 'local' ? t.common.localKind : t.common.remoteKind}{agent.admin === true ? t.settings.adminSuffix : ''}</span>
            <StatusBadge status={agent.status} />
        </div>
    );
}
function ConfirmDelete({ agent, run, onKeep }: { readonly agent: AgentSummary; readonly run: Run; readonly onKeep: () => void }) {
    const t = useT();
    return (
        <div className="actions">
            <span className="note">{t.settings.confirmDelete(agent.name)}</span>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => run(() => api.remove(agent.id))}>{t.common.delete}</button>
            <button type="button" className="btn btn-sm" onClick={onKeep}>{t.settings.keep}</button>
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
    const t = useT();
    return (
        <div className="actions">
            {stopped
                ? <button type="button" className="btn btn-sm" onClick={() => run(() => api.start(agent.id))}>{t.common.start}</button>
                : <button type="button" className="btn btn-sm" onClick={() => run(() => api.stop(agent.id))}>{t.common.stop}</button>}
            <button type="button" className="btn btn-sm" onClick={() => run(() => api.restart(agent.id))}>{t.common.restart}</button>
            <button type="button" className="btn btn-sm" onClick={onEdit}>{t.common.edit}</button>
            <button type="button" className="btn btn-sm" onClick={onDelete}>{t.common.delete}</button>
        </div>
    );
}
function AgentRow({ agent, onEdit }: { readonly agent: AgentSummary; readonly onEdit: () => void }) {
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string>();
    const t = useT();
    const run = (action: () => Promise<unknown>): void => {
        setError(undefined);
        action().catch((reason: unknown) => setError(errorText(reason, t)));
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
    const t = useT();
    return (
        <div className="settings-section">
            {error === undefined ? <p className="muted">{t.settings.readingManifest}</p> : <p className="error" role="alert">{error}</p>}
            <div className="actions"><button type="button" className="btn" onClick={onDone}>{t.common.back}</button></div>
        </div>
    );
}
/** Reads the manifest of the agent being changed, then shows the form with it. */
function AgentEditor({ editing, onDone }: { readonly editing: Editing; readonly onDone: () => void }) {
    const [draft, setDraft] = useState<Draft | undefined>(editing.mode === 'new' ? newDraft(editing.kind) : undefined);
    const [error, setError] = useState<string>();
    const t = useT();
    useEffect(() => {
        if (editing.mode === 'edit') {
            api.config(editing.id).then((config) => setDraft(fromConfig(config)), (reason: unknown) => setError(errorText(reason, t)));
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
    const t = useT();
    return (
        <div className="settings-section">
            <h2>{t.settings.agentsTitle}</h2>
            {agents.length === 0 ? <p className="muted">{t.settings.noAgents}</p> : null}
            <ul className="settings-agents" aria-label={t.settings.agentsTitle}>
                {agents.map((agent) => (
                    <AgentRow key={agent.id} agent={agent} onEdit={() => onEditing({ mode: 'edit', id: agent.id })} />
                ))}
            </ul>
            <div className="actions">
                <button type="button" className="btn" onClick={() => onEditing({ mode: 'new', kind: 'local' })}>{t.settings.addLocal}</button>
                <button type="button" className="btn" onClick={() => onEditing({ mode: 'new', kind: 'remote' })}>{t.settings.addRemote}</button>
            </div>
        </div>
    );
}
/** Every section of the settings, the language of the page last. */
function SettingsSections({ agents, onEditing }: { readonly agents: readonly AgentSummary[]; readonly onEditing: (editing: Editing) => void }) {
    return (
        <>
            <SshConnect />
            <FleetDirectory />
            <AgentList agents={agents} onEditing={onEditing} />
            <NotificationSettingsSection />
            <AdminConfirm />
            <LanguageSection />
        </>
    );
}
/**
 * The fleet set up from the page: its directory, its agents added, changed,
 * removed, started and stopped. Everything is written to the agent
 * directories, so the files stay the truth and can still be edited by hand.
 */
function SettingsPanel({ agents }: SettingsPanelProps) {
    const [editing, setEditing] = useState<Editing>();
    const { settings } = useT();
    return (
        <section className="settings" aria-label={settings.label}>
            <h1>{settings.title}</h1>
            {editing === undefined
                ? <SettingsSections agents={agents} onEditing={setEditing} />
                : <AgentEditor editing={editing} onDone={() => setEditing(undefined)} />}
        </section>
    );
}
export { SettingsPanel };
