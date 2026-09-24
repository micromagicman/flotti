/**
 * The health of an SSH connection in words, for the header of a tab and for
 * the settings. Pure, so the words are tested without a page; the times are
 * counted from `now`, which the page moves on every second.
 */
import { formatDuration } from '../../src/connection-health.js';
import type { ConnectionHealth } from '../../src/connection-health.js';
/** One fact about the connection: a short name and its value. */
type HealthFact = { readonly label: string; readonly value: string };
function ago(time: string | undefined, now: number): string | undefined {
    return time === undefined ? undefined : `${formatDuration(now - Date.parse(time))} ago`;
}
function reconnectsText(health: ConnectionHealth, now: number): string {
    const last = ago(health.lastReconnectAt, now);
    return `${health.reconnects} · ${health.reconnectsLastHour} in the last hour${last === undefined ? '' : ` · last ${last}`}`;
}
/** What the page says about the connection, in the order it says it. */
function healthFacts(health: ConnectionHealth, now: number): HealthFact[] {
    return [
        { label: 'latency', value: health.latencyMs === undefined ? 'not measured yet' : `${health.latencyMs} ms` },
        { label: 'reconnects', value: reconnectsText(health, now) },
        { label: 'last activity', value: ago(health.lastActivityAt, now) ?? 'none yet' },
        { label: 'tunnel up', value: health.upSince === undefined ? 'down' : formatDuration(now - Date.parse(health.upSince)) }
    ];
}
/** The line that says the connection is poor, and why; `undefined` when it is fine. */
function poorText(health: ConnectionHealth): string | undefined {
    return health.poor.length === 0 ? undefined : `Poor connection: ${health.poor.join(', ')}`;
}
export { healthFacts, poorText };
export type { HealthFact };
