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
function LocalFields({ draft, update, setDraft }: { readonly draft: Draft; readonly update: Update; readonly setDraft: (draft: Draft) => void }) {
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
            <Field label="System prompt" hint="Kept in system-prompt.md next to the manifest.">
                <textarea rows={6} value={draft.systemPrompt} onChange={(event) => update('systemPrompt', event.target.value)} />
            </Field>
        </>
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
                {overSsh
                    ? (
                        <Field label="Published agent" hint="Empty: the only one the host publishes.">
                            <input value={draft.sshAgent} onChange={(event) => update('sshAgent', event.target.value)} />
                        </Field>
                    )
                    : null}
            </div>
            {overSsh
                ? null
                : (
                    <Field label="URL" hint="Address of the agent, http: or https:.">
                        <input value={draft.url} onChange={(event) => update('url', event.target.value)} />
                    </Field>
                )}
        </>
    );
}
function RemoteFields({ draft, update }: { readonly draft: Draft; readonly update: Update }) {
    const overSsh = draft.sshTarget.trim() !== '';
    return (
        <>
            <WhereFields draft={draft} update={update} />
            <Field label="Authentication" hint={overSsh ? 'Over SSH, the token the host publishes wins; this is for a host that publishes none.' : undefined}>
                <select value={draft.authType} onChange={(event) => update('authType', event.target.value as RemoteAuth['type'])}>
                    <option value="none">none</option>
                    <option value="bearer">bearer token</option>
                    <option value="api-key">API key header</option>
                </select>
            </Field>
            {draft.authType === 'bearer'
                ? (
                    <Field label="Token variable" hint="Environment variable with the token; the token itself stays out of the manifest.">
                        <input value={draft.tokenEnv} onChange={(event) => update('tokenEnv', event.target.value)} />
                    </Field>
                )
                : null}
            {draft.authType === 'api-key'
                ? (
                    <div className="field-row">
                        <Field label="Header">
                            <input value={draft.header} onChange={(event) => update('header', event.target.value)} />
                        </Field>
                        <Field label="Value variable" hint="Environment variable with the key.">
                            <input value={draft.valueEnv} onChange={(event) => update('valueEnv', event.target.value)} />
                        </Field>
                    </div>
                )
                : null}
        </>
    );
}
/** Every field of the manifest a person sets by hand; the server checks it before a file is written. */
function AgentForm({ initial, isNew, onSave, onCancel }: AgentFormProps) {
    const [draft, setDraft] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string>();
    const update: Update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
    const submit = (event: FormEvent): void => {
        event.preventDefault();
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
    };
    const title = isNew ? `New ${draft.kind} agent` : `${initial.name === '' ? initial.id : initial.name}`;
    return (
        <form className="agent-form" aria-label={isNew ? `New ${draft.kind} agent` : `Agent ${initial.id}`} onSubmit={submit}>
            <h2>{title} <span className="kind">{draft.kind === 'local' ? 'local · ACP' : 'remote · A2A'}</span></h2>
            <Field label="Id" hint={isNew ? 'Names the agent directory: letters, digits, ".", "_" and "-".' : 'The id is the directory name and stays.'}>
                <input value={draft.id} readOnly={!isNew} onChange={(event) => update('id', event.target.value)} />
            </Field>
            <Field label="Name" hint="Empty: the id.">
                <input value={draft.name} onChange={(event) => update('name', event.target.value)} />
            </Field>
            <Field label="Description">
                <input value={draft.description} onChange={(event) => update('description', event.target.value)} />
            </Field>
            {draft.kind === 'local'
                ? <LocalFields draft={draft} update={update} setDraft={setDraft} />
                : <RemoteFields draft={draft} update={update} />}
            {isNew ? null : <p className="note">Saving restarts the agent with the new settings, unless it is stopped.</p>}
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
            <div className="actions">
                <button type="submit" className="primary" disabled={saving}>{isNew ? 'Add agent' : 'Save'}</button>
                <button type="button" onClick={onCancel}>Cancel</button>
            </div>
        </form>
    );
}
export { AgentForm };
