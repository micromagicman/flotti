import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HealthTracker, formatDuration, poorReasons } from '../src/connection-health.js';
import type { ConnectionHealth } from '../src/connection-health.js';
import type { AgentSummary } from '../src/dashboard-protocol.js';
import { printAgents } from '../src/run.js';
import { fleetReducer, initialState } from '../web/src/fleet-state.js';
import { healthFacts, poorMark, poorText } from '../web/src/health.js';
import { en } from '../web/src/i18n/en.js';
import { ru } from '../web/src/i18n/ru.js';
const START = Date.parse('2026-01-01T10:00:00.000Z');
/** A tracker on a clock the test moves by hand. */
function tracked(quietMs = 1_000) {
    const clock = { now: START };
    const told: ConnectionHealth[] = [];
    const tracker = new HealthTracker({ now: () => clock.now, quietMs });
    tracker.onChange((health) => told.push(health));
    return { tracker, clock, told };
}
describe('connection health: counting', () => {
    it('counts a reconnect only when the connection comes back after it was up', () => {
        const { tracker, clock } = tracked();
        tracker.up();
        deepStrictEqual(tracker.snapshot(), { reconnects: 0, reconnectsLastHour: 0, upSince: '2026-01-01T10:00:00.000Z', poor: [] });
        tracker.up();
        strictEqual(tracker.snapshot().reconnects, 0, 'up twice without a drop is still one connection');
        clock.now += 60_000;
        tracker.down();
        strictEqual(tracker.snapshot().upSince, undefined);
        clock.now += 5_000;
        tracker.up();
        const health = tracker.snapshot();
        strictEqual(health.reconnects, 1);
        strictEqual(health.reconnectsLastHour, 1);
        strictEqual(health.lastReconnectAt, '2026-01-01T10:01:05.000Z');
        strictEqual(health.upSince, '2026-01-01T10:01:05.000Z');
    });
    it('keeps the reconnects of the session, and of the last hour apart', () => {
        const { tracker, clock } = tracked();
        tracker.up();
        for (let i = 0; i < 3; i++) {
            tracker.down();
            clock.now += 10 * 60_000;
            tracker.up();
        }
        deepStrictEqual([tracker.snapshot().reconnects, tracker.snapshot().reconnectsLastHour], [3, 3]);
        clock.now += 50 * 60_000;
        deepStrictEqual([tracker.snapshot().reconnects, tracker.snapshot().reconnectsLastHour], [3, 1]);
        clock.now += 60 * 60_000;
        const health = tracker.snapshot();
        deepStrictEqual([health.reconnects, health.reconnectsLastHour], [3, 0]);
        strictEqual(health.lastReconnectAt, '2026-01-01T10:30:00.000Z', 'the last reconnect is remembered past the hour');
    });
    it('rounds the latency and remembers the last activity', () => {
        const { tracker, clock } = tracked();
        tracker.latency(41.6);
        clock.now += 2_000;
        tracker.activity();
        const health = tracker.snapshot();
        strictEqual(health.latencyMs, 42);
        strictEqual(health.lastActivityAt, '2026-01-01T10:00:02.000Z');
    });
});
describe('connection health: sessions', () => {
    it('starts over after a reset: a new session', () => {
        const { tracker } = tracked();
        tracker.up();
        tracker.down();
        tracker.up();
        tracker.latency(10);
        tracker.activity();
        tracker.reset();
        deepStrictEqual(tracker.snapshot(), { reconnects: 0, reconnectsLastHour: 0, poor: [] });
        tracker.up();
        strictEqual(tracker.snapshot().reconnects, 0, 'the first connection of the new session is no reconnect');
    });
});
describe('connection health: telling', () => {
    it('tells every change at once', () => {
        const { tracker, told } = tracked();
        tracker.up();
        tracker.latency(12);
        tracker.down();
        deepStrictEqual(told.map((health) => [health.upSince !== undefined, health.latencyMs]), [[true, undefined], [true, 12], [false, 12]]);
    });
    it('tells of activity at most once in the quiet time', async () => {
        const { tracker, told } = tracked(30);
        tracker.up();
        for (let i = 0; i < 20; i++) {
            tracker.activity();
        }
        strictEqual(told.length, 1, 'the activity right after a change waits');
        await new Promise((resolve) => setTimeout(resolve, 80));
        strictEqual(told.length, 2, 'and is told once, when the quiet time is over');
        ok(told[1]?.lastActivityAt !== undefined);
    });
    it('a broken listener does not stop the others', () => {
        const { tracker, told } = tracked();
        tracker.onChange(() => {
            throw new Error('broken');
        });
        tracker.up();
        strictEqual(told.length, 1);
    });
});
describe('connection health: poor', () => {
    it('is poor with frequent reconnects or a slow round trip, and says which', () => {
        deepStrictEqual(poorReasons(120, 2), []);
        deepStrictEqual(poorReasons(undefined, 3), ['3 reconnects in the last hour']);
        deepStrictEqual(poorReasons(1_500, 0), ['latency 1500 ms']);
        deepStrictEqual(poorReasons(2_000, 4), ['4 reconnects in the last hour', 'latency 2000 ms']);
    });
    it('the snapshot carries why', () => {
        const { tracker, clock } = tracked();
        tracker.up();
        for (let i = 0; i < 3; i++) {
            tracker.down();
            clock.now += 1_000;
            tracker.up();
        }
        deepStrictEqual(tracker.snapshot().poor, ['3 reconnects in the last hour']);
    });
    it('is poor while a connection that was up is down, and not before it came up or after a stop', () => {
        const { tracker, clock } = tracked();
        deepStrictEqual(tracker.snapshot().poor, [], 'not up yet is not a lost connection');
        tracker.up();
        clock.now += 1_000;
        tracker.down();
        deepStrictEqual(tracker.snapshot().poor, ['connection down']);
        tracker.up();
        deepStrictEqual(tracker.snapshot().poor, [], 'back up');
        tracker.down();
        tracker.reset();
        deepStrictEqual(tracker.snapshot().poor, [], 'a stopped agent has no connection to lose');
    });
});
describe('connection health: in words', () => {
    it('writes durations the way a person reads them', () => {
        deepStrictEqual([0, 5_400, 200_000, 7_500_000, 273_600_000, -5].map(formatDuration), ['0 s', '5 s', '3 min 20 s', '2 h 5 min', '3 d 4 h', '0 s']);
    });
    it('says the facts of a connection for the page', () => {
        const health: ConnectionHealth = {
            latencyMs: 38,
            reconnects: 2,
            reconnectsLastHour: 1,
            lastReconnectAt: '2026-01-01T09:58:00.000Z',
            lastActivityAt: '2026-01-01T09:59:55.000Z',
            upSince: '2026-01-01T09:58:00.000Z',
            poor: []
        };
        deepStrictEqual(healthFacts(health, START, en), [
            { key: 'latency', label: 'latency', value: '38 ms' },
            { key: 'reconnects', label: 'reconnects', value: '2 · 1 in the last hour · last 2 min 0 s ago' },
            { key: 'last activity', label: 'last activity', value: '5 s ago' },
            { key: 'tunnel up', label: 'tunnel up', value: '2 min 0 s' }
        ]);
        strictEqual(poorText(health, en), undefined);
        strictEqual(poorText({ ...health, latencyMs: 1_500, poor: ['latency 1500 ms'] }, en), 'Poor connection: latency 1,500 ms');
        strictEqual(poorText({ ...health, poor: ['latency 1500 ms'] }, en), 'Poor connection: latency 1500 ms', 'what the server says, when the numbers do not tell');
    });
    it('says the facts of a connection in the language of the page', () => {
        const health: ConnectionHealth = { latencyMs: 1_200, reconnects: 4, reconnectsLastHour: 3, upSince: '2026-01-01T09:00:00.000Z', poor: ['3 reconnects in the last hour', 'latency 1200 ms'] };
        deepStrictEqual(healthFacts(health, START, ru).map((fact) => `${fact.label} ${fact.value}`), [
            'задержка 1\u00a0200 мс', 'переподключения 4 · 3 за последний час', 'активность пока не было', 'туннель работает 1 ч 0 мин'
        ]);
        strictEqual(poorText(health, ru), 'Плохое соединение: 3 переподключения за последний час, задержка 1\u00a0200 мс');
    });
    it('says a lost connection first, and marks it apart from a poor one', () => {
        const down: ConnectionHealth = { reconnects: 1, reconnectsLastHour: 1, poor: ['connection down'] };
        strictEqual(poorText(down, en), 'No connection: the tunnel is down');
        strictEqual(poorText(down, ru), 'Нет связи: туннель не работает');
        strictEqual(poorMark(down, en), 'no connection');
        strictEqual(poorMark(down, ru), 'нет связи');
        const worse: ConnectionHealth = { reconnects: 4, reconnectsLastHour: 3, poor: ['connection down', '3 reconnects in the last hour'] };
        strictEqual(poorText(worse, en), 'No connection: the tunnel is down, 3 reconnects in the last hour');
        const poor: ConnectionHealth = { latencyMs: 1_500, reconnects: 0, reconnectsLastHour: 0, upSince: '2026-01-01T09:00:00.000Z', poor: ['latency 1500 ms'] };
        strictEqual(poorMark(poor, en), 'poor connection');
        strictEqual(poorMark({ ...poor, latencyMs: 40, poor: [] }, en), undefined);
    });
    it('says what is not known yet, and a tunnel that is down', () => {
        const facts = healthFacts({ reconnects: 0, reconnectsLastHour: 0, poor: [] }, START, en);
        deepStrictEqual(facts.map((fact) => fact.value), ['not measured yet', '0 · 0 in the last hour', 'none yet', 'down']);
    });
});
describe('connection health: where it shows', () => {
    const health: ConnectionHealth = { latencyMs: 1_200, reconnects: 4, reconnectsLastHour: 3, upSince: '2026-01-01T09:00:00.000Z', poor: ['3 reconnects in the last hour', 'latency 1200 ms'] };
    const agents: AgentSummary[] = [
        { id: 'builder', name: 'builder', kind: 'local', harness: 'codex', status: 'idle' },
        { id: 'relay', name: 'relay', kind: 'remote', status: 'idle', health }
    ];
    it('flotti status shows latency and reconnects when an agent is reached over SSH', () => {
        const lines: string[] = [];
        printAgents(agents, (line) => lines.push(line), START);
        deepStrictEqual(lines.map((line) => line.split(/\s{2,}/)), [
            ['ID', 'TYPE', 'HARNESS', 'STATUS', 'LATENCY', 'RECONNECTS', 'UP'],
            ['builder', 'local', 'codex', 'idle', '-', '-', '-'],
            ['relay', 'remote', '-', 'idle', '1200 ms', '4 (3 in 1 h)', '1 h 0 min', 'POOR: 3 reconnects in the last hour, latency 1200 ms']
        ]);
    });
    it('flotti status leaves the columns out when no agent is reached over SSH', () => {
        const lines: string[] = [];
        printAgents(agents.slice(0, 1), (line) => lines.push(line), START);
        deepStrictEqual(lines.map((line) => line.split(/\s{2,}/)), [['ID', 'TYPE', 'HARNESS', 'STATUS'], ['builder', 'local', 'codex', 'idle']]);
    });
    it('the page takes the health the server sends, without reloading the fleet', () => {
        const withFleet = fleetReducer(initialState, { type: 'server', message: { type: 'fleet', agents: [{ ...agents[1] as AgentSummary, health: { reconnects: 0, reconnectsLastHour: 0, poor: [] } }] } });
        const changed = fleetReducer(withFleet, { type: 'server', message: { type: 'health', agentId: 'relay', health } });
        deepStrictEqual(changed.agents[0]?.health, health);
        strictEqual(changed.feeds, withFleet.feeds, 'the feeds stay as they were');
        const unknown = fleetReducer(changed, { type: 'server', message: { type: 'health', agentId: 'nobody', health } });
        deepStrictEqual(unknown.agents, changed.agents, 'the health of an agent not in the fleet changes nothing');
    });
});
