import type { AgentEvent } from './agent-events.js';
/**
 * How the answer of an agent reaches its tab and the feed of the fleet (#157):
 * - `streamed` — piece by piece, as the agent writes it: the message grows in place;
 * - `whole`    — once, when the message is complete: nothing partial is shown.
 *
 * One rule for every agent, local over ACP or remote over A2A, chosen in
 * Settings and saved in `~/.flotti/settings.json`.
 */
type AnswerDelivery = 'streamed' | 'whole';
const ANSWER_DELIVERIES: readonly AnswerDelivery[] = ['streamed', 'whole'];
/** What most agents do today, and what a fleet that never chose gets. */
const DEFAULT_ANSWER_DELIVERY: AnswerDelivery = 'streamed';
function isAnswerDelivery(value: unknown): value is AnswerDelivery {
    return (ANSWER_DELIVERIES as readonly unknown[]).includes(value);
}
type AgentMessage = AgentEvent & { type: 'message' };
/** The message an agent is in the middle of; `held` is the pieces so far as one, when the rule holds them back. */
type Current = { readonly messageId: string; held: AgentMessage | undefined };
/**
 * What the tab gets of one event: `released` — a message held back until now,
 * complete, to go first; `kept` — whether the event itself goes on. A piece
 * that is held back is neither.
 */
type Outcome = { readonly released?: AgentMessage; readonly kept: boolean };
/** Statuses after which no turn of the agent will end: what was held is all there is. */
const STOPPED_STATUSES: ReadonlySet<string> = new Set(['stopped', 'error']);
/** A piece of an answer of the agent: what the rule is about. */
function isAnswerPiece(event: AgentEvent): event is AgentMessage {
    return event.type === 'message' && event.role === 'agent';
}
/** After this event the message the agent was writing is complete, one way or another. */
function endsMessage(event: AgentEvent): boolean {
    return event.type === 'turn-end' || stoppedBy(event) || (event.type === 'message' && event.role === 'user');
}
function stoppedBy(event: AgentEvent): boolean {
    return event.type === 'status' && STOPPED_STATUSES.has(event.status);
}
/** The pieces so far and this one, as one message: `append` adds, anything else starts the text over. */
function grown(held: AgentMessage, piece: AgentMessage): AgentMessage {
    return piece.append ? { ...held, text: held.text + piece.text } : piece;
}
/**
 * Applies the rule on the way to the dashboard — the one place for every
 * agent, whatever protocol brought the pieces. The rule is asked when a
 * message starts, so a change in Settings takes effect with the next message
 * and no agent is restarted. A message is held back only inside a turn: there
 * its end is marked — another message begins, the turn ends, the agent stops,
 * a person writes. What an agent says outside a turn has no such mark and
 * goes on as it comes. Tool calls, thoughts and lines of flotti go on at once,
 * and the held message follows them once it is complete. What agents say to
 * one another is not touched here: that goes its way before the tab.
 */
class AnswerDeliveryRule {
    private readonly current = new WeakMap<object, Current>();
    constructor(private readonly mode: () => AnswerDelivery) {}
    /**
     * Passes one event of an agent through the rule.
     *
     * @param owner Whose tab: the rule keeps one message in progress per owner.
     * @param inTurn Whether the agent is in a turn: only then can a message be held back.
     */
    take(owner: object, event: AgentEvent, inTurn: boolean): Outcome {
        if (isAnswerPiece(event) && inTurn) {
            return this.piece(owner, event);
        }
        return this.through(owner, event);
    }
    /** An event that goes on as it is; what was held goes before it when this event completes it, or is itself a piece said outside a turn. */
    private through(owner: object, event: AgentEvent): Outcome {
        const completes = endsMessage(event) || isAnswerPiece(event);
        return { ...(completes ? releasing(this.letGo(owner)) : {}), kept: true };
    }
    /** What the owner still holds, as one message, and the end of it; nothing when nothing is held. */
    private letGo(owner: object): AgentMessage | undefined {
        const held = this.current.get(owner)?.held;
        this.current.delete(owner);
        return held;
    }
    private piece(owner: object, event: AgentMessage): Outcome {
        const current = this.current.get(owner);
        if (current?.messageId === event.messageId) {
            return this.goesOn(current, event);
        }
        const released = this.letGo(owner);
        const held = this.mode() === 'whole' ? { ...event, append: false } : undefined;
        this.current.set(owner, { messageId: event.messageId, held });
        return { ...releasing(released), kept: held === undefined };
    }
    /** One more piece of the message in progress: shown at once, or added to what is held. */
    private goesOn(current: Current, event: AgentMessage): Outcome {
        if (current.held === undefined) {
            return { kept: true };
        }
        current.held = grown(current.held, event);
        return { kept: false };
    }
}
function releasing(released: AgentMessage | undefined): Pick<Outcome, 'released'> {
    return released === undefined ? {} : { released };
}
export { ANSWER_DELIVERIES, AnswerDeliveryRule, DEFAULT_ANSWER_DELIVERY, isAnswerDelivery };
export type { AnswerDelivery };
