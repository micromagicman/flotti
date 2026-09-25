/**
 * The health of an SSH connection in words, for the header of a tab and for
 * the settings. Pure, so the words are tested without a page; the times are
 * counted from `now`, which the page moves on every second.
 */
import { POOR_DOWN, POOR_LATENCY_MS, POOR_RECONNECTS_PER_HOUR } from '../../src/connection-health.js';
import type { ConnectionHealth } from '../../src/connection-health.js';
import type { Messages } from './i18n/en.js';
/** One fact about the connection: which it is, its short name and its value. */
type HealthFact = { readonly key: 'latency' | 'reconnects' | 'last activity' | 'tunnel up'; readonly label: string; readonly value: string };
function ago(time: string | undefined, now: number, t: Messages): string | undefined {
    return time === undefined ? undefined : t.health.ago(t.health.duration(now - Date.parse(time)));
}
function reconnectsText(health: ConnectionHealth, now: number, t: Messages): string {
    const last = ago(health.lastReconnectAt, now, t);
    return `${t.health.inLastHour(health.reconnects, health.reconnectsLastHour)}${last === undefined ? '' : ` · ${t.health.last(last)}`}`;
}
/** What the page says about the connection, in the order it says it. */
function healthFacts(health: ConnectionHealth, now: number, t: Messages): HealthFact[] {
    const { health: words } = t;
    return [
        { key: 'latency', label: words.latency, value: health.latencyMs === undefined ? words.notMeasured : words.ms(health.latencyMs) },
        { key: 'reconnects', label: words.reconnects, value: reconnectsText(health, now, t) },
        { key: 'last activity', label: words.lastActivity, value: ago(health.lastActivityAt, now, t) ?? words.noneYet },
        { key: 'tunnel up', label: words.tunnelUp, value: health.upSince === undefined ? words.down : words.duration(now - Date.parse(health.upSince)) }
    ];
}
/**
 * Why the connection is poor, in the words of the page: said again from the
 * numbers, by the rule the server goes by; what the server said, when the
 * numbers do not tell.
 */
function poorReasons(health: ConnectionHealth, t: Messages): readonly string[] {
    const reasons = [
        ...(health.reconnectsLastHour >= POOR_RECONNECTS_PER_HOUR ? [t.health.poorReconnects(health.reconnectsLastHour)] : []),
        ...(health.latencyMs !== undefined && health.latencyMs >= POOR_LATENCY_MS ? [t.health.poorLatency(health.latencyMs)] : [])
    ];
    return reasons.length === 0 ? health.poor : reasons;
}
/** A connection that was up and dropped: the server says so first among the reasons. */
function isDown(health: ConnectionHealth): boolean {
    return health.poor.includes(POOR_DOWN);
}
/** The line that says the connection is lost or poor, and why; `undefined` when it is fine. */
function poorText(health: ConnectionHealth, t: Messages): string | undefined {
    if (health.poor.length === 0) {
        return undefined;
    }
    if (isDown(health)) {
        const others = health.reconnectsLastHour >= POOR_RECONNECTS_PER_HOUR ? [t.health.poorReconnects(health.reconnectsLastHour)] : [];
        return t.health.lost([t.health.tunnelDown, ...others].join(', '));
    }
    return t.health.poor(poorReasons(health, t).join(', '));
}
/** The short mark of a troubled connection, for the tab of the agent; `undefined` when it is fine. */
function poorMark(health: ConnectionHealth, t: Messages): string | undefined {
    if (health.poor.length === 0) {
        return undefined;
    }
    return isDown(health) ? t.health.lostMark : t.health.poorMark;
}
export { healthFacts, isDown, poorMark, poorText };
export type { HealthFact };
