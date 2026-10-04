import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { AgentSummary, GroupConfig } from '../../../src/dashboard-protocol.js';
import { memberChoices, toGroupConfig, withMember } from '../group-draft.js';
import type { GroupDraft, MemberChoice } from '../group-draft.js';
import { useT } from '../i18n/I18n.js';
import { errorText } from '../i18n/errors.js';
import { Field } from './AgentForm.js';
type GroupFormProps = {
    readonly initial: GroupDraft;
    /** A new group picks its id; a changed one keeps it — the id is its directory. */
    readonly isNew: boolean;
    /** The agents of the fleet, offered as ticks. */
    readonly agents: readonly AgentSummary[];
    /** Resolves once the group is saved; rejects with what the server said is wrong. */
    readonly onSave: (config: GroupConfig) => Promise<void>;
    readonly onCancel: () => void;
    /** A group of the fleet can be deleted from its form (#175); resolves once it is, rejects with what the server said. */
    readonly onDelete?: (() => Promise<void>) | undefined;
};
type Update = <K extends keyof GroupDraft>(key: K, value: GroupDraft[K]) => void;
type FieldsProps = { readonly draft: GroupDraft; readonly update: Update };
function IdentityFields({ draft, update, isNew }: FieldsProps & { readonly isNew: boolean }) {
    const t = useT();
    return (
        <>
            <Field label={t.groupForm.id} hint={isNew ? t.groupForm.idNewHint : t.groupForm.idHint}>
                <input className="input" value={draft.id} readOnly={!isNew} onChange={(event) => update('id', event.target.value)} />
            </Field>
            <Field label={t.groupForm.name} hint={t.groupForm.nameHint}>
                <input className="input" value={draft.name} onChange={(event) => update('name', event.target.value)} />
            </Field>
            <Field label={t.groupForm.topic} hint={t.groupForm.topicHint}>
                <textarea className="textarea" rows={3} value={draft.topic} onChange={(event) => update('topic', event.target.value)} />
            </Field>
        </>
    );
}
/** One agent to tick into the group; one the fleet does not have says so. */
function MemberCheck({ choice, onChange }: { readonly choice: MemberChoice; readonly onChange: (ticked: boolean) => void }) {
    const t = useT();
    return (
        <label className="check" data-member={choice.id} data-in-fleet={choice.inFleet ? 'yes' : 'no'}>
            <input type="checkbox" checked={choice.ticked} onChange={(event) => onChange(event.target.checked)} />
            {' '}{choice.name}
            {choice.inFleet ? null : <span className="kind"> · {t.groups.notInFleet}</span>}
        </label>
    );
}
/** The members as ticks: the agents of the fleet, and the members it does not have. */
function MemberFields({ draft, setDraft, agents }: { readonly draft: GroupDraft; readonly setDraft: (draft: GroupDraft) => void; readonly agents: readonly AgentSummary[] }) {
    const t = useT();
    const id = useId();
    const choices = memberChoices(draft, agents);
    return (
        <div className="field">
            <span className="field-label" id={`${id}-label`}>{t.groupForm.members}</span>
            <fieldset className="checks" aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`}>
                {choices.length === 0 ? <p className="muted">{t.groupForm.noAgents}</p> : null}
                {choices.map((choice) => (
                    <MemberCheck key={choice.id} choice={choice} onChange={(ticked) => setDraft(withMember(draft, choice.id, ticked))} />
                ))}
            </fieldset>
            <span className="field-hint" id={`${id}-hint`}>{t.groupForm.membersHint}</span>
        </div>
    );
}
function OthersField({ draft, update }: FieldsProps) {
    const t = useT();
    return (
        <Field label={t.groupForm.others} hint={t.groupForm.othersHint}>
            <textarea className="textarea" rows={2} value={draft.others} onChange={(event) => update('others', event.target.value)} />
        </Field>
    );
}
function FormFooter({ isNew, error, saving, onCancel }: { readonly isNew: boolean; readonly error: string | undefined; readonly saving: boolean; readonly onCancel: () => void }) {
    const t = useT();
    return (
        <>
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
            <div className="actions">
                <button type="submit" className="btn btn-primary" disabled={saving} aria-busy={saving}>{isNew ? t.groupForm.addGroup : t.common.save}</button>
                <button type="button" className="btn" onClick={onCancel}>{t.common.cancel}</button>
            </div>
        </>
    );
}
function useGroupForm(initial: GroupDraft, onSave: GroupFormProps['onSave']) {
    const [draft, setDraft] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string>();
    const t = useT();
    const update: Update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
    const submit = (event: FormEvent): void => {
        event.preventDefault();
        setError(undefined);
        setSaving(true);
        // The server checks the group the way `flotti run` does; its sentence is the error shown.
        onSave(toGroupConfig(draft)).catch((reason: unknown) => setError(errorText(reason, t))).finally(() => setSaving(false));
    };
    return { draft, setDraft, saving, error, update, submit };
}
/** Deleting the group: asked, then confirmed; what the server said when it refused. */
function useDelete(onDelete: () => Promise<void>) {
    const [confirming, setConfirming] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState<string>();
    const t = useT();
    const remove = (): void => {
        setError(undefined);
        setDeleting(true);
        onDelete().catch((reason: unknown) => {
            setError(errorText(reason, t));
            setDeleting(false);
        });
    };
    return { confirming, setConfirming, deleting, error, remove };
}
type ConfirmProps = { readonly name: string; readonly deleting: boolean; readonly onDelete: () => void; readonly onKeep: () => void };
/** The confirmation that names the group: its directory goes to `.trash/`. */
function ConfirmDelete({ name, deleting, onDelete, onKeep }: ConfirmProps) {
    const t = useT();
    return (
        <div className="actions">
            <span className="note">{t.groups.confirmDelete(name)}</span>
            <button type="button" className="btn btn-sm btn-danger" disabled={deleting} aria-busy={deleting} onClick={onDelete}>{t.common.delete}</button>
            <button type="button" className="btn btn-sm" onClick={onKeep}>{t.groups.keep}</button>
        </div>
    );
}
/** Delete in the editor of a group (#175), then the confirmation. */
function DeleteGroup({ name, onDelete }: { readonly name: string; readonly onDelete: () => Promise<void> }) {
    const { confirming, setConfirming, deleting, error, remove } = useDelete(onDelete);
    const t = useT();
    return (
        <div className="group-delete">
            {confirming
                ? <ConfirmDelete name={name} deleting={deleting} onDelete={remove} onKeep={() => setConfirming(false)} />
                : <div className="actions"><button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}>{t.common.delete}</button></div>}
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </div>
    );
}
/** The heading of the form: New group, or the group by its name — by its id when the file names none. */
function formTitle(initial: GroupDraft, isNew: boolean, newGroup: string): string {
    if (isNew) {
        return newGroup;
    }
    return initial.name === '' ? initial.id : initial.name;
}
/** The group as a person writes it (docs/groups.md); the server checks it before `group.json` is written. */
function GroupForm({ initial, isNew, agents, onSave, onCancel, onDelete }: GroupFormProps) {
    const { draft, setDraft, saving, error, update, submit } = useGroupForm(initial, onSave);
    const t = useT();
    const title = formTitle(initial, isNew, t.groupForm.newGroup);
    return (
        <form className="agent-form" aria-label={isNew ? t.groupForm.newGroup : t.groupForm.groupLabel(initial.id)} onSubmit={submit}>
            <h2>{title}</h2>
            <IdentityFields draft={draft} update={update} isNew={isNew} />
            <MemberFields draft={draft} setDraft={setDraft} agents={agents} />
            <OthersField draft={draft} update={update} />
            <FormFooter isNew={isNew} error={error} saving={saving} onCancel={onCancel} />
            {onDelete === undefined ? null : <DeleteGroup name={title} onDelete={onDelete} />}
        </form>
    );
}
export { GroupForm };
