import type { AgentStatus } from '../../../src/agent-events.js';
const LABELS: Readonly<Record<AgentStatus, string>> = {
    starting: 'starting',
    idle: 'idle',
    working: 'working',
    waiting: 'waiting for you',
    error: 'error',
    stopped: 'stopped'
};
/** The status in a tinted capsule; `detail` follows it, as the line of the agent does by the field (#77). */
function StatusBadge({ status, detail }: { readonly status: AgentStatus; readonly detail?: string | undefined }) {
    return (
        <span className={`badge status status-${status}`} data-status={status}>
            <span className="dot" aria-hidden="true" />
            {LABELS[status]}
            {detail === undefined ? null : <span className="badge-detail">· {detail}</span>}
        </span>
    );
}
export { StatusBadge };
