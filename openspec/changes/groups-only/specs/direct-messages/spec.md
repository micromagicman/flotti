# direct-messages

0.7.0 (#171): the direct message between agents and the conversation of the pair go; the task goes
inside a group (assumes open question 1 of the proposal = (a)).

## MODIFIED Requirements

### Requirement: A task goes to one agent

flotti SHALL give a task from one agent to one member of a group they share: `delegate` and
`cancel_delegation` of the fleet tools take `group` and `to`, `task` and `cancel` of the inbox go with
`group` and `to`; `canReach` is asked of the doer as a member of that group. The task SHALL be posted to
the group as a message from the giver addressed to the doer (a mention), with the task mark and the
deadline; the doer's turn is the task as before, and the outcome SHALL be posted to the group as a
message from the doer with `task.state`. The group tab shows the task card the agent tab showed. A task
has one doer and one outcome: `group` without `to` is refused.

#### Scenario: A task and its outcome

- **WHEN** eva delegates a task to reviewer in group `release`, which both are in
- **THEN** the group gets a message from eva mentioning reviewer with the task mark and the deadline,
  reviewer's turn is the task, and the outcome is posted to the group from reviewer with `task.state`

#### Scenario: A task to a group is not a thing

- **WHEN** an agent gives a task with `group` and no `to`
- **THEN** it is refused: a task names one doer

#### Scenario: A task to a non-member of the group

- **WHEN** eva delegates a task in group `release` to tester, who is not a member of it
- **THEN** it is refused with the words for a missing agent, and tester is not told

## REMOVED Requirements

### Requirement: An agent writes to a peer directly

**Reason**: Agents talk only inside groups (#171): a private channel next to every group made the person
read one exchange in several places. A message names the group in `group` and the agent, when it is for
one of them, as `@<id>` in the text.

**Migration**: `to` leaves the schema of `send_message` and `forward`; a call with `to` is refused with
`"to" is gone: a message to another agent goes through a group — name the group in "group" and the
agent with @<id> in the text`. On the inbox, `to` with `kind: message` gets `could not deliver the
message to "x": a message to another agent goes through a group; name it in "group"` in the sender's
tab. What a pair said in 0.6.x stays in the tabs of both agents as rows from one agent to another.

### Requirement: A direct message lands in the conversation of the pair

**Reason**: Nothing lands there any more (#171).

**Migration**: None — a pair's lane was gathered from the tabs of the two agents, not stored. The
Conversations section, the pair tabs `_pair:<a>:<b>`, `web/src/conversations.ts`, `ConversationPanel`
and their tests, story and i18n keys are removed.
