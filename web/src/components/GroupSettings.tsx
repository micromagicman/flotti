import { useEffect, useState } from 'react';
import type { AgentSummary, GroupConfig, GroupSummary } from '../../../src/dashboard-protocol.js';
import { fromGroupConfig, newGroupDraft } from '../group-draft.js';
import type { GroupDraft } from '../group-draft.js';
import { api } from '../api.js';
import { GroupForm } from './GroupForm.js';
import { useT } from '../i18n/I18n.js';
import { errorText } from '../i18n/errors.js';
/** What is being edited: a new group, or a group of the fleet. */
type GroupEditing =
    | { readonly mode: 'new-group' }
    | { readonly mode: 'edit-group'; readonly id: string };
type Run = (action: () => Promise<unknown>) => void;
/** One member by name; one the fleet does not have is named by id and says so. */
function Member({ id, agents }: { readonly id: string; readonly agents: readonly AgentSummary[] }) {
    const t = useT();
    const agent = agents.find((candidate) => candidate.id === id);
    return (
        <span data-member={id}>
            {agent?.name ?? id}{agent === undefined ? <span className="kind"> · {t.groups.notInFleet}</span> : null}
        </span>
    );
}
/** The members in the order of the group, with commas between. */
function GroupMembers({ group, agents }: { readonly group: GroupSummary; readonly agents: readonly AgentSummary[] }) {
    const t = useT();
    if (group.members.length === 0) {
        return <span className="muted">{t.groups.noMembers}</span>;
    }
    return (
        <span className="settings-group-members">
            {group.members.map((member, index) => (
                <span key={member}>{index === 0 ? '' : ', '}<Member id={member} agents={agents} /></span>
            ))}
        </span>
    );
}
function GroupRowTitle({ group, agents }: { readonly group: GroupSummary; readonly agents: readonly AgentSummary[] }) {
    const t = useT();
    return (
        <div className="settings-agent-title">
            <span className="settings-agent-name">{group.name}</span>
            <span className="kind">{group.id} · {t.groups.members(group.members.length)}</span>
            <GroupMembers group={group} agents={agents} />
            {group.topic === undefined ? null : <span className="description">{group.topic}</span>}
        </div>
    );
}
function ConfirmDelete({ group, run, onKeep }: { readonly group: GroupSummary; readonly run: Run; readonly onKeep: () => void }) {
    const t = useT();
    return (
        <div className="actions">
            <span className="note">{t.groups.confirmDelete(group.name)}</span>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => run(() => api.removeGroup(group.id))}>{t.common.delete}</button>
            <button type="button" className="btn btn-sm" onClick={onKeep}>{t.groups.keep}</button>
        </div>
    );
}
function GroupActions({ onEdit, onDelete }: { readonly onEdit: () => void; readonly onDelete: () => void }) {
    const t = useT();
    return (
        <div className="actions">
            <button type="button" className="btn btn-sm" onClick={onEdit}>{t.common.edit}</button>
            <button type="button" className="btn btn-sm" onClick={onDelete}>{t.common.delete}</button>
        </div>
    );
}
type GroupRowProps = { readonly group: GroupSummary; readonly agents: readonly AgentSummary[]; readonly onEdit: () => void };
function GroupRow({ group, agents, onEdit }: GroupRowProps) {
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string>();
    const t = useT();
    const run: Run = (action) => {
        setError(undefined);
        action().catch((reason: unknown) => setError(errorText(reason, t)));
    };
    return (
        <li className="settings-agent" data-group={group.id} aria-label={group.name}>
            <GroupRowTitle group={group} agents={agents} />
            {confirming
                ? <ConfirmDelete group={group} run={run} onKeep={() => setConfirming(false)} />
                : <GroupActions onEdit={onEdit} onDelete={() => setConfirming(true)} />}
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </li>
    );
}
type GroupListProps = {
    readonly groups: readonly GroupSummary[];
    readonly agents: readonly AgentSummary[];
    readonly onEditing: (editing: GroupEditing) => void;
};
/** The groups of the fleet (docs/groups.md), listed and managed the way the agents are; the list follows the socket. */
function GroupList({ groups, agents, onEditing }: GroupListProps) {
    const t = useT();
    return (
        <div className="settings-section">
            <h2>{t.groups.title}</h2>
            {groups.length === 0 ? <p className="muted">{t.groups.noGroups}</p> : null}
            <ul className="settings-agents" aria-label={t.groups.title}>
                {groups.map((group) => (
                    <GroupRow key={group.id} group={group} agents={agents} onEdit={() => onEditing({ mode: 'edit-group', id: group.id })} />
                ))}
            </ul>
            <div className="actions">
                <button type="button" className="btn" onClick={() => onEditing({ mode: 'new-group' })}>{t.groups.addGroup}</button>
            </div>
        </div>
    );
}
function GroupLoading({ error, onDone }: { readonly error: string | undefined; readonly onDone: () => void }) {
    const t = useT();
    return (
        <div className="settings-section">
            {error === undefined ? <p className="muted">{t.groups.reading}</p> : <p className="error" role="alert">{error}</p>}
            <div className="actions"><button type="button" className="btn" onClick={onDone}>{t.common.back}</button></div>
        </div>
    );
}
type GroupEditorProps = { readonly editing: GroupEditing; readonly agents: readonly AgentSummary[]; readonly onDone: () => void };
/** Reads the file of the group being changed, then shows the form with it. */
function GroupEditor({ editing, agents, onDone }: GroupEditorProps) {
    const [draft, setDraft] = useState<GroupDraft | undefined>(editing.mode === 'new-group' ? newGroupDraft() : undefined);
    const [error, setError] = useState<string>();
    const t = useT();
    useEffect(() => {
        if (editing.mode === 'edit-group') {
            api.groupConfig(editing.id).then((config) => setDraft(fromGroupConfig(config)), (reason: unknown) => setError(errorText(reason, t)));
        }
    }, [editing]);
    const save = async (config: GroupConfig): Promise<void> => {
        await (editing.mode === 'new-group' ? api.createGroup(config) : api.updateGroup(config));
        onDone();
    };
    if (draft === undefined) {
        return <GroupLoading error={error} onDone={onDone} />;
    }
    return <GroupForm initial={draft} isNew={editing.mode === 'new-group'} agents={agents} onSave={save} onCancel={onDone} />;
}
export { GroupEditor, GroupList };
export type { GroupEditing };
