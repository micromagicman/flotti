import type { Meta, StoryObj } from '@storybook/react-vite';
import { AgentPanel } from '../src/components/AgentPanel.js';
import { AGENTS, ARCHIVIST, BUILDER, COLORS, FEEDS, GROUPS, LONG_NAME, QUEUE, REVIEWER, SCOUT, feed, healthOf } from './fleet.js';
import { MainFrame } from './frame.js';
/**
 * The tab of an agent, with no server behind it: the actions of the header
 * and the memory bank call /api and get an error back, which is what the tab
 * shows then. The feed, the line and the composer are all here.
 */
const meta = {
    title: 'Dashboard/AgentPanel',
    component: AgentPanel,
    decorators: [(Story) => <MainFrame><Story /></MainFrame>],
    args: {
        agent: SCOUT,
        feed: FEEDS.scout!,
        agents: AGENTS,
        colors: COLORS,
        groups: GROUPS.filter((group) => group.members.includes('scout')),
        onOpenGroup: () => undefined,
        dispatch: () => undefined,
        quotes: { hasQuoted: () => true, onOpenQuote: () => undefined },
        jump: undefined
    }
} satisfies Meta<typeof AgentPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Scout, idle, after a talk: questions, answers, a reply and a forward. */
export const Idle: Story = {};
/** Builder in a turn: a thought, a tool call done and one running, a task given to Reviewer and its outcome. */
export const Working: Story = {
    args: { agent: BUILDER, feed: FEEDS.builder! }
};
/** Reviewer waits for a person: a permission request with its options, the status ochre. */
export const Waiting: Story = {
    args: { agent: REVIEWER, feed: FEEDS.reviewer! }
};
/** An agent just started: nothing in the feed yet. */
export const Starting: Story = {
    args: { agent: { ...SCOUT, status: 'starting' }, feed: feed([], 'starting') }
};
/** Archivist, stopped, and why: the last line of the feed and the reason in the header. */
export const Stopped: Story = {
    args: { agent: ARCHIVIST, feed: FEEDS.archivist! }
};
/** An agent that failed: the status red, the reason next to it, Start in the place of Stop. */
export const Error: Story = {
    args: {
        agent: { ...BUILDER, status: 'error' },
        feed: feed([...FEEDS.builder!.items, { kind: 'status', key: 'err', status: 'error', reason: 'the agent exited with code 1' }], 'error', { reason: 'the agent exited with code 1' })
    }
};
/** Messages in line for a busy agent, after the feed and in the composer's status. */
export const InLine: Story = {
    args: { agent: BUILDER, feed: feed(FEEDS.builder!.items, 'working', { queue: QUEUE }) }
};
/** A remote agent over a poor SSH connection: the alarm under the header says why. */
export const PoorConnection: Story = {
    args: { agent: { ...REVIEWER, health: healthOf('poor') }, feed: FEEDS.reviewer! }
};
/** A remote agent whose tunnel is down. */
export const NoConnection: Story = {
    args: { agent: { ...REVIEWER, health: healthOf('down') }, feed: FEEDS.reviewer! }
};
/** A name that does not fit the header. */
export const LongName: Story = {
    args: { agent: { ...SCOUT, name: LONG_NAME }, agents: [{ ...SCOUT, name: LONG_NAME }, ...AGENTS.slice(1)] }
};
/** On a phone the actions fold into «⋯» and Chat and Memory take a line of their own. */
export const Phone: Story = {
    args: Working.args,
    globals: { viewport: { value: 'phone', isRotated: false } }
};
export const Dark: Story = {
    args: Waiting.args,
    globals: { scheme: 'dark' }
};
