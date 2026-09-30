import type { Meta, StoryObj } from '@storybook/react-vite';
import { FleetFeedPanel } from '../src/components/FleetFeedPanel.js';
import { AGENTS, COLORS, FEEDS, GROUPS, GROUP_FEEDS, LONG_NAME, LONG_TEXT, feed, manyAgents, message } from './fleet.js';
import { MainFrame } from './frame.js';
const meta = {
    title: 'Dashboard/FleetFeedPanel',
    component: FleetFeedPanel,
    decorators: [(Story) => <MainFrame><Story /></MainFrame>],
    args: {
        agents: AGENTS,
        colors: COLORS,
        feeds: FEEDS,
        groups: GROUPS,
        groupFeeds: GROUP_FEEDS,
        onOpen: () => undefined
    }
} satisfies Meta<typeof FleetFeedPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Every message of the fleet: a person to an agent, an agent to a person, one agent to another, anyone to a group — tasks, forwards, groups and answers tagged. */
export const Messages: Story = {};
/** A fleet without groups: no row goes to one. */
export const NoGroups: Story = {
    args: { groups: [], groupFeeds: {} }
};
/** No agent has written yet. */
export const Empty: Story = {
    args: { feeds: {}, groups: [], groupFeeds: {} }
};
/** A fleet with agents but no messages: the chips are there, the list says so. */
export const NoMessages: Story = {
    args: { feeds: Object.fromEntries(AGENTS.map((agent) => [agent.id, feed([], agent.status)])), groupFeeds: {} }
};
/** Long names and a long message: the row cuts the text, the chips grow. */
export const LongNames: Story = {
    args: {
        agents: [{ ...AGENTS[0]!, name: LONG_NAME }, ...AGENTS.slice(1)],
        feeds: { ...FEEDS, scout: feed([...FEEDS.scout!.items, message({ seq: 6, role: 'agent', minutesAgo: 2, text: LONG_TEXT })], 'idle') }
    }
};
/** Twenty agents with a talk each: forty messages, a row of chips that wraps. */
export const ManyAgents: Story = {
    args: { ...manyAgents(20), groups: [], groupFeeds: {} }
};
/** More messages than the feed keeps: only the latest 200 stay, and the cap says so. */
export const AtTheCap: Story = {
    args: {
        feeds: {
            ...FEEDS,
            scout: feed(Array.from({ length: 260 }, (_, i) => message({ seq: i + 1, role: i % 2 === 0 ? 'user' : 'agent', minutesAgo: 600 - i * 2, text: `Message ${i + 1} of a long talk with Scout.` })), 'idle')
        }
    }
};
/** On a phone: «Open in …» hides, only the chevron stays. */
export const Phone: Story = {
    globals: { viewport: { value: 'phone', isRotated: false } }
};
export const Dark: Story = {
    globals: { scheme: 'dark' }
};
