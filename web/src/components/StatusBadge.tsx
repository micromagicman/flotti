import type { AgentStatus } from '../../../src/agent-events.js';
const LABELS: Readonly<Record<AgentStatus, string>> = {
    starting: 'starting',
    idle: 'idle',
    working: 'working',
    waiting: 'waiting for you',
    error: 'error',
    stopped: 'stopped'
};
function StatusBadge({ status }: { readonly status: AgentStatus }) {
    return (
        <span className={`status status-${status}`} data-status={status}>
            <span className="dot" aria-hidden="true" />
            {LABELS[status]}
        </span>
    );
}
export { StatusBadge };
