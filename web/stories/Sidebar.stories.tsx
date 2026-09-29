import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { Sidebar } from '../src/components/Sidebar.js';
import type { Section } from '../src/sidebar-sections.js';
import { AGENTS, COLORS, CONVERSATIONS, FEEDS, LONG_NAME, SEEN_SEQ, TABS, feed, manyAgents, message } from './fleet.js';
import { PageFrame } from './frame.js';
type SidebarProps = ComponentProps<typeof Sidebar>;
type DemoProps = Omit<SidebarProps, 'onSelect' | 'onSection' | keyof typeof TABS>;
/** The sidebar with the page's part played by state: a click opens the tab, the rail opens the section. */
function SidebarDemo({ selected: initialTab, section: initialSection, ...rest }: DemoProps) {
    const [selected, setSelected] = useState(initialTab);
    const [section, setSection] = useState<Section>(initialSection);
    return (
        <PageFrame side={<Sidebar {...rest} {...TABS} selected={selected} onSelect={setSelected} section={section} onSection={setSection} />}>
            <p className="muted" style={{ margin: 'auto' }}>{selected}</p>
        </PageFrame>
    );
}
const meta = {
    title: 'Dashboard/Sidebar',
    component: SidebarDemo,
    args: {
        agents: AGENTS,
        feeds: FEEDS,
        colors: COLORS,
        conversations: CONVERSATIONS,
        seenSeq: SEEN_SEQ,
        selected: 'builder',
        section: 'agents'
    }
} satisfies Meta<typeof SidebarDemo>;
export default meta;
type Story = StoryObj<typeof meta>;
/** The Agents section: four agents, one of each state; Scout has new output, Reviewer waits. */
export const Agents: Story = {};
/** The Fleet section: the broadcast and the feed. Agents, closed, carries the ochre dot: Reviewer waits for a person. */
export const Fleet: Story = {
    args: { selected: 'all', section: 'fleet' }
};
/** The conversations of the fleet: one pair so far, the list of them all under it. */
export const Conversations: Story = {
    args: { selected: '_conversations', section: 'conversations' }
};
/** A fleet with no agent yet: Add agent is all the section lists. */
export const Empty: Story = {
    args: { agents: [], feeds: {}, colors: {}, conversations: [], seenSeq: {}, selected: '_add-agent' }
};
/** Fourteen agents: the section scrolls, the statuses cycle. */
export const ManyAgents: Story = {
    args: { ...manyAgents(14), conversations: [], seenSeq: {}, selected: 'agent-2' }
};
/** A name that does not fit: cut with an ellipsis in the tab. */
export const LongNames: Story = {
    args: {
        agents: [{ ...AGENTS[0]!, name: LONG_NAME }, ...AGENTS.slice(1)],
        selected: 'scout'
    }
};
/** An agent waiting for a person, with messages in line and a poor connection. */
export const AgentWaits: Story = {
    args: {
        feeds: { ...FEEDS, reviewer: feed([...FEEDS.reviewer!.items, message({ seq: 4, role: 'user', minutesAgo: 1, text: 'And the changelog?' })], 'waiting', { queue: [
            { messageId: 'q-1', seq: 5, time: new Date().toISOString(), text: 'Then close the milestone.' }
        ] }) },
        selected: 'scout'
    }
};
/** On a phone the rail is a row on top, and the section a row under it that scrolls sideways. */
export const Phone: Story = {
    globals: { viewport: { value: 'phone', isRotated: false } }
};
/** The dark colours of the page. */
export const Dark: Story = {
    globals: { scheme: 'dark' }
};
