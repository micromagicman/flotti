import { cloneElement, useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { AgentConfig } from '../../../src/dashboard-protocol.js';
import type { LocalAgentAdapter, RemoteAuth, RestartPolicy } from '../../../src/types.js';
import { toConfig, withAdapter } from '../agent-draft.js';
import type { Draft } from '../agent-draft.js';
import { useT } from '../i18n/I18n.js';
import { errorText } from '../i18n/errors.js';
import type { Messages } from '../i18n/en.js';
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
    const t = useT();
    return (
        <>
            <Field label={t.form.adapter} hint={t.form.adapterHint}>
                <select className="select" value={draft.adapter} onChange={(event) => setDraft(withAdapter(draft, event.target.value as LocalAgentAdapter | ''))}>
                    <option value="claude-code">Claude Code</option>
                    <option value="codex">Codex</option>
                    <option value="">{t.form.plainAcp}</option>
                </select>
            </Field>
            <Field label={t.form.command} hint={t.form.commandHint}>
                <input className="input" value={draft.command} onChange={(event) => update('command', event.target.value)} />
            </Field>
            <Field label={t.form.arguments} hint={t.form.argumentsHint}>
                <textarea className="textarea" rows={3} value={draft.arguments} onChange={(event) => update('arguments', event.target.value)} />
            </Field>
        </>
    );
}
/** The model, and where and with what environment the command runs. */
function PlaceFields({ draft, update }: FieldsProps) {
    const t = useT();
    return (
        <>
            <Field label={t.form.model} hint={t.form.modelHint}>
                <input className="input" value={draft.model} onChange={(event) => update('model', event.target.value)} />
            </Field>
            <Field label={t.form.host} hint={t.form.hostHint}>
                <input className="input" value={draft.sshTarget} placeholder="user@host" onChange={(event) => update('sshTarget', event.target.value)} />
            </Field>
            <Field label={t.form.workdir} hint={draft.sshTarget.trim() === '' ? t.form.workdirHint : t.form.workdirRemoteHint}>
                <input className="input" value={draft.workdir} onChange={(event) => update('workdir', event.target.value)} />
            </Field>
            <Field label={t.form.environment} hint={t.form.environmentHint}>
                <textarea className="textarea" rows={3} value={draft.env} onChange={(event) => update('env', event.target.value)} />
            </Field>
        </>
    );
}
/** When the agent is restarted and when it counts as hung. */
function RestartFields({ draft, update }: FieldsProps) {
    const t = useT();
    return (
        <div className="field-row">
            <Field label={t.form.restart}>
                <select className="select" value={draft.restart} onChange={(event) => update('restart', event.target.value as RestartPolicy | '')}>
                    <option value="">{t.form.restartDefault}</option>
                    <option value="always">{t.form.restartAlways}</option>
                    <option value="on-failure">{t.form.restartOnFailure}</option>
                    <option value="never">{t.form.restartNever}</option>
                </select>
            </Field>
            <Field label={t.form.heartbeat} hint={t.form.heartbeatHint}>
                <input className="input" inputMode="numeric" value={draft.heartbeatTimeoutSec} onChange={(event) => update('heartbeatTimeoutSec', event.target.value)} />
            </Field>
        </div>
    );
}
function LocalFields({ draft, update, setDraft }: { readonly draft: Draft; readonly update: Update; readonly setDraft: (draft: Draft) => void }) {
    const t = useT();
    return (
        <>
            <CommandFields draft={draft} update={update} setDraft={setDraft} />
            <PlaceFields draft={draft} update={update} />
            <RestartFields draft={draft} update={update} />
            <Field label={t.form.systemPrompt} hint={t.form.systemPromptHint}>
                <textarea className="textarea" rows={6} value={draft.systemPrompt} onChange={(event) => update('systemPrompt', event.target.value)} />
            </Field>
        </>
    );
}
function PublishedAgentField({ draft, update }: FieldsProps) {
    const t = useT();
    return (
        <Field label={t.form.publishedAgent} hint={t.form.publishedAgentHint}>
            <input className="input" value={draft.sshAgent} onChange={(event) => update('sshAgent', event.target.value)} />
        </Field>
    );
}
function UrlField({ draft, update }: FieldsProps) {
    const t = useT();
    return (
        <Field label={t.form.url} hint={t.form.urlHint}>
            <input className="input" value={draft.url} onChange={(event) => update('url', event.target.value)} />
        </Field>
    );
}
/** Where the agent is: a host over SSH, or an address. */
function WhereFields({ draft, update }: { readonly draft: Draft; readonly update: Update }) {
    const overSsh = draft.sshTarget.trim() !== '';
    const t = useT();
    return (
        <>
            <div className="field-row">
                <Field label={t.form.ssh} hint={t.form.sshHint}>
                    <input className="input" value={draft.sshTarget} placeholder="user@host" onChange={(event) => update('sshTarget', event.target.value)} />
                </Field>
                {overSsh ? <PublishedAgentField draft={draft} update={update} /> : null}
            </div>
            {overSsh ? null : <UrlField draft={draft} update={update} />}
        </>
    );
}
function AuthTypeField({ draft, update }: FieldsProps) {
    const t = useT();
    const overSsh = draft.sshTarget.trim() !== '';
    return (
        <Field label={t.form.auth} hint={overSsh ? t.form.authSshHint : undefined}>
            <select className="select" value={draft.authType} onChange={(event) => update('authType', event.target.value as RemoteAuth['type'])}>
                <option value="none">{t.form.authNone}</option>
                <option value="bearer">{t.form.authBearer}</option>
                <option value="api-key">{t.form.authApiKey}</option>
            </select>
        </Field>
    );
}
function TokenEnvField({ draft, update }: FieldsProps) {
    const t = useT();
    return (
        <Field label={t.form.tokenEnv} hint={t.form.tokenEnvHint}>
            <input className="input" value={draft.tokenEnv} onChange={(event) => update('tokenEnv', event.target.value)} />
        </Field>
    );
}
function ApiKeyFields({ draft, update }: FieldsProps) {
    const t = useT();
    return (
        <div className="field-row">
            <Field label={t.form.header}>
                <input className="input" value={draft.header} onChange={(event) => update('header', event.target.value)} />
            </Field>
            <Field label={t.form.valueEnv} hint={t.form.valueEnvHint}>
                <input className="input" value={draft.valueEnv} onChange={(event) => update('valueEnv', event.target.value)} />
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
type Saving = {
    readonly t: Messages;
    readonly setError: (error: string | undefined) => void;
    readonly setSaving: (saving: boolean) => void;
};
function saveDraft(draft: Draft, onSave: AgentFormProps['onSave'], { t, setError, setSaving }: Saving): void {
    setError(undefined);
    let config: AgentConfig;
    try {
        config = toConfig(draft, t);
    } catch (reason) {
        setError(errorText(reason, t));
        return;
    }
    setSaving(true);
    onSave(config).catch((reason: unknown) => {
        setError(errorText(reason, t));
    }).finally(() => setSaving(false));
}
function useAgentForm(initial: Draft, onSave: AgentFormProps['onSave']) {
    const [draft, setDraft] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string>();
    const t = useT();
    const update: Update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
    const submit = (event: FormEvent): void => {
        event.preventDefault();
        saveDraft(draft, onSave, { t, setError, setSaving });
    };
    return { draft, setDraft, saving, error, update, submit };
}
function IdentityFields({ draft, update, isNew }: FieldsProps & { readonly isNew: boolean }) {
    const t = useT();
    return (
        <>
            <Field label={t.form.id} hint={isNew ? t.form.idNewHint : t.form.idHint}>
                <input className="input" value={draft.id} readOnly={!isNew} onChange={(event) => update('id', event.target.value)} />
            </Field>
            <Field label={t.form.name} hint={t.form.nameHint}>
                <input className="input" value={draft.name} onChange={(event) => update('name', event.target.value)} />
            </Field>
            <Field label={t.form.description}>
                <input className="input" value={draft.description} onChange={(event) => update('description', event.target.value)} />
            </Field>
            <AdminField draft={draft} update={update} />
        </>
    );
}
/** The role of an administrator: only a person gives and takes it, here or in the manifest. */
function AdminField({ draft, update }: FieldsProps) {
    const id = useId();
    const t = useT();
    return (
        <div className="field field-check">
            <label className="check">
                <input type="checkbox" checked={draft.admin} aria-describedby={`${id}-hint`} onChange={(event) => update('admin', event.target.checked)} />
                {' '}{t.form.administrator}
            </label>
            <span className="field-hint" id={`${id}-hint`}>{t.form.administratorHint}</span>
        </div>
    );
}
function FormFooter({ isNew, error, saving, onCancel }: { readonly isNew: boolean; readonly error: string | undefined; readonly saving: boolean; readonly onCancel: () => void }) {
    const t = useT();
    return (
        <>
            {isNew ? null : <p className="note">{t.form.restartsOnSave}</p>}
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
            <div className="actions">
                <button type="submit" className="btn btn-primary" disabled={saving} aria-busy={saving}>{isNew ? t.form.addAgent : t.common.save}</button>
                <button type="button" className="btn" onClick={onCancel}>{t.common.cancel}</button>
            </div>
        </>
    );
}
/** Every field of the manifest a person sets by hand; the server checks it before a file is written. */
function AgentForm({ initial, isNew, onSave, onCancel }: AgentFormProps) {
    const { draft, setDraft, saving, error, update, submit } = useAgentForm(initial, onSave);
    const t = useT();
    const title = isNew ? t.form.newAgent(draft.kind) : `${initial.name === '' ? initial.id : initial.name}`;
    return (
        <form className="agent-form" aria-label={isNew ? t.form.newAgent(draft.kind) : t.form.agentLabel(initial.id)} onSubmit={submit}>
            <h2>{title} <span className="kind">{draft.kind === 'local' ? t.common.localKind : t.common.remoteKind}</span></h2>
            <IdentityFields draft={draft} update={update} isNew={isNew} />
            {draft.kind === 'local'
                ? <LocalFields draft={draft} update={update} setDraft={setDraft} />
                : <RemoteFields draft={draft} update={update} />}
            <FormFooter isNew={isNew} error={error} saving={saving} onCancel={onCancel} />
        </form>
    );
}
export { AgentForm, Field };
