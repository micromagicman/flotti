import type { AgentEvent, Quote } from './agent-events.js';
/**
 * An answer an agent owes another one: the text it said in the turn of a
 * message from that agent, and the message it answers.
 */
type Answer = {
    /** Id of the agent that sent the message: the answer goes to it. */
    readonly to: string;
    readonly text: string;
    /** The message answered, as the one that gets the answer reads it. */
    readonly replyTo: Quote;
};
/** The message of the turn when it came from another agent and wants an answer back. */
type Asked = { readonly from: string; readonly quote: Quote };
/**
 * Follows the events of one agent and tells when a turn ends that answers a
 * message of another agent: what the agent said in that turn goes back to the
 * sender. Only the answer goes back — what the agent says in its messages;
 * progress lines, thoughts and tool calls stay in its own tab.
 *
 * A message that itself answers something — it carries `replyTo` — gets no
 * answer back: otherwise two agents would answer each other for ever.
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
        if (event.type !== 'message') {
            return undefined;
        }
        if (event.role === 'user') {
            this.begin(event);
        } else if (this.asked !== undefined && event.to === undefined) {
            this.said.set(event.messageId, event.append ? (this.said.get(event.messageId) ?? '') + event.text : event.text);
        }
        return undefined;
    }
    private begin(event: AgentEvent & { type: 'message' }): void {
        this.said.clear();
        // A task has an outcome of its own, sent back as such: see Delegations.
        this.asked = event.from === undefined || event.replyTo !== undefined || event.delegation !== undefined
            ? undefined
            : { from: event.from, quote: quoteOf(event, event.from) };
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
        return { to: asked.from, text, replyTo: asked.quote };
    }
}
/** The message the answer quotes: in the tab of the agent that answers it, written by the sender. */
function quoteOf(event: AgentEvent & { type: 'message' }, author: string): Quote {
    const text = event.text.trim() === '' && event.forwarded !== undefined ? event.forwarded.text : event.text;
    return { agentId: event.agentId, messageId: event.messageId, author, text };
}
export { AgentAnswers };
export type { Answer };
