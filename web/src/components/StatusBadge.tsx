import type { AgentStatus } from '../../../src/agent-events.js';
import { useT } from '../i18n/I18n.js';
/** The status in a tinted capsule; `detail` follows it, as the line of the agent does by the field (#77). */
function StatusBadge({ status, detail }: { readonly status: AgentStatus; readonly detail?: string | undefined }) {
    const t = useT();
    return (
        <span className={`badge status status-${status}`} data-status={status}>
            <span className="dot" aria-hidden="true" />
            {t.status[status]}
            {detail === undefined ? null : <span className="badge-detail">· {detail}</span>}
        </span>
    );
}
export { StatusBadge };
