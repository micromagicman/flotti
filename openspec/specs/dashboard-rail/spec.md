# dashboard-rail

## Purpose

The rail of the dashboard as built in 0.6.x (#136, #144): the sections that group the tabs of the
fleet, the pick that survives a reload, and the unread marks of the tabs. This spec is the record 0.7.0
reshapes (#171, #173, #175).

## Requirements

### Requirement: The sections of the rail

The rail SHALL have four sections in this order: **Fleet** (the broadcast «All agents» and the feed
«All messages»), **Agents** (a tab per agent and **Add agent** at the end), **Groups** (a tab per group)
and **Conversations** (a tab per pair of agents that wrote to each other). The picked section SHALL
survive a reload; a closed section carries its marker.

#### Scenario: The sections of the rail

- **WHEN** the person opens the dashboard of a fleet with agents, a group and a pair that wrote to each
  other
- **THEN** the rail shows Fleet, Agents, Groups and Conversations, in that order

#### Scenario: The pick survives a reload

- **WHEN** the person picks the Groups section and reloads the page
- **THEN** the Groups section is the one shown

### Requirement: The broadcast reaches every agent

The **All agents** tab SHALL send the person's message to every agent of the fleet, or to the ones left
ticked; the answers stay in the tabs of the agents. Groups do not take the broadcast over: the person is
in no group and is bound by none.

#### Scenario: A broadcast

- **WHEN** the person sends a message in All agents with every agent ticked
- **THEN** every agent gets it in its tab, and the page shows how each one took it

### Requirement: The unread mark of a tab

The rail SHALL mark a tab as unread (`hasUnread`) when its last event is newer than the last one the
person saw, and clear the mark when the tab is opened.

#### Scenario: A tab lights up

- **WHEN** an agent gets a message while its tab is not open
- **THEN** the tab carries the unread mark until the person opens it
