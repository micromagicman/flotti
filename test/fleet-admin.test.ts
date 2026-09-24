import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentEvent } from '../src/agent-events.js';
import { Supervisor } from '../src/supervisor.js';
import { FakeFleetAgent, fakeFleet } from './fake-fleet-agent.js';
import { eventually } from './local-agent-helpers.js';
/** A fleet of fakes where `boss` is an administrator and the others are not. */
function adminFleet(options: { confirm?: boolean } = {}) {
    const { fleet, fakes, createAgent } = fakeFleet('boss', 'worker', 'other');
    const agents = fleet.agents.map((agent) => (agent.id === 'boss' ? { ...agent, admin: true as const } : agent));
    let confirm = options.confirm === true;
    const supervisor = new Supervisor({ ...fleet, agents }, { createAgent, confirmAdminActions: () => confirm });
    const fake = (id: string): FakeFleetAgent => {
        const found = fakes.get(id);
        ok(found !== undefined, `no fake ${id}`);
        return found;
    };
    return { supervisor, fake, setConfirm: (value: boolean) => { confirm = value; } };
}
type AdminEvent = AgentEvent & { type: 'admin-action' };
/** The states of the actions of administrators the tab of the agent shows, as `action target state`. */
function adminLines(supervisor: Supervisor, agentId: string): string[] {
    return supervisor.history(agentId)
        .filter((event): event is AdminEvent => event.type === 'admin-action')
        .map((event) => `${event.admin} ${event.action} ${event.target} ${event.state}`);
}
/** The id of the action waiting for a person in the tab of the administrator. */
function pendingAction(supervisor: Supervisor, admin: string): string {
    const pending = supervisor.history(admin).find((event): event is AdminEvent => event.type === 'admin-action' && event.state === 'pending');
    ok(pending !== undefined, 'no action waits for a person');
    return pending.actionId;
}
describe('administrators of the fleet: rights', () => {
    it('lists administrators as such, and nobody else', () => {
        const { supervisor } = adminFleet();
        deepStrictEqual(supervisor.agents().map((agent) => [agent.id, agent.admin]), [
            ['boss', true],
            ['other', undefined],
            ['worker', undefined]
        ]);
    });
    it('refuses an agent that is not an administrator, and nothing happens', async () => {
        const { supervisor, fake } = adminFleet();
        await supervisor.start();
        for (const action of ['restart', 'clear-context'] as const) {
            const outcome = await supervisor.administer('worker', action, 'other');
            strictEqual(outcome.ok, false);
            match(outcome.text, /only an administrator of the fleet may/);
        }
        deepStrictEqual(fake('other').calls, ['start']);
        deepStrictEqual(adminLines(supervisor, 'other'), []);
        deepStrictEqual(adminLines(supervisor, 'worker'), []);
    });
    it('refuses an agent that is not in the fleet', async () => {
        const { supervisor } = adminFleet();
        const outcome = await supervisor.administer('boss', 'restart', 'ghost');
        strictEqual(outcome.ok, false);
        match(outcome.text, /no agent "ghost"/);
    });
});
describe('administrators of the fleet: the actions', () => {
    it('restarts another agent, and both tabs say who did it', async () => {
        const { supervisor, fake } = adminFleet();
        await supervisor.start();
        const outcome = await supervisor.administer('boss', 'restart', 'worker');
        deepStrictEqual(outcome, { ok: true, text: '"worker" is restarted.' });
        deepStrictEqual(fake('worker').calls, ['start', 'restart']);
        deepStrictEqual(adminLines(supervisor, 'worker'), ['boss restart worker done']);
        deepStrictEqual(adminLines(supervisor, 'boss'), ['boss restart worker done']);
    });
    it('clears the context of another agent', async () => {
        const { supervisor, fake } = adminFleet();
        await supervisor.start();
        const outcome = await supervisor.administer('boss', 'clear-context', 'worker');
        strictEqual(outcome.ok, true);
        deepStrictEqual(fake('worker').calls, ['start', 'clear-context']);
        deepStrictEqual(adminLines(supervisor, 'worker'), ['boss clear-context worker done']);
    });
    it('says the action failed, and why, when the agent could not do it', async () => {
        const { supervisor, fake } = adminFleet();
        await supervisor.start();
        fake('worker').broken = true;
        const outcome = await supervisor.administer('boss', 'clear-context', 'worker');
        strictEqual(outcome.ok, false);
        match(outcome.text, /Could not clear the context of "worker": worker is broken/);
        deepStrictEqual(adminLines(supervisor, 'worker'), ['boss clear-context worker failed']);
    });
    it('keeps the history of the tab: a cleared agent shows what came before', async () => {
        const { supervisor } = adminFleet();
        await supervisor.start();
        await supervisor.send('worker', 'remember me');
        await supervisor.administer('boss', 'clear-context', 'worker');
        const types = supervisor.history('worker').map((event) => event.type);
        ok(types.indexOf('message') < types.indexOf('admin-action'), 'the history is there, above the action');
    });
});
describe('administrators of the fleet: acting on itself', () => {
    it('restarts itself once the turn it asked in is over', async () => {
        const { supervisor, fake } = adminFleet();
        await supervisor.start();
        const boss = fake('boss');
        boss.emit({ type: 'message', role: 'user', messageId: 'u1', text: 'restart yourself', append: false });
        const outcome = await supervisor.administer('boss', 'restart', 'boss');
        strictEqual(outcome.ok, true);
        match(outcome.text, /once this turn is over/);
        deepStrictEqual(boss.calls, ['start'], 'not in the middle of its own turn');
        deepStrictEqual(adminLines(supervisor, 'boss'), ['boss restart boss scheduled']);
        boss.emit({ type: 'turn-end', reason: 'end_turn' });
        await eventually(() => boss.calls.includes('restart'));
        await eventually(() => adminLines(supervisor, 'boss').length === 2);
        deepStrictEqual(adminLines(supervisor, 'boss'), ['boss restart boss scheduled', 'boss restart boss done']);
    });
    it('clears its own context at once when it is in no turn', async () => {
        const { supervisor, fake } = adminFleet();
        await supervisor.start();
        await supervisor.administer('boss', 'clear-context', 'boss');
        await eventually(() => fake('boss').calls.includes('clear-context'));
    });
});
describe('administrators of the fleet: a person confirms', () => {
    it('waits for a person, and does it once allowed', async () => {
        const { supervisor, fake } = adminFleet({ confirm: true });
        await supervisor.start();
        const outcome = supervisor.administer('boss', 'restart', 'worker');
        await eventually(() => adminLines(supervisor, 'worker').length === 1);
        deepStrictEqual(adminLines(supervisor, 'worker'), ['boss restart worker pending']);
        deepStrictEqual(adminLines(supervisor, 'boss'), ['boss restart worker pending']);
        deepStrictEqual(fake('worker').calls, ['start']);
        strictEqual(supervisor.answerAdminAction(pendingAction(supervisor, 'boss'), true), true);
        strictEqual((await outcome).ok, true);
        deepStrictEqual(fake('worker').calls, ['start', 'restart']);
        deepStrictEqual(adminLines(supervisor, 'worker'), ['boss restart worker pending', 'boss restart worker done']);
    });
    it('tells the administrator a refusal as a refusal, and does nothing', async () => {
        const { supervisor, fake } = adminFleet({ confirm: true });
        await supervisor.start();
        const outcome = supervisor.administer('boss', 'clear-context', 'worker');
        await eventually(() => adminLines(supervisor, 'boss').length === 1);
        const actionId = pendingAction(supervisor, 'boss');
        strictEqual(supervisor.answerAdminAction(actionId, false), true);
        deepStrictEqual(await outcome, { ok: false, text: 'A person refused to let you clear the context of "worker".' });
        deepStrictEqual(fake('worker').calls, ['start']);
        deepStrictEqual(adminLines(supervisor, 'worker'), ['boss clear-context worker pending', 'boss clear-context worker refused']);
        strictEqual(supervisor.answerAdminAction(actionId, true), false, 'answered once only');
    });
    it('asks the settings at every action: off again, the next one is done at once', async () => {
        const { supervisor, fake, setConfirm } = adminFleet({ confirm: true });
        await supervisor.start();
        setConfirm(false);
        strictEqual((await supervisor.administer('boss', 'restart', 'worker')).ok, true);
        deepStrictEqual(fake('worker').calls, ['start', 'restart']);
    });
});
