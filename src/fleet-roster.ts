import type { AgentSummary } from './dashboard-protocol.js';
import type { GroupView, PeerSummary } from './groups.js';
/**
 * One agent of the fleet as a remote agent sees it through the fleet extension
 * (docs/a2a-fleet.md): what `list_agents` tells a local one, without what only
 * the dashboard needs — the health of a connection, the memory.
 */
type RosterEntry = Pick<AgentSummary, 'id' | 'name' | 'kind' | 'description' | 'harness' | 'status' | 'admin'> & {
    /** Ids of the groups the agent shares with the one the roster is for; its own groups on its own entry. */
    readonly groups: readonly string[];
    /** The entry of the agent the roster is for. */
    readonly you?: true;
};
/**
 * The fleet as it is handed to a remote agent: the agents it can write to —
 * those in a group with it (docs/groups.md) — its groups, and the same as text
 * for a model.
 */
type Roster = {
    /** Grows with every roster the agent is sent: the greatest one is the latest. */
    readonly version: number;
    readonly agents: readonly RosterEntry[];
    readonly groups: readonly GroupView[];
    readonly text: string;
};
/** The entries of the fleet for the agent `self`: its own is marked `you`. */
function rosterEntries(agents: readonly PeerSummary[], self: string): RosterEntry[] {
    return agents.map(agent => ({
        id: agent.id,
        name: agent.name,
        kind: agent.kind,
        ...described(agent),
        status: agent.status,
        groups: agent.groups,
        ...marks(agent, self)
    }));
}
/** The description and the harness of an agent, those it has. */
function described(agent: AgentSummary): Pick<RosterEntry, 'description' | 'harness'> {
    return {
        ...(agent.description === undefined ? {} : { description: agent.description }),
        ...(agent.harness === undefined ? {} : { harness: agent.harness })
    };
}
/** The marks of an entry: an administrator, the agent the roster is for. */
function marks(agent: AgentSummary, self: string): Pick<RosterEntry, 'admin' | 'you'> {
    return {
        ...(agent.admin === true ? { admin: true as const } : {}),
        ...(agent.id === self ? { you: true as const } : {})
    };
}
/** What the roster says of the agents in it: who they are, and how to write to one. */
const AGENTS_TEXT = 'The agents of the flotti fleet you can write to — those in a group with you; your own entry is '
    + 'marked "you", administrators of the fleet "admin", and "groups" of an entry names the groups you share. To '
    + 'write to one, put its id in "to" of a message through the inbox.';
/** What the roster says when the agent is in no group with anyone. */
const NOBODY_TEXT = 'You are not in a group with anyone yet, so there is no agent you can write to: a person puts '
    + 'agents in groups in the settings of flotti.';
/** The roster with its version, and the text an adapter can hand to its model as it is. */
function roster(version: number, agents: readonly RosterEntry[], groups: readonly GroupView[]): Roster {
    const text = `${agents.length === 0 ? NOBODY_TEXT : AGENTS_TEXT}\n${JSON.stringify(agents, null, 2)}\n`
        + `Your groups — the name and the topic of each, and its members:\n${JSON.stringify(groups, null, 2)}`;
    return { version, agents, groups, text };
}
export { roster, rosterEntries };
export type { Roster, RosterEntry };
