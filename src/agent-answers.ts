import type { AgentEvent, Quote } from './agent-events.js';
import { present } from './present.js';
/**
 * An answer an agent owes: the text it said in the turn of a message from
 * another agent, or of one posted to a group (docs/groups.md), and the message
 * it answers. It goes to the group when the message came through one, to the
 * agent that sent it otherwise.
 */
type Answer = {
    /** Id of the agent that sent the message: the answer goes to it, unless it came through a group. */
    readonly to?: string;
    /** Id of the group the message was posted to: the answer is posted there. */
    readonly group?: string;
    readonly text: string;
    /** The message answered, as the one that gets the answer reads it. */
    readonly replyTo: Quote;
};
/** The message of the turn when it wants an answer back: where it came from, and what it said. */
type Asked = Pick<Answer, 'to' | 'group'> & { readonly quote: Quote };
/**
 * Follows the events of one agent and tells when a turn ends that answers a
 * message of another agent, or one posted to a group: what the agent said in
 * that turn goes back to the sender, or to the group. Only the answer goes
 * back — what the agent says in its messages; progress lines, thoughts, tool
 * calls and what it sent elsewhere on purpose stay in its own tab.
 *
 * An answer flotti sent back this way — it carries `turnAnswer` — gets no
 * answer back: otherwise two agents would answer each other for ever. A reply
 * an agent sends itself (`replyTo` without `turnAnswer`) is a message like any
 * other, and what the receiver answers to it goes back to the agent.
 */
class AgentAnswers {
    private asked: Asked | undefined;
    /** The messages of the agent in the turn, by `messageId`, in the order they began. */
    private readonly said = new Map<string, string>();
    /** Takes the next event of the agent; returns the answer to send back when a turn that owes one ends. */
    take(event: AgentEvent): Answer | undefined {
        if (event.type === 'turn-end') {
            return this.finish(event.reason);
        }
        if (event.type === 'message') {
            this.message(event);
        }
        return undefined;
    }
    private message(event: AgentEvent & { type: 'message' }): void {
        if (event.role === 'user') {
            this.begin(event);
        } else if (this.asked !== undefined && saidHere(event)) {
            this.remember(event);
        }
    }
    private remember(event: AgentEvent & { type: 'message' }): void {
        const before = event.append ? this.said.get(event.messageId) ?? '' : '';
        this.said.set(event.messageId, before + event.text);
    }
    private begin(event: AgentEvent & { type: 'message' }): void {
        this.said.clear();
        this.asked = wantsAnswer(event) ? { ...present('to', event.from), ...present('group', event.group), quote: quoteOf(event) } : undefined;
    }
    /** A cancelled turn, or one that said nothing, owes no answer. */
    private finish(reason: string): Answer | undefined {
        const asked = this.asked;
        const text = [...this.said.values()].map((part) => part.trim()).filter((part) => part !== '').join('\n\n');
        this.asked = undefined;
        this.said.clear();
        if (asked === undefined || reason === 'cancelled' || text === '') {
            return undefined;
        }
        const { quote, ...where } = asked;
        return { ...where, text, replyTo: quote };
    }
}
/** A message of the agent said in its own tab: not sent to an agent or posted to a group on purpose. */
function saidHere(event: AgentEvent & { type: 'message' }): boolean {
    return event.to === undefined && event.group === undefined;
}
/**
 * Whether the message wants an answer back: it came from another agent, or
 * through a group, and is not itself an answer flotti sent back. A group
 * message asks the mentioned members only, and every member when it mentions
 * nobody (0.7.0, #174). A message of a person to the agent itself is answered
 * in the tab; a task has an outcome of its own, sent back as such: see
 * Delegations.
 */
function wantsAnswer(event: AgentEvent & { type: 'message' }): boolean {
    return fromElsewhere(event) && owesAnswer(event) && mentionedHere(event);
}
/** The message came from another agent, or through a group: those are the ones that earn an answer. */
function fromElsewhere(event: AgentEvent & { type: 'message' }): boolean {
    return event.from !== undefined || event.group !== undefined;
}
/** An answer flotti sent back, and a task, earn no answer of their own. */
function owesAnswer(event: AgentEvent & { type: 'message' }): boolean {
    return event.turnAnswer !== true && event.delegation === undefined;
}
/** Whether this receiver is asked: a group message asks the mentioned members only, and everyone when there is no mention. */
function mentionedHere(event: AgentEvent & { type: 'message' }): boolean {
    const mentions = event.mentions;
    return mentions === undefined || mentions.length === 0 || mentions.includes(event.agentId);
}
/** The message the answer quotes: in the tab of the agent that answers it, written by the sender — an agent, or a person. */
function quoteOf(event: AgentEvent & { type: 'message' }): Quote {
    const text = event.text.trim() === '' && event.forwarded !== undefined ? event.forwarded.text : event.text;
    return { agentId: event.agentId, messageId: event.messageId, ...present('author', event.from), text };
}
export { AgentAnswers };
export type { Answer };
