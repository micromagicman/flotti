# dashboard-rail

0.7.0 (#171, #173, #175): the rail is two sections (assumes open question 3 of the proposal), Add group
is a tab of the Groups section, the unread mark follows what a tab shows.

## MODIFIED Requirements

### Requirement: The sections of the rail

The rail SHALL have two sections in this order: **Agents** (the broadcast «All agents» first, a tab per
agent, and **Add agent** at the end) and **Groups** (a tab per group and **Add group** at the end).
The picked section SHALL survive a reload; a saved pick the rail no longer has (`fleet`,
`conversations`) SHALL fall back to the first section; a closed section carries its marker.

#### Scenario: The sections of the rail

- **WHEN** the person opens the dashboard of a fleet with agents and a group
- **THEN** the rail shows Agents and Groups, in that order, with All agents the first tab of Agents

#### Scenario: The pick survives a reload

- **WHEN** the person picks the Groups section and reloads the page
- **THEN** the Groups section is the one shown

#### Scenario: A saved pick of 0.6.x

- **WHEN** the page of 0.7.0 finds `fleet` or `conversations` as the saved section
- **THEN** it shows the first section, Agents

### Requirement: The broadcast reaches every agent

The **All agents** tab, the first tab of the Agents section, SHALL send the person's message to every
agent of the fleet, or to the ones left ticked; the answers stay in the tabs of the agents. Groups do
not take the broadcast over: it is the one way to reach every agent at once, since no group holds every
agent and the person is in none.

#### Scenario: A broadcast

- **WHEN** the person sends a message in All agents with every agent ticked
- **THEN** every agent gets it in its tab, and the page shows how each one took it

### Requirement: The unread mark of a tab

The rail SHALL mark a tab as unread (`hasUnread`) when its last event *shown* is newer than the last one
the person saw — not the last event kept — and clear the mark when the tab is opened; a group turn of an
agent, hidden from its tab, SHALL NOT light the tab.

#### Scenario: A tab lights up

- **WHEN** an agent gets a message from the person while its tab is not open
- **THEN** the tab carries the unread mark until the person opens it

#### Scenario: A group turn does not light the agent tab

- **WHEN** an agent gets a group message and answers it while its tab is not open
- **THEN** its tab carries no unread mark; the tab of the group does
