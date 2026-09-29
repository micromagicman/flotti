import type { AgentSummary } from '../../../src/dashboard-protocol.js';
import type { AgentColors } from '../agent-colors.js';
import { inFleet } from '../groups.js';
import { useT } from '../i18n/I18n.js';
/**
 * The colour of an agent where its name stands (#50): a square in the colour
 * of its envelopes (#23), in the sidebar, in the header of its tab and in the
 * lane of a conversation. Square, so it is not taken for the round dot of a
 * status or of something unread.
 */
function AgentMark({ color }: { readonly color: number | undefined }) {
    return <span className={`agent-mark agent-color-${color ?? 0}`} aria-hidden="true" />;
}
/** The marks of the two agents of a conversation, side by side. */
function PairMarks({ first, second }: { readonly first: number | undefined; readonly second: number | undefined }) {
    return (
        <span className="pair-marks" aria-hidden="true">
            <AgentMark color={first} />
            <AgentMark color={second} />
        </span>
    );
}
/** The mark of a member of a group that is not in the fleet: a hollow grey square, no colour of its own. */
function GoneMark() {
    return <span className="agent-mark mark-gone" aria-hidden="true" />;
}
/** The mark of a member of a group: its colour when it is in the fleet, hollow and grey when not. */
function MemberMark({ id, agents, colors }: { readonly id: string; readonly agents: readonly AgentSummary[]; readonly colors: AgentColors }) {
    return inFleet(agents, id) ? <AgentMark color={colors[id]} /> : <GoneMark />;
}
type GroupMarksProps = {
    readonly members: readonly string[];
    readonly agents: readonly AgentSummary[];
    readonly colors: AgentColors;
    /** Smaller marks, for the row of the feed. */
    readonly small?: boolean;
};
/** How many marks a row shows before it folds the rest into «+N». */
const MARKS_SHOWN = 4;
/** The marks of the members of a group in a row (#152): the first four, then «+N» for the rest. */
function GroupMarks({ members, agents, colors, small = false }: GroupMarksProps) {
    const rest = members.length - MARKS_SHOWN;
    return (
        <span className={`group-marks${small ? ' group-marks-sm' : ''}`} aria-hidden="true">
            {members.slice(0, MARKS_SHOWN).map((id) => <MemberMark key={id} id={id} agents={agents} colors={colors} />)}
            {rest > 0 ? <span className="group-more">+{rest}</span> : null}
        </span>
    );
}
/** A member of a group by its mark and name; one not in the fleet in grey, underlined dashed, and says so on hover. */
function Member({ id, agents, colors }: { readonly id: string; readonly agents: readonly AgentSummary[]; readonly colors: AgentColors }) {
    const t = useT();
    const gone = !inFleet(agents, id);
    return (
        <span className="member">
            <MemberMark id={id} agents={agents} colors={colors} />
            {gone ? <span className="name-gone" title={t.group.notInFleet}>{id}</span> : nameOf(agents, id)}
        </span>
    );
}
function nameOf(agents: readonly AgentSummary[], id: string): string {
    return agents.find((agent) => agent.id === id)?.name ?? id;
}
export { AgentMark, GroupMarks, Member, PairMarks, nameOf };
