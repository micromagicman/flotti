# direct-messages

## Purpose

Direct exchanges between two agents as built up to 0.6.x: a message, a forward or a task from one agent
to another named with `to`, checked once at the door (`canReach`, see `groups`), landing in the
conversation of the pair on the dashboard. This spec is the record 0.7.0 changes: the direct message
goes away (agents talk only inside groups, #171) and the task is reshaped.

## Requirements

### Requirement: An agent writes to a peer directly

flotti SHALL deliver a message from one agent to another named with `to`: `send_message` and `forward`
of the fleet tools take `to` (an agent id), `reply` answers the agent the last message came from when it
came straight, and a remote agent posts `to` with `kind: message` under the inbox extension. The message
reaches the receiver as a message from the sender (`[from eva] …` in the text, `from` in the inbox
metadata) and is shown in the tabs of both agents. A message that cannot be delivered — no such agent,
the agent is stopped — SHALL be a line in the sender's tab saying why; the agent itself is not told.

#### Scenario: A message with to

- **WHEN** eva calls `send_message` with `to: "reviewer"` and the two share a group
- **THEN** reviewer gets a message from eva, and the tabs of both show it

#### Scenario: An undeliverable message

- **WHEN** eva posts `to: "reviewer"` through the inbox and reviewer is stopped
- **THEN** eva's tab has a line saying why, and eva is not told

### Requirement: A direct message lands in the conversation of the pair

The dashboard SHALL show the direct messages between two agents as one lane in the tab of the pair
(`_pair:<a>:<b>`), listed in the **Conversations** section of the rail; the lane is gathered from the
tabs of the two agents, not kept as a store of its own. What was said in a group is not in a
conversation.

#### Scenario: A pair with messages

- **WHEN** eva and reviewer have written to each other with `to`
- **THEN** the Conversations section lists the pair, and its tab shows the messages as one lane

### Requirement: A task goes to one agent

flotti SHALL give a task from one agent to another named with `to` — `delegate` and `cancel_delegation`
of the fleet tools, `task` and `cancel` of the inbox — checked with `canReach` at the door; a task has one
doer and one outcome, never a group. The outcome comes back to the giver as the task's state
(`task.state`), and the tabs of the two show the task card.

#### Scenario: A task and its outcome

- **WHEN** eva delegates a task to reviewer, a peer of hers
- **THEN** reviewer's turn is the task, and the outcome comes back to eva with `task.state`

#### Scenario: A task to a group is not a thing

- **WHEN** an agent tries to give a task with `group`
- **THEN** it is refused: a task names one agent
