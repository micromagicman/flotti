/**
 * The group form as fields, and the way to and from `group.json`. Pure, like
 * agent-draft.ts: the form in components/GroupForm.tsx only renders it.
 */
import type { AgentSummary, GroupConfig } from '../../src/dashboard-protocol.js';
type GroupDraft = {
    /** Names the group directory: picked once, kept on a change. */
    readonly id: string;
    readonly name: string;
    readonly topic: string;
    /** Ids of the members, in the order they were added: the agents ticked, and the ids the file had. */
    readonly members: readonly string[];
    /** Ids typed by hand, one per line — agents that are not in the fleet yet; joined to the members when saved. */
    readonly others: string;
};
/** An agent a person may tick into the group: one of the fleet, or a member the fleet does not have. */
type MemberChoice = {
    readonly id: string;
    readonly name: string;
    readonly inFleet: boolean;
    readonly ticked: boolean;
};
const EMPTY: GroupDraft = { id: '', name: '', topic: '', members: [], others: '' };
function newGroupDraft(): GroupDraft {
    return EMPTY;
}
/** The file as it says it: the name is not filled in with the id. */
function fromGroupConfig(config: GroupConfig): GroupDraft {
    return { ...EMPTY, id: config.id, name: config.name ?? '', topic: config.topic ?? '', members: config.members };
}
function lines(text: string): string[] {
    return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}
/** Each id once, in the order first met. */
function unique(ids: readonly string[]): string[] {
    return ids.filter((id, index) => ids.indexOf(id) === index);
}
function optional<K extends string>(key: K, value: string): Partial<Record<K, string>> {
    return value === '' ? {} : { [key]: value } as Record<K, string>;
}
/**
 * The group file the draft says: the ticked members first, then the ids typed
 * by hand, each once. The server checks it the way `flotti run` does — the
 * id, and each member id — so nothing is checked here.
 */
function toGroupConfig(draft: GroupDraft): GroupConfig {
    return {
        id: draft.id.trim(),
        ...optional('name', draft.name.trim()),
        ...optional('topic', draft.topic.trim()),
        members: unique([...draft.members, ...lines(draft.others)])
    };
}
/** The member ticked or unticked: a new one goes last, as it was added last; what is so already stays as it is. */
function withMember(draft: GroupDraft, id: string, ticked: boolean): GroupDraft {
    if (draft.members.includes(id) === ticked) {
        return draft;
    }
    return { ...draft, members: ticked ? [...draft.members, id] : draft.members.filter((member) => member !== id) };
}
/**
 * What the form offers to tick: every agent of the fleet, in the order of the
 * fleet, then the members the fleet does not have — deleted, or typed by
 * hand — which are kept and shown so (docs/groups.md).
 */
function memberChoices(draft: GroupDraft, agents: readonly Pick<AgentSummary, 'id' | 'name'>[]): MemberChoice[] {
    const ofFleet = agents.map((agent) => ({ id: agent.id, name: agent.name, inFleet: true, ticked: draft.members.includes(agent.id) }));
    const strangers = draft.members
        .filter((member) => !agents.some((agent) => agent.id === member))
        .map((member) => ({ id: member, name: member, inFleet: false, ticked: true }));
    return [...ofFleet, ...strangers];
}
export { fromGroupConfig, memberChoices, newGroupDraft, toGroupConfig, withMember };
export type { GroupDraft, MemberChoice };
