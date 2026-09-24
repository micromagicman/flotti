import { randomUUID } from 'node:crypto';
import type { AdminAction, AdminActionState, AgentEventBody } from './agent-events.js';
import type { AgentSummary } from './dashboard-protocol.js';
/**
 * Administrators of the fleet: agents a person made administrators — `admin`
 * in the manifest, or the checkbox in Settings — may restart the other agents
 * and clear their context, themselves included, without a person at hand.
 * Whether one may is decided here, by flotti, and never by the agent: a call
 * of anyone else is refused, and nothing happens. The role itself is given
 * and taken by a person only; no tool changes it.
 *
 * Every action is shown, by one `admin-action` event per state, in the tab of
 * the administrator and in the tab of the agent it acts on. With confirmation
 * on in the settings, it waits for a person to allow it in the dashboard.
 */
/** What the administrators need of the fleet: the supervisor is one. */
interface AdminFleet {
    agents(): AgentSummary[];
    restart(agentId: string): Promise<void>;
    clearContext(agentId: string): Promise<void>;
    /** Puts an event of flotti's own into the tab of the agent, if it is still in the fleet. */
    note(agentId: string, body: AgentEventBody): void;
    /** Resolves once the turn the agent is in is over; at once when it is in none. */
    turnOver(agentId: string): Promise<void>;
}
/** How an action went, as the administrator is told. */
type AdminOutcome = {
    /** Done, or going to be done: `false` when refused or failed. */
    readonly ok: boolean;
    readonly text: string;
};
type FleetAdminOptions = {
    /** Whether an action waits for a person to allow it; read at every action, off when absent. */
    readonly confirm?: () => boolean;
};
/** One action on its way: it tells both tabs where it is. */
type Step = {
    readonly actionId: string;
    readonly action: AdminAction;
    readonly admin: string;
    readonly target: string;
};
/** What the action does, in words: "restart" or "clear the context of", then the agent. */
function doing(step: Pick<Step, 'action' | 'target'>): string {
    return `${step.action === 'restart' ? 'restart' : 'clear the context of'} "${step.target}"`;
}
function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
class FleetAdmin {
    /** Actions waiting for a person, by id: each resolves with whether it was allowed. */
    private readonly waiting = new Map<string, (allowed: boolean) => void>();
    constructor(private readonly fleet: AdminFleet, private readonly options: FleetAdminOptions = {}) {}
    /**
     * An administrator asks to restart an agent or clear its context. Resolves
     * once the action is done — or refused, or failed; an action on the
     * administrator itself resolves at once and is done when its turn is over,
     * since the turn is where it asked.
     */
    async request(admin: string, action: AdminAction, target: string): Promise<AdminOutcome> {
        const refusal = this.refusal(admin, target);
        if (refusal !== undefined) {
            return { ok: false, text: refusal };
        }
        const step: Step = { actionId: randomUUID(), action, admin, target };
        if (this.options.confirm?.() === true && !await this.allowed(step)) {
            this.tell(step, 'refused', 'a person refused it');
            return { ok: false, text: `A person refused to let you ${doing(step)}.` };
        }
        if (target === admin) {
            this.tell(step, 'scheduled');
            void this.fleet.turnOver(admin).then(() => this.perform(step));
            return { ok: true, text: `Allowed: flotti will ${doing(step)} once this turn is over.` };
        }
        return this.perform(step);
    }
    /**
     * A person allows or refuses an action waiting for it.
     *
     * @returns Whether such an action was waiting.
     */
    answer(actionId: string, allow: boolean): boolean {
        const resolve = this.waiting.get(actionId);
        if (resolve === undefined) {
            return false;
        }
        this.waiting.delete(actionId);
        resolve(allow);
        return true;
    }
    /** Why the caller may not do it: it is not an administrator, or there is no such agent. */
    private refusal(admin: string, target: string): string | undefined {
        const agents = this.fleet.agents();
        if (agents.find((agent) => agent.id === admin)?.admin !== true) {
            return 'Refused: only an administrator of the fleet may restart agents or clear their context, '
                + 'and you are not one. A person makes an agent an administrator in the settings of flotti.';
        }
        if (!agents.some((agent) => agent.id === target)) {
            return `There is no agent "${target}" in the fleet; list_agents names them.`;
        }
        return undefined;
    }
    /** Shows the action as waiting and resolves once a person answered. */
    private allowed(step: Step): Promise<boolean> {
        this.tell(step, 'pending');
        return new Promise((resolve) => this.waiting.set(step.actionId, resolve));
    }
    private async perform(step: Step): Promise<AdminOutcome> {
        try {
            await (step.action === 'restart' ? this.fleet.restart(step.target) : this.fleet.clearContext(step.target));
        } catch (error) {
            this.tell(step, 'failed', describeError(error));
            return { ok: false, text: `Could not ${doing(step)}: ${describeError(error)}` };
        }
        this.tell(step, 'done');
        return { ok: true, text: step.action === 'restart' ? `"${step.target}" is restarted.` : `The context of "${step.target}" is cleared.` };
    }
    /** One state of the action, in the tab of the administrator and in that of the agent. */
    private tell(step: Step, state: AdminActionState, reason?: string): void {
        const body: AgentEventBody = { type: 'admin-action', ...step, state, ...(reason === undefined ? {} : { reason }) };
        this.fleet.note(step.admin, body);
        if (step.target !== step.admin) {
            this.fleet.note(step.target, body);
        }
    }
}
export { FleetAdmin };
export type { AdminFleet, AdminOutcome, FleetAdminOptions };
