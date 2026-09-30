import type { Meta, StoryObj } from '@storybook/react-vite';
import { GroupPanel } from '../src/components/GroupPanel.js';
import { AGENTS, COLORS, GROUPS, GROUP_FEEDS, LONG_NAME, RELEASE, groupMessage, took } from './fleet.js';
import { MainFrame } from './frame.js';
/**
 * The tab of a group (#152), with no server behind it: Send and Forward call
 * /api and get an error back, which is what the tab shows then. The header,
 * the lane with the deliveries and the composer are all here.
 */
const meta = {
    title: 'Dashboard/GroupPanel',
    component: GroupPanel,
    decorators: [(Story) => <MainFrame><Story /></MainFrame>],
    args: {
        group: RELEASE,
        feed: GROUP_FEEDS.release!,
        agents: AGENTS,
        colors: COLORS,
        quotes: { hasQuoted: () => true, onOpenQuote: () => undefined },
        onEdit: () => undefined
    }
} satisfies Meta<typeof GroupPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
/** The release group: a person's message and the round of answers it earned, a reply that quotes one, a forward; Tester, not in the fleet, never gets anything. */
export const Release: Story = {};
/** A group nobody has written in yet. */
export const Empty: Story = {
    args: { group: GROUPS[2]!, feed: GROUP_FEEDS.watch! }
};
/** A group of two, without a topic, whose only message reached one member and failed for the other, stopped. */
export const Docs: Story = {
    args: { group: GROUPS[1]!, feed: GROUP_FEEDS.docs! }
};
/** A name that does not fit, in the header and in the envelopes. */
export const LongNames: Story = {
    args: {
        group: { ...RELEASE, name: LONG_NAME },
        agents: [{ ...AGENTS[1]!, name: LONG_NAME }, ...AGENTS.filter((agent) => agent.id !== 'builder')],
        feed: { messages: [groupMessage('release', { seq: 1, minutesAgo: 5, from: 'builder', text: 'A short line.', deliveries: took(['reviewer', 'taken'], ['tester', 'failed', 'not in the fleet']) })], lastSeq: 1 }
    }
};
/** On a phone: the members wrap under the name, the lane takes the width. */
export const Phone: Story = {
    globals: { viewport: { value: 'phone', isRotated: false } }
};
export const Dark: Story = {
    globals: { scheme: 'dark' }
};
