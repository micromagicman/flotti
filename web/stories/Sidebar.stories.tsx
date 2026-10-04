import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { Sidebar } from '../src/components/Sidebar.js';
import type { Section } from '../src/sidebar-sections.js';
import { AGENTS, COLORS, FEEDS, GROUPS, GROUP_FEEDS, LONG_NAME, SEEN_SEQ, TABS, feed, manyAgents, message } from './fleet.js';
import { PageFrame } from './frame.js';
type SidebarProps = ComponentProps<typeof Sidebar>;
type DemoProps = Omit<SidebarProps, 'onSelect' | 'onSection' | 'onEveryone' | keyof typeof TABS>;
/** The sidebar with the page's part played by state: a click opens the tab, the rail opens the section. */
function SidebarDemo({ selected: initialTab, section: initialSection, ...rest }: DemoProps) {
    const [selected, setSelected] = useState(initialTab);
    const [section, setSection] = useState<Section>(initialSection);
    return (
        <PageFrame side={<Sidebar {...rest} {...TABS} selected={selected} onSelect={setSelected} section={section} onSection={setSection} onEveryone={() => Promise.reject(new Error('No fleet behind the story.'))} />}>
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
        groups: GROUPS,
        groupFeeds: GROUP_FEEDS,
        seenSeq: SEEN_SEQ,
        selected: 'builder',
        section: 'agents'
    }
} satisfies Meta<typeof SidebarDemo>;
export default meta;
type Story = StoryObj<typeof meta>;
/** The Agents section: the broadcast first (#173), then four agents, one of each state; Scout has new output, Reviewer waits. */
export const Agents: Story = {};
/** The broadcast open, the first tab of Agents. */
export const Broadcast: Story = {
    args: { selected: 'all' }
};
/** The groups of the fleet (#152), Add group last (#175): the marks of the members in a row — Tester, not in the fleet, hollow — the name, the counts; the release group has something new. */
export const Groups: Story = {
    args: { selected: '_group:docs', section: 'groups', seenSeq: { ...SEEN_SEQ, '_group:release': 3, '_group:docs': 1 } }
};
/** A fleet with agents but no group: the section says the agents do not see each other, one click puts them all in one, and Add group is under it. */
export const NoGroups: Story = {
    args: { groups: [], groupFeeds: {}, selected: 'all', section: 'groups' }
};
/** A fleet with no agent yet: Add agent is all the section lists. */
export const Empty: Story = {
    args: { agents: [], feeds: {}, colors: {}, groups: [], groupFeeds: {}, seenSeq: {}, selected: '_add-agent' }
};
/** Fourteen agents: the section scrolls, the statuses cycle. */
export const ManyAgents: Story = {
    args: { ...manyAgents(14), groups: [], groupFeeds: {}, seenSeq: {}, selected: 'agent-2' }
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
