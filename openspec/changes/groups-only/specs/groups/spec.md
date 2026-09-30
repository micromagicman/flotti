# groups

0.7.0 (#171–#175): a message between agents goes through a group only; group traffic is read in the tab
of the group and not in the tab of the member; a mention `@<id>` addresses a member; a group is managed
from its tab and made in its section, and Settings → Groups goes.

## ADDED Requirements

### Requirement: Group traffic is read in the tab of the group only

The tab of an agent SHALL show what the person and the agent say to each other, and the tab of a group
what was said in the group: one message, one place. The supervisor SHALL put `group` on every event of
the turn a group message started — the agent's messages, its thoughts, its tool calls, the `turn-end` —
not on the first message only, and the history file of the agent SHALL keep every event. The page SHALL
drop the events that carry `group` on the way into the agent's tab, in one pure rule of the reducer. A
permission request raised in a group turn, and a request of an administrator that waits for the
person, SHALL stay in the tab of the agent, marked with the group, and the `waiting` mark follows it. The
status badge of the agent still says `working` during a group turn. Rows of 0.6.x are not rewritten: a
group message of 0.6.x in a member's tab is hidden, the answer that followed it stays as a row until it
ages out. (Open question 6 of the proposal: the whole turn, permission requests excepted, is what this
assumes; open question 2: the direct rows of 0.6.x between two agents stay in sight.)

#### Scenario: A group message and its turn produce no rows in the member's tab

- **WHEN** eva posts to group `release` and reviewer answers in the turn it started
- **THEN** reviewer's tab shows neither the message nor the answer, its thoughts or its tool calls; the
  group tab shows the message and the answer; reviewer's history file has every event, each with `group`

#### Scenario: A permission request of a group turn stays

- **WHEN** reviewer's turn on a group message asks the person for a permission
- **THEN** the request is shown in reviewer's tab, marked with the group, and the sidebar marks reviewer
  as waiting

#### Scenario: A direct message produces no row in a group

- **WHEN** the person writes to eva in eva's tab
- **THEN** no group tab shows it

#### Scenario: A page of 0.6.x

- **WHEN** a page written before 0.7.0 opens the history of a member
- **THEN** it shows the group turns in the tab of the agent as it did, and loses nothing

### Requirement: A mention addresses a member of the group

flotti SHALL read a mention as `@<id>` in the text of a group message — `@` at the start of the text or
after a space, a bracket or a comma, followed by the id of a member as `list_groups` gives it — with one
pure parser (`mentionsIn(text, members) → ids`) on every path a group message comes in: the person's
composer, `send_message` and `forward` with `group`, `reply` to a group, the inbox with `group`, and the
answer flotti posts at the end of a turn. `eva@example.com` is a mail address, not a mention. A mention
of an id that is not a member of the group SHALL be refused with one sentence, whether the id is an agent
of another group or nobody — the tool answers `there is no "x" among the members of group "release";
list_groups names them`, the person gets `400` with `"x" is not a member of group "release"`, the inbox
gets a line in the sender's tab — and the message SHALL NOT be posted. The history line of the group
SHALL carry `mentions: [ids]` in the order of the text, absent when there is none; the `group-message`
of the socket and the `message` event of the tab carry it too. (Open question 4 of the proposal: `@<id>`
only, not `@<name>`.)

#### Scenario: A mention in a message to the group

- **WHEN** eva posts `@codex please review the diff` to group `release` and codex is a member
- **THEN** the message is posted with `mentions: ["codex"]` on the history line, and every member gets it

#### Scenario: A mention of a non-member is refused

- **WHEN** eva posts `@tester …` to group `release` and tester is not a member — an agent of another
  group, or nobody
- **THEN** the tool answers `there is no "tester" among the members of group "release"; list_groups
  names them`, and the message is not posted

#### Scenario: A mail address is not a mention

- **WHEN** the text has `eva@example.com`
- **THEN** no mention is read from it

### Requirement: Only the mentioned members answer in the round

flotti SHALL ask for an answer in the turn a group message started from the mentioned members only, and
from every member when the message mentions nobody, as before. Every member still gets the message —
a member not mentioned takes it as a turn, for context — but what a member not mentioned says in that
turn SHALL NOT be posted to the group (and by isolation it is not shown in its tab; it rests in its
history). A mentioned member's answer quotes the message and mentions nobody by itself, so one message
earns at most one round of answers.

#### Scenario: Only the mentioned answers

- **WHEN** the person posts `@codex …` to a group of codex, eva and reviewer
- **THEN** every member gets the message, codex's answer is posted to the group, and what eva and
  reviewer say in their turns is not

#### Scenario: No mention, everyone answers

- **WHEN** a message to the group mentions nobody
- **THEN** every member's answer in the turn is posted to the group, one round, as in 0.6.0

### Requirement: The composer offers the members on @ and the row shows a mention as a chip

The composer of a group tab SHALL open, on `@`, a picker over the members — mark, name, id — driven by
the arrows and Enter, inserting `@<id> `; Escape closes it. The lane SHALL show a mention as a chip with
the mark and the name of the agent in place of `@id`, and a click on it opens the tab of that agent; a
mentioned member that is not in the fleet any more is shown by id. An agent posts a mention as `@<id>`
in the text of `send_message`; nothing is added to the tool schema.

#### Scenario: The picker

- **WHEN** the person types `@` in the composer of a group tab
- **THEN** the members are offered by mark, name and id; Enter inserts `@<id> ` of the picked one

#### Scenario: The chip

- **WHEN** a message in the lane of a group mentions codex
- **THEN** the row shows a chip with codex's mark and name where `@codex` was, and a click opens codex's tab

### Requirement: A group is managed from its tab

**Edit** in the header of the group tab SHALL open the group form in place, over the lane — the id
read-only, the name, the topic, the members as ticks, ids not in the fleet as *not in the fleet* and a
line for ids typed by hand; **Save** writes `PUT /api/groups/<id>` and the lane comes back with the
header changed; **Cancel** drops the draft. The check is the server's (`parseGroup`) with its sentences.
**Delete** SHALL stand in the editor with a confirmation naming the group; `DELETE /api/groups/<id>`
moves the directory to `.trash/`, and the page goes to the next tab of the Groups section, or to its
empty state with the «Everyone» offer when none is left. The agents see a change on their next
`list_agents`, and a remote agent gets the roster again. The API of groups does not change.

#### Scenario: Rename and change the members from the tab

- **WHEN** the person clicks Edit in the tab of a group, changes the name and the members and saves
- **THEN** `groups/<id>/group.json` follows, the header shows the new name and members, and the agents
  see the change on their next `list_agents`

#### Scenario: A wrong change is refused with the server's sentence

- **WHEN** the person saves a member id that is not an agent id
- **THEN** the form shows the sentence of `parseGroup`, and nothing is written

#### Scenario: Delete from the tab

- **WHEN** the person clicks Delete in the editor and confirms
- **THEN** the directory is moved to `.trash/`, and the page goes to the next group or to the empty state
  of the section

### Requirement: A group is made in the Groups section

The Groups section SHALL end with an **Add group** tab, as the Agents section ends with Add agent: it
opens the group form for a new group (the id picked once — it names the directory) as a panel, and a
saved group opens its tab. The «Everyone» offer of an empty section stays one click. Settings SHALL have
no Groups list any more, and the empty state of the section SHALL NOT point to Settings.

#### Scenario: Add group in the section

- **WHEN** the person opens Add group at the end of the Groups section and saves a group
- **THEN** `groups/<id>/group.json` is on disk and the tab of the new group opens

#### Scenario: Settings has no Groups

- **WHEN** the person opens Settings
- **THEN** there is no Groups list; groups are made and changed in the Groups section and the tab

## MODIFIED Requirements

### Requirement: Writing to a non-peer is refused with the words for a missing agent

flotti SHALL refuse a *message* from one agent to another named with `to` on every path — the tools,
the inbox — before the peers are asked: the sentence names the way (`"to" is gone: a message to another
agent goes through a group — name the group in "group" and the agent with @<id> in the text` on the
tools; on the inbox a line in the sender's tab, `could not deliver the message to "x": a message to
another agent goes through a group; name it in "group"`, and the agent is not told). `canReach(from, to)`
SHALL still be asked at the three doors for what goes between agents by name: a task (to a member of the
named group), the administrators (`restart_agent`, `clear_context`, the `admin` requests of the inbox)
and the answer flotti sends back at the end of a turn; a non-peer there is refused with the words for a
missing agent, `there is no agent "x" among the agents you can write to; list_agents names them`, and
the sender's tab says the real reason. A person's message is not checked. An exchange allowed at the
door SHALL complete even after a membership change.

#### Scenario: A message to an agent outside every shared group

- **WHEN** eva delegates a task to tester, and the two share no group
- **THEN** the tool answers `there is no agent "tester" among the agents you can write to; list_agents
  names them`, tester gets nothing, and eva's tab says `"tester" is not in a group with "eva"`

#### Scenario: The same refusal on the inbox and on a task

- **WHEN** a remote agent posts a `task` to tester through the inbox, or sends an `admin` request for
  tester, and the sender is in no group with tester
- **THEN** it is refused with the same words as for an agent that does not exist, and tester is not told

#### Scenario: An outcome comes back after the membership changed

- **WHEN** eva gave reviewer a task while they shared a group, and the person then took reviewer out of it
- **THEN** the outcome of the task still reaches eva

#### Scenario: A message with to between agents is refused before the peers are asked

- **WHEN** eva calls `send_message` with `to: "reviewer"`, a peer of hers
- **THEN** the tool answers `"to" is gone: a message to another agent goes through a group — name the
  group in "group" and the agent with @<id> in the text`, and reviewer gets nothing

### Requirement: A message to a group reaches every other member

flotti SHALL deliver a message to a group to every member but the sender, each on its own, as a
broadcast does, and SHALL write it to the history of the group with how each member took it. `group` is
the one address of a message between agents: `send_message` and `forward` SHALL take `group` only,
`reply` SHALL answer in the group the last message came from — when none came through a group yet it
says so and names `send_message` with `group` — and a remote agent posts `group` under the inbox
extension with `kind: message`. A person posts with `POST /api/groups/<id>/messages`. A group the
sender is not in, or that does not exist, SHALL be refused with a line in the tab of the sender saying
why. The mentions in the text are read on the way in (see «A mention addresses a member of the group»).
A stopped member SHALL NOT get the message and nothing is kept for it; the history says so.

#### Scenario: The person writes to a group

- **WHEN** the person sends a message in the tab of group `release` with members eva and reviewer
- **THEN** eva and reviewer each get it, the history of the group has one line with the deliveries, and
  the tab shows under the message how each member took it

#### Scenario: An agent writes to a group

- **WHEN** eva calls `send_message` with `group: "release"`
- **THEN** every other member of `release` gets it as a message from eva, the history of the group has
  one line, and eva's tab shows the message as sent to the group

#### Scenario: to and group together are refused

- **WHEN** a remote agent posts a message that names both `to` and `group`
- **THEN** it is refused with a line in the tab of the sender saying why

#### Scenario: A stopped member

- **WHEN** a member of the group is stopped when a message is posted
- **THEN** it does not get the message, nothing is kept for it, and the history line says so for that
  member

#### Scenario: reply before any group message

- **WHEN** eva calls `reply` and no message came to her through a group yet
- **THEN** the tool says so and names `send_message` with `group`

### Requirement: A member gets a group message marked with the group

flotti SHALL deliver a group message to a member as a message from the sender marked with the group and
with who is asked: in the text for a local agent over ACP and for a remote agent without the inbox —
`[from eva in group release, to you] …` for a mentioned member, `[from eva in group release, to codex] …`
for the others, `[from eva in group release] …` when nobody is mentioned, `[in group release, to you] …`
when the person wrote — and as `group` and `mentions` beside `from` in the inbox metadata for a remote
agent with the inbox (`{"from": "eva", "group": "release", "mentions": ["codex"]}`, the same array for
every member; `mentions` absent when there is none). The `message` event of the member's tab SHALL
carry `group` and `mentions` next to `from`; the tab of the member SHALL NOT show it (see «Group
traffic is read in the tab of the group only»).

#### Scenario: A local agent gets the group in the text

- **WHEN** eva posts `@codex …` to group `release`, and codex and reviewer are local agents over ACP
- **THEN** codex's turn starts with `[from eva in group release, to you] …`, and reviewer's with
  `[from eva in group release, to codex] …`

#### Scenario: A remote agent gets the group in the metadata

- **WHEN** eva posts `@codex …` to group `release` and reviewer is a remote agent with the inbox extension
- **THEN** reviewer gets the message with `{"from": "eva", "group": "release", "mentions": ["codex"]}`
  under the extension URI

#### Scenario: What the member's tab shows

- **WHEN** a group message reaches reviewer
- **THEN** the `message` event of reviewer's tab carries `group: "release"` and the mentions, and the
  tab does not show it — the message is read in the tab of the group

### Requirement: A member's answer is posted to the group as one round

flotti SHALL post what a *mentioned* member — or any member, when the message mentions nobody — answers
in the turn a group message started to the group: its history, its tab, the other members, as a message
from that member that answers the one it got (`replyTo`), marked as an answer flotti posted
(`turnAnswer`). A member's turn on such an answer SHALL post nothing back by itself, so one message to a
group earns at most one round of answers; a member with more to say says it on purpose with
`send_message` and `group`, and a member that wants a particular agent to answer next writes `@id` on
purpose.

#### Scenario: One round of answers

- **WHEN** the person posts to a group of eva and reviewer, mentioning nobody, and both answer in their
  turns
- **THEN** each answer is posted to the group once, the other member gets it, and the turns those
  answers start post nothing back

#### Scenario: A member not mentioned owes no answer

- **WHEN** the person posts `@eva …` to a group of eva and reviewer
- **THEN** eva's answer is posted to the group and reviewer's turn answer is not

### Requirement: The tab of a group

The dashboard SHALL give every group a tab (`_group:<id>`) with a header — the name, the topic, the
members as marks and names with a member not in the fleet in grey, and **Edit**, which opens the group
form in place over the lane — one lane in the order the messages were sent (the person's messages, the
agents' messages, the answers marked as answers, quotes and forwards, mentions as chips, and under a
message how the members took it, folded), and a composer at the bottom with the `@` picker: Enter sends
to the group, Reply quotes. The history of a group SHALL be read over the socket as `group-message`,
asked for on `subscribe` under the tab id of the group. (Assuming open question 1 = (a), the lane also
shows the task card of a task given inside the group.)

#### Scenario: The tab shows the conversation of the group

- **WHEN** the person opens the tab of a group after a message and the members' answers
- **THEN** the lane shows the message, the answers marked as answers, and how each member took the
  message, folded under it

#### Scenario: Edit in the header

- **WHEN** the person clicks Edit in the header of the tab
- **THEN** the group form opens in place over the lane, with the id read-only

### Requirement: The Groups section of the rail

The rail SHALL have a **Groups** section listing the groups of the fleet with the marks of their
members, ending with the **Add group** tab; a group with something new carries the unread dot. When the
fleet has agents but no group, the section SHALL say that the agents do not see each other yet and
offer one click that puts every agent of the fleet in one group named «Everyone», without pointing to
Settings. The details of an agent («i» in the header) SHALL list its groups.

#### Scenario: A fleet with agents and no group

- **WHEN** the fleet has agents and `groups/` is empty or absent
- **THEN** the Groups section says the agents do not see each other yet and offers one click that makes
  the group «Everyone» of every agent

#### Scenario: A group with something new

- **WHEN** a message is posted to a group whose tab is not open
- **THEN** the group carries the unread dot in the Groups section

#### Scenario: Add group at the end of the section

- **WHEN** the person opens the Groups section
- **THEN** its last tab is Add group

### Requirement: Groups add optional fields only

The events, the socket and the history files SHALL gain optional fields only — `group` on a `message`
event and on every event of a group turn, `mentions` on the line of a group and on a `message` event,
`groups` in the `fleet` message of the socket, `group-message` on the socket — so a page or an adapter
written before sees fields it ignores and loses nothing. An adapter that posts `to` between agents gets
a refusal line in the sender's tab and needs `group` to post again; the roster is unchanged, and `id`
is what a mention names. A fleet of 0.6.x needs nothing: its pair conversations were derived, not
stored. A deleted agent is out of every group, and the messages it wrote in a group stay in the history
under its id, shown as *not in the fleet*.

#### Scenario: An adapter written before 0.6.0

- **WHEN** a remote agent with an adapter that knows the roster and `to` only is put in a group
- **THEN** its roster is shorter and carries a `groups` it ignores, a group message reaches it with
  `from` it reads and `group` and `mentions` it ignores, and a message it posts with `to` to another
  agent is refused with a line in its tab

#### Scenario: An adapter that posts with group

- **WHEN** a remote agent posts `group` under the inbox extension, as in 0.6.0
- **THEN** nothing changes for it: the message is posted, the mentions in its text are read

## REMOVED Requirements

### Requirement: Groups are created and managed in Settings → Groups

**Reason**: The owner decided (#175) that groups are made and changed where they are read: the Groups
section and the tab of the group. Settings → Groups was a list of what the rail already lists.

**Migration**: None on disk — the API of groups does not change. The page loses `GroupSettings.tsx`,
`GroupEditor`, `atGroup`, `editGroupOf` and `sidebar.noGroupsWhy`; see «A group is managed from its tab»
and «A group is made in the Groups section».
