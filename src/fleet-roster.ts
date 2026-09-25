import type { AgentSummary } from './dashboard-protocol.js';
/**
 * One agent of the fleet as a remote agent sees it through the fleet extension
 * (docs/a2a-fleet.md): what `list_agents` tells a local one, without what only
 * the dashboard needs — the health of a connection, the memory.
 */
type RosterEntry = Pick<AgentSummary, 'id' | 'name' | 'kind' | 'description' | 'harness' | 'status' | 'admin'> & {
    /** The entry of the agent the roster is for. */
    readonly you?: true;
};
/** The fleet as it is handed to a remote agent: the entries, and the same as text for a model. */
type Roster = {
    /** Grows with every roster the agent is sent: the greatest one is the latest. */
    readonly version: number;
    readonly agents: readonly RosterEntry[];
    readonly text: string;
};
/** The entries of the fleet for the agent `self`: its own is marked `you`. */
function rosterEntries(agents: readonly AgentSummary[], self: string): RosterEntry[] {
    return agents.map(agent => ({
        id: agent.id,
        name: agent.name,
        kind: agent.kind,
        ...described(agent),
        status: agent.status,
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
/** The roster with its version, and the text an adapter can hand to its model as it is. */
function roster(version: number, agents: readonly RosterEntry[]): Roster {
    const text = 'The agents of the fleet flotti runs — your own entry is marked "you", administrators of the fleet '
        + '"admin". To write to one, put its id in "to" of a message through the inbox.\n'
        + JSON.stringify(agents, null, 2);
    return { version, agents, text };
}
export { roster, rosterEntries };
export type { Roster, RosterEntry };
