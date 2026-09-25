/**
 * Health of the way to a remote agent that has to be kept open — an SSH
 * tunnel: how fast the agent answers, how often the way broke and came back,
 * when the agent was last heard from, how long the way has been up.
 *
 * No Node in here: the page imports it too, for the words and the durations.
 * Nothing in here is secret either — no address, no token, no header — so the
 * health goes to the page and to `flotti status` as it is.
 */
/** What the dashboard and `flotti status` show about the connection of one agent. */
type ConnectionHealth = {
    /** Round trip of the last request flotti made to measure it, in ms; absent until one came back. */
    readonly latencyMs?: number;
    /** Times the connection came back after it dropped, since the agent was started. */
    readonly reconnects: number;
    /** Of those, the ones in the last hour. */
    readonly reconnectsLastHour: number;
    /** ISO 8601 time the connection last came back. */
    readonly lastReconnectAt?: string;
    /** ISO 8601 time the agent last said something or answered a request. */
    readonly lastActivityAt?: string;
    /** ISO 8601 time the connection that is open now came up; absent while it is down. */
    readonly upSince?: string;
    /** Why the connection counts as poor, a few words each; empty when it is fine. */
    readonly poor: readonly string[];
};
/** A round trip this long, or longer, makes the connection poor. */
const POOR_LATENCY_MS = 1_000;
/** This many reconnects in the last hour, or more, make the connection poor. */
const POOR_RECONNECTS_PER_HOUR = 3;
const HOUR_MS = 3_600_000;
/** The reason of a connection that was up and is down now: it comes first, and the page knows it by these words. */
const POOR_DOWN = 'connection down';
/**
 * Why a connection with this latency and these reconnects is poor; empty when
 * it is fine. `down` is a connection that was up and dropped: not one that has
 * not come up yet, and not the one of a stopped agent.
 */
function poorReasons(latencyMs: number | undefined, reconnectsLastHour: number, down = false): string[] {
    const reasons: string[] = down ? [POOR_DOWN] : [];
    if (reconnectsLastHour >= POOR_RECONNECTS_PER_HOUR) {
        reasons.push(`${reconnectsLastHour} reconnects in the last hour`);
    }
    if (latencyMs !== undefined && latencyMs >= POOR_LATENCY_MS) {
        reasons.push(`latency ${latencyMs} ms`);
    }
    return reasons;
}
/** A duration the way a person reads it: `5 s`, `3 min 20 s`, `2 h 5 min`, `3 d 4 h`. */
function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1_000));
    if (seconds < 60) {
        return `${seconds} s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes} min ${seconds % 60} s`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} h ${minutes % 60} min`;
    }
    return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}
type HealthListener = (health: ConnectionHealth) => void;
type HealthTrackerOptions = {
    /** The clock; tests put their own in. */
    readonly now?: () => number;
    /**
     * Activity comes with every piece of a streamed answer: listeners hear of it
     * at most once in this many ms. Everything else is told at once. 1 s by default.
     */
    readonly quietMs?: number;
};
function isoTime(time: number | undefined): string | undefined {
    return time === undefined ? undefined : new Date(time).toISOString();
}
/**
 * Counts what happens to one connection and tells the listeners: it came up,
 * it went down, a round trip was measured, the agent was heard from. A
 * connection that comes up again after it was up is a reconnect.
 */
class HealthTracker {
    private readonly now: () => number;
    private readonly quietMs: number;
    private readonly listeners = new Set<HealthListener>();
    private latencyMs: number | undefined;
    private reconnects = 0;
    /** Times of the reconnects of the last hour, oldest first. */
    private recent: number[] = [];
    /** Time of the last reconnect, even one more than an hour old. */
    private lastReconnect: number | undefined;
    private lastActivity: number | undefined;
    private upSince: number | undefined;
    private wasUp = false;
    private lastTold = Number.NEGATIVE_INFINITY;
    private pending: ReturnType<typeof setTimeout> | undefined;
    constructor(options: HealthTrackerOptions = {}) {
        this.now = options.now ?? Date.now;
        this.quietMs = options.quietMs ?? 1_000;
    }
    /** The connection is open; counts a reconnect when it was open before. */
    up(): void {
        if (this.upSince !== undefined) {
            return;
        }
        const now = this.now();
        if (this.wasUp) {
            this.reconnects += 1;
            this.recent.push(now);
            this.lastReconnect = now;
        }
        this.wasUp = true;
        this.upSince = now;
        this.tell();
    }
    /** The connection dropped, or was closed. */
    down(): void {
        if (this.upSince === undefined) {
            return;
        }
        this.upSince = undefined;
        this.tell();
    }
    /** A request to the agent took this long, there and back. */
    latency(ms: number): void {
        this.latencyMs = Math.round(ms);
        this.tell();
    }
    /** The agent said something, or answered a request. */
    activity(): void {
        this.lastActivity = this.now();
        this.tellSoon();
    }
    /** Starts counting anew: the agent was stopped, and what comes next is another session. */
    reset(): void {
        this.latencyMs = undefined;
        this.reconnects = 0;
        this.recent = [];
        this.lastReconnect = undefined;
        this.lastActivity = undefined;
        this.upSince = undefined;
        this.wasUp = false;
        this.tell();
    }
    snapshot(): ConnectionHealth {
        const now = this.now();
        this.recent = this.recent.filter((time) => time > now - HOUR_MS);
        const lastReconnectAt = isoTime(this.lastReconnect);
        const lastActivityAt = isoTime(this.lastActivity);
        const upSince = isoTime(this.upSince);
        return {
            ...(this.latencyMs === undefined ? {} : { latencyMs: this.latencyMs }),
            reconnects: this.reconnects,
            reconnectsLastHour: this.recent.length,
            ...(lastReconnectAt === undefined ? {} : { lastReconnectAt }),
            ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
            ...(upSince === undefined ? {} : { upSince }),
            poor: poorReasons(this.latencyMs, this.recent.length, this.wasUp && this.upSince === undefined)
        };
    }
    /** Calls the listener with the health whenever it changes; returns the way to stop. */
    onChange(listener: HealthListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    private tell(): void {
        clearTimeout(this.pending);
        this.pending = undefined;
        this.lastTold = this.now();
        const health = this.snapshot();
        for (const listener of [...this.listeners]) {
            try {
                listener(health);
            } catch {
                // A broken listener must not break the connection it watches.
            }
        }
    }
    /** Tells the listeners now, or once the quiet time since the last telling is over. */
    private tellSoon(): void {
        if (this.pending !== undefined) {
            return;
        }
        const wait = this.lastTold + this.quietMs - this.now();
        if (wait <= 0) {
            this.tell();
            return;
        }
        this.pending = setTimeout(() => this.tell(), wait);
    }
}
export { HealthTracker, POOR_DOWN, POOR_LATENCY_MS, POOR_RECONNECTS_PER_HOUR, formatDuration, poorReasons };
export type { ConnectionHealth, HealthListener, HealthTrackerOptions };
