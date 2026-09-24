import type { AgentSummary } from '../../../src/dashboard-protocol.js';
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
function nameOf(agents: readonly AgentSummary[], id: string): string {
    return agents.find((agent) => agent.id === id)?.name ?? id;
}
export { AgentMark, PairMarks, nameOf };
