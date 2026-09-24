import { cloneElement, useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { AgentConfig } from '../../../src/dashboard-protocol.js';
import type { LocalAgentAdapter, RemoteAuth, RestartPolicy } from '../../../src/types.js';
import { toConfig, withAdapter } from '../agent-draft.js';
import type { Draft } from '../agent-draft.js';
type AgentFormProps = {
    readonly initial: Draft;
    /** A new agent picks its id; a changed one keeps it — the id is its directory. */
    readonly isNew: boolean;
    /** Resolves once the agent is saved; rejects with what the server said is wrong. */
    readonly onSave: (config: AgentConfig) => Promise<void>;
    readonly onCancel: () => void;
};
/** A label, the control it names and a hint that describes it; the hint is not part of the name. */
function Field({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: ReactElement<{ id?: string; 'aria-describedby'?: string }> }) {
    const id = useId();
    return (
        <div className="field">
            <label className="field-label" htmlFor={id}>{label}</label>
            {cloneElement(children, { id, ...(hint === undefined ? {} : { 'aria-describedby': `${id}-hint` }) })}
            {hint === undefined ? null : <span className="field-hint" id={`${id}-hint`}>{hint}</span>}
        </div>
    );
}
type Update = <K extends keyof Draft>(key: K, value: Draft[K]) => void;
type FieldsProps = { readonly draft: Draft; readonly update: Update };
/** The adapter and what it runs. */
function CommandFields({ draft, update, setDraft }: FieldsProps & { readonly setDraft: (draft: Draft) => void }) {
    return (
        <>
            <Field label="Adapter" hint="Which ACP adapter the command starts; picking one fills in its command.">
                <select value={draft.adapter} onChange={(event) => setDraft(withAdapter(draft, event.target.value as LocalAgentAdapter | ''))}>
                    <option value="claude-code">Claude Code</option>
                    <option value="codex">Codex</option>
                    <option value="">Plain ACP</option>
                </select>
            </Field>
            <Field label="Command" hint="Executable to run.">
                <input value={draft.command} onChange={(event) => update('command', event.target.value)} />
            </Field>
            <Field label="Arguments" hint="One per line.">
                <textarea rows={3} value={draft.arguments} onChange={(event) => update('arguments', event.target.value)} />
            </Field>
        </>
    );
}
/** The model, and where and with what environment the command runs. */
function PlaceFields({ draft, update }: FieldsProps) {
    return (
        <>
            <Field label="Model" hint="Empty: the adapter's own default.">
                <input value={draft.model} onChange={(event) => update('model', event.target.value)} />
            </Field>
            <Field label="Host" hint="Empty: this machine. user@host: flotti starts the agent there over SSH with your key; the command, the working directory and everything the agent does are on that host.">
                <input value={draft.sshTarget} placeholder="user@host" onChange={(event) => update('sshTarget', event.target.value)} />
            </Field>
            <Field label="Working directory" hint={draft.sshTarget.trim() === '' ? 'Empty: the agent directory. ~ and relative paths are fine.' : 'A path on the host. Empty: the home directory there.'}>
                <input value={draft.workdir} onChange={(event) => update('workdir', event.target.value)} />
            </Field>
            <Field label="Environment" hint="NAME=value, one per line. Keep secrets out: this is written to agent.json.">
                <textarea rows={3} value={draft.env} onChange={(event) => update('env', event.target.value)} />
            </Field>
        </>
    );
}
/** When the agent is restarted and when it counts as hung. */
function RestartFields({ draft, update }: FieldsProps) {
    return (
        <div className="field-row">
            <Field label="Restart">
                <select value={draft.restart} onChange={(event) => update('restart', event.target.value as RestartPolicy | '')}>
                    <option value="">default (on failure)</option>
                    <option value="always">always</option>
                    <option value="on-failure">on failure</option>
                    <option value="never">never</option>
                </select>
            </Field>
            <Field label="Heartbeat timeout, s" hint="Empty: 60.">
                <input inputMode="numeric" value={draft.heartbeatTimeoutSec} onChange={(event) => update('heartbeatTimeoutSec', event.target.value)} />
            </Field>
        </div>
    );
}
function LocalFields({ draft, update, setDraft }: { readonly draft: Draft; readonly update: Update; readonly setDraft: (draft: Draft) => void }) {
    return (
        <>
            <CommandFields draft={draft} update={update} setDraft={setDraft} />
            <PlaceFields draft={draft} update={update} />
            <RestartFields draft={draft} update={update} />
            <Field label="System prompt" hint="Kept in system-prompt.md next to the manifest.">
                <textarea rows={6} value={draft.systemPrompt} onChange={(event) => update('systemPrompt', event.target.value)} />
            </Field>
        </>
    );
}
function PublishedAgentField({ draft, update }: FieldsProps) {
    return (
        <Field label="Published agent" hint="Empty: the only one the host publishes.">
            <input value={draft.sshAgent} onChange={(event) => update('sshAgent', event.target.value)} />
        </Field>
    );
}
function UrlField({ draft, update }: FieldsProps) {
    return (
        <Field label="URL" hint="Address of the agent, http: or https:.">
            <input value={draft.url} onChange={(event) => update('url', event.target.value)} />
        </Field>
    );
}
/** Where the agent is: a host over SSH, or an address. */
function WhereFields({ draft, update }: { readonly draft: Draft; readonly update: Update }) {
    const overSsh = draft.sshTarget.trim() !== '';
    return (
        <>
            <div className="field-row">
                <Field label="SSH" hint="user@host: flotti opens the tunnel and gets the address and the token itself. Empty: reach the agent at URL.">
                    <input value={draft.sshTarget} placeholder="user@host" onChange={(event) => update('sshTarget', event.target.value)} />
                </Field>
                {overSsh ? <PublishedAgentField draft={draft} update={update} /> : null}
            </div>
            {overSsh ? null : <UrlField draft={draft} update={update} />}
        </>
    );
}
function AuthTypeField({ draft, update }: FieldsProps) {
    const overSsh = draft.sshTarget.trim() !== '';
    return (
        <Field label="Authentication" hint={overSsh ? 'Over SSH, the token the host publishes wins; this is for a host that publishes none.' : undefined}>
            <select value={draft.authType} onChange={(event) => update('authType', event.target.value as RemoteAuth['type'])}>
                <option value="none">none</option>
                <option value="bearer">bearer token</option>
                <option value="api-key">API key header</option>
            </select>
        </Field>
    );
}
function TokenEnvField({ draft, update }: FieldsProps) {
    return (
        <Field label="Token variable" hint="Environment variable with the token; the token itself stays out of the manifest.">
            <input value={draft.tokenEnv} onChange={(event) => update('tokenEnv', event.target.value)} />
        </Field>
    );
}
function ApiKeyFields({ draft, update }: FieldsProps) {
    return (
        <div className="field-row">
            <Field label="Header">
                <input value={draft.header} onChange={(event) => update('header', event.target.value)} />
            </Field>
            <Field label="Value variable" hint="Environment variable with the key.">
                <input value={draft.valueEnv} onChange={(event) => update('valueEnv', event.target.value)} />
            </Field>
        </div>
    );
}
function RemoteFields({ draft, update }: { readonly draft: Draft; readonly update: Update }) {
    return (
        <>
            <WhereFields draft={draft} update={update} />
            <AuthTypeField draft={draft} update={update} />
            {draft.authType === 'bearer' ? <TokenEnvField draft={draft} update={update} /> : null}
            {draft.authType === 'api-key' ? <ApiKeyFields draft={draft} update={update} /> : null}
        </>
    );
}
/** Checks the draft, then hands it to the server; what either says is wrong ends up in the error. */
function saveDraft(draft: Draft, onSave: AgentFormProps['onSave'], setError: (error: string | undefined) => void, setSaving: (saving: boolean) => void): void {
    setError(undefined);
    let config: AgentConfig;
    try {
        config = toConfig(draft);
    } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        return;
    }
    setSaving(true);
    onSave(config).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => setSaving(false));
}
function useAgentForm(initial: Draft, onSave: AgentFormProps['onSave']) {
    const [draft, setDraft] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string>();
    const update: Update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
    const submit = (event: FormEvent): void => {
        event.preventDefault();
        saveDraft(draft, onSave, setError, setSaving);
    };
    return { draft, setDraft, saving, error, update, submit };
}
function IdentityFields({ draft, update, isNew }: FieldsProps & { readonly isNew: boolean }) {
    return (
        <>
            <Field label="Id" hint={isNew ? 'Names the agent directory: letters, digits, ".", "_" and "-".' : 'The id is the directory name and stays.'}>
                <input value={draft.id} readOnly={!isNew} onChange={(event) => update('id', event.target.value)} />
            </Field>
            <Field label="Name" hint="Empty: the id.">
                <input value={draft.name} onChange={(event) => update('name', event.target.value)} />
            </Field>
            <Field label="Description">
                <input value={draft.description} onChange={(event) => update('description', event.target.value)} />
            </Field>
            <AdminField draft={draft} update={update} />
        </>
    );
}
/** The role of an administrator: only a person gives and takes it, here or in the manifest. */
function AdminField({ draft, update }: FieldsProps) {
    const id = useId();
    return (
        <div className="field field-check">
            <label>
                <input type="checkbox" checked={draft.admin} aria-describedby={`${id}-hint`} onChange={(event) => update('admin', event.target.checked)} />
                {' '}Administrator
            </label>
            <span className="field-hint" id={`${id}-hint`}>
                May restart the agents of the fleet and clear their context, itself included, with the tools of an
                administrator. Only a person gives and takes this role.
            </span>
        </div>
    );
}
function FormFooter({ isNew, error, saving, onCancel }: { readonly isNew: boolean; readonly error: string | undefined; readonly saving: boolean; readonly onCancel: () => void }) {
    return (
        <>
            {isNew ? null : <p className="note">Saving restarts the agent with the new settings, unless it is stopped.</p>}
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
            <div className="actions">
                <button type="submit" className="primary" disabled={saving}>{isNew ? 'Add agent' : 'Save'}</button>
                <button type="button" onClick={onCancel}>Cancel</button>
            </div>
        </>
    );
}
/** Every field of the manifest a person sets by hand; the server checks it before a file is written. */
function AgentForm({ initial, isNew, onSave, onCancel }: AgentFormProps) {
    const { draft, setDraft, saving, error, update, submit } = useAgentForm(initial, onSave);
    const title = isNew ? `New ${draft.kind} agent` : `${initial.name === '' ? initial.id : initial.name}`;
    return (
        <form className="agent-form" aria-label={isNew ? `New ${draft.kind} agent` : `Agent ${initial.id}`} onSubmit={submit}>
            <h2>{title} <span className="kind">{draft.kind === 'local' ? 'local · ACP' : 'remote · A2A'}</span></h2>
            <IdentityFields draft={draft} update={update} isNew={isNew} />
            {draft.kind === 'local'
                ? <LocalFields draft={draft} update={update} setDraft={setDraft} />
                : <RemoteFields draft={draft} update={update} />}
            <FormFooter isNew={isNew} error={error} saving={saving} onCancel={onCancel} />
        </form>
    );
}
export { AgentForm, Field };
