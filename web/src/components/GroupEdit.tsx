import { useEffect, useState } from 'react';
import type { AgentSummary, GroupConfig, GroupSummary } from '../../../src/dashboard-protocol.js';
import { fromGroupConfig, newGroupDraft } from '../group-draft.js';
import type { GroupDraft } from '../group-draft.js';
import { api } from '../api.js';
import { GroupForm } from './GroupForm.js';
import { useT } from '../i18n/I18n.js';
import { errorText } from '../i18n/errors.js';
type GroupEditProps = {
    readonly group: GroupSummary;
    readonly agents: readonly AgentSummary[];
    /** Saved or cancelled: the lane comes back. */
    readonly onDone: () => void;
    /** The group is deleted: the page leaves its tab. */
    readonly onDeleted: () => void;
};
/** The file of the group as it says it — the name is not filled in with the id — or why it could not be read. */
function useGroupDraft(id: string) {
    const [draft, setDraft] = useState<GroupDraft>();
    const [error, setError] = useState<string>();
    const t = useT();
    useEffect(() => {
        api.groupConfig(id).then((config) => setDraft(fromGroupConfig(config)), (reason: unknown) => setError(errorText(reason, t)));
    }, [id]);
    return { draft, error };
}
/** The file of the group on its way, or why it did not come, with the way back to the lane. */
function GroupLoading({ error, onDone }: { readonly error: string | undefined; readonly onDone: () => void }) {
    const t = useT();
    return (
        <div className="settings-section">
            {error === undefined ? <p className="muted">{t.groups.reading}</p> : <p className="error" role="alert">{error}</p>}
            <div className="actions"><button type="button" className="btn" onClick={onDone}>{t.common.back}</button></div>
        </div>
    );
}
/**
 * The editor of a group in its tab (#175), over the lane: the form with the
 * id read-only, Save and Cancel, and Delete with a confirmation. The server
 * checks the group (`parseGroup`) and says what is wrong.
 */
function GroupEdit({ group, agents, onDone, onDeleted }: GroupEditProps) {
    const { draft, error } = useGroupDraft(group.id);
    const save = async (config: GroupConfig): Promise<void> => {
        await api.updateGroup(config);
        onDone();
    };
    const remove = async (): Promise<void> => {
        await api.removeGroup(group.id);
        onDeleted();
    };
    return (
        <div className="settings group-edit">
            {draft === undefined
                ? <GroupLoading error={error} onDone={onDone} />
                : <GroupForm initial={draft} isNew={false} agents={agents} onSave={save} onCancel={onDone} onDelete={remove} />}
        </div>
    );
}
type NewGroupProps = {
    readonly agents: readonly AgentSummary[];
    /** The group is on disk: its tab opens. */
    readonly onSaved: (id: string) => void;
    /** Where Cancel leads; with nowhere to go, the form starts over. */
    readonly onCancel: (() => void) | undefined;
};
/** Add group, the last tab of the Groups section (#175): the form for a new group, whose id is picked once. */
function NewGroup({ agents, onSaved, onCancel }: NewGroupProps) {
    const [round, setRound] = useState(0);
    const t = useT();
    const save = async (config: GroupConfig): Promise<void> => {
        const group = await api.createGroup(config);
        onSaved(group.id);
    };
    return (
        <section className="settings group-new" aria-label={t.sidebar.addGroup}>
            <GroupForm key={round} initial={newGroupDraft()} isNew agents={agents} onSave={save} onCancel={onCancel ?? (() => setRound((last) => last + 1))} />
        </section>
    );
}
export { GroupEdit, NewGroup };
