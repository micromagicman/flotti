import { useEffect, useState } from 'react';
import type { ConnectionHealth } from '../../../src/connection-health.js';
import { healthFacts, poorText } from '../health.js';
/** The time now, moved on every second: the uptime and the "ago" of the health go on by themselves. */
function useNow(): number {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, []);
    return now;
}
/**
 * The health of the SSH connection of a remote agent: latency, reconnects,
 * last activity, uptime. A poor connection stands out and says why.
 */
function ConnectionHealthView({ health }: { readonly health: ConnectionHealth }) {
    const now = useNow();
    const poor = poorText(health);
    return (
        <div className={poor === undefined ? 'health' : 'health health-poor'} role="group" aria-label="SSH connection" data-poor={poor !== undefined}>
            <span className="health-title">SSH</span>
            {healthFacts(health, now).map((fact) => (
                <span key={fact.label} className="health-fact" data-fact={fact.label}>
                    <span className="health-label">{fact.label}</span> {fact.value}
                </span>
            ))}
            {poor === undefined ? null : <span className="health-warning">{poor}</span>}
        </div>
    );
}
/** The mark of a poor connection on the tab of the agent, seen from any tab. */
function PoorConnectionMark({ health }: { readonly health: ConnectionHealth | undefined }) {
    const poor = health === undefined ? undefined : poorText(health);
    return poor === undefined ? null : <span className="tab-poor" title={poor}>poor connection</span>;
}
export { ConnectionHealthView, PoorConnectionMark };
