import { useEffect, useState } from 'react';
import type { ConnectionHealth } from '../../../src/connection-health.js';
import { healthFacts, isDown, poorMark, poorText } from '../health.js';
import { useT } from '../i18n/I18n.js';
/** The time now, moved on every second: the uptime and the "ago" of the health go on by themselves. */
function useNow(): number {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, []);
    return now;
}
/** The sign of trouble with the connection, before its words. */
function WarnIcon() {
    return (
        <svg className="warn-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
            <path d="M8 1.5 15 14H1z" fill="currentColor" />
            <path d="M8 6v3.6M8 11.4v.2" stroke="var(--panel)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
    );
}
/**
 * The health of the SSH connection of a remote agent: latency, reconnects,
 * last activity, uptime. A poor or lost connection stands out and says why.
 * In a row for the settings; in a column of label and value for the details
 * of an agent (#102).
 */
function ConnectionHealthView({ health, layout = 'row' }: { readonly health: ConnectionHealth; readonly layout?: 'row' | 'column' }) {
    const now = useNow();
    const t = useT();
    const poor = poorText(health, t);
    return (
        <div className={healthClasses(layout, poor)} role="group" aria-label={t.health.label} data-poor={poor !== undefined} data-down={isDown(health)}>
            {layout === 'row' ? <span className="health-title">SSH</span> : null}
            <HealthWarning poor={poor} shown={layout === 'column'} icon={true} />
            {healthFacts(health, now, t).map((fact) => (
                <span key={fact.key} className="health-fact" data-fact={fact.key}>
                    <span className="health-label">{fact.label}</span> <span className="health-value">{fact.value}</span>
                </span>
            ))}
            <HealthWarning poor={poor} shown={layout === 'row'} icon={false} />
        </div>
    );
}
function healthClasses(layout: 'row' | 'column', poor: string | undefined): string {
    return ['health', layout === 'column' ? 'health-column' : '', poor === undefined ? '' : 'health-poor'].filter(Boolean).join(' ');
}
/** Why the connection is poor, where the layout puts it: before the facts in a column, after them in a row. */
function HealthWarning({ poor, shown, icon }: { readonly poor: string | undefined; readonly shown: boolean; readonly icon: boolean }) {
    if (!shown || poor === undefined) {
        return null;
    }
    return <span className="health-warning">{icon ? <WarnIcon /> : null}{poor}</span>;
}
/**
 * A lost or poor connection, the whole width under the header of the tab:
 * seen without opening the details, and a way to them (#102).
 */
function ConnectionAlarm({ health, onDetails }: { readonly health: ConnectionHealth | undefined; readonly onDetails: () => void }) {
    const t = useT();
    const poor = health === undefined ? undefined : poorText(health, t);
    if (poor === undefined || health === undefined) {
        return null;
    }
    return (
        <div className="health-strip" role="status" data-down={isDown(health)}>
            <WarnIcon />
            <span className="health-strip-text">{poor}</span>
            <button type="button" className="btn btn-xs btn-ghost" onClick={onDetails}>{t.health.more}</button>
        </div>
    );
}
/** The mark of a lost or poor connection on the tab of the agent, seen from any tab. */
function PoorConnectionMark({ health }: { readonly health: ConnectionHealth | undefined }) {
    const t = useT();
    const mark = health === undefined ? undefined : poorMark(health, t);
    return mark === undefined || health === undefined ? null : <span className="tab-poor" title={poorText(health, t)}>{mark}</span>;
}
export { ConnectionAlarm, ConnectionHealthView, PoorConnectionMark, WarnIcon };
