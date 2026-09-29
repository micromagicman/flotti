import type { Meta, StoryObj } from '@storybook/react-vite';
import { Message } from '../src/components/Message.js';
import type { MessageActions } from '../src/components/Message.js';
import { AGENTS, COLORS, LONG_TEXT, message } from './fleet.js';
import { FeedFrame } from './frame.js';
const QUOTED = 'In localStorage, under `flotti.language`; the provider reads it once and writes every change.';
/** What the messages can do in a story: a reply and a jump go nowhere, a forward arrives. */
const ACTIONS: MessageActions = {
    onReply: () => undefined,
    onForward: () => Promise.resolve(),
    hasQuoted: () => true,
    onOpenQuote: () => undefined
};
const meta = {
    title: 'Dashboard/Message',
    component: Message,
    decorators: [(Story) => <FeedFrame><Story /></FeedFrame>],
    args: {
        agentId: 'scout',
        agentName: 'Scout',
        agents: AGENTS,
        colors: COLORS,
        actions: ACTIONS,
        item: message({ seq: 1, role: 'user', minutesAgo: 10, text: 'Where does the page keep the language a person picked?' })
    }
} satisfies Meta<typeof Message>;
export default meta;
type Story = StoryObj<typeof meta>;
/** A person to the agent: a tinted bubble on the right. Reply and Forward show on hover. */
export const FromPerson: Story = {};
/** The agent to a person, with a link and a paragraph. */
export const FromAgent: Story = {
    args: { item: message({ seq: 2, role: 'agent', minutesAgo: 9, text: `${QUOTED}\n\nThe rule is in the README: https://github.com/micromagicman/flotti#settings` }) }
};
/** A reply: the quoted message above, a jump to it laid over the quote. */
export const Reply: Story = {
    args: { item: message({ seq: 3, role: 'user', minutesAgo: 8, text: 'And when the storage is shut?', replyTo: { agentId: 'scout', messageId: 'msg-2', seq: 2, author: 'scout', text: QUOTED } }) }
};
/** A reply to a message that has left the feed: the quote says so and leads nowhere. */
export const QuoteGone: Story = {
    args: {
        ...Reply.args,
        actions: { ...ACTIONS, hasQuoted: () => false }
    }
};
/** A message sent on with a word above it: the forwarded text under a bar in the colour of its author. */
export const Forwarded: Story = {
    args: { item: message({ seq: 5, role: 'user', minutesAgo: 5, text: 'Builder asked me to pass this on.', forwarded: { author: 'builder', text: 'The tests of the release branch are green; the tag can go.' } }) }
};
/** A forward with nothing written above it shows only what it forwards. */
export const ForwardedAlone: Story = {
    args: { item: message({ seq: 6, role: 'user', minutesAgo: 4, text: '', forwarded: { text: 'A note a person wrote to Builder, sent on as it was.' } }) }
};
/** A message another agent sent to this one: an envelope on the person's side, in the colour of the sender. */
export const EnvelopeIn: Story = {
    args: { item: message({ seq: 7, role: 'user', minutesAgo: 3, text: 'Reviewed #142: the fix is right, and the test now names the tag it expects.', from: 'reviewer' }) }
};
/** A message this agent sent to another: an envelope on the agent's side. */
export const EnvelopeOut: Story = {
    args: { item: message({ seq: 8, role: 'agent', minutesAgo: 2, text: 'Please review the fix in #142.', to: 'reviewer' }) }
};
/** A forward that does not go: pick an agent under Forward, and the message says why. */
export const ForwardFails: Story = {
    args: {
        actions: { ...ACTIONS, onForward: () => Promise.reject(new Error('Builder is stopped')) }
    }
};
/** A long message with a long address: the text wraps, the address breaks where it must. */
export const LongText: Story = {
    args: { item: message({ seq: 9, role: 'agent', minutesAgo: 1, text: LONG_TEXT }) }
};
/** On a phone Reply and Forward are always in sight: there is nothing to hover with. */
export const Phone: Story = {
    args: FromAgent.args,
    globals: { viewport: { value: 'phone', isRotated: false } }
};
export const Dark: Story = {
    args: EnvelopeIn.args,
    globals: { scheme: 'dark' }
};
