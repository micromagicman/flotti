# groups

## Purpose

Groups are the boundary of what an agent of the fleet sees and whom it can write to: a group is a
topical conversation with a name, a topic, a set of agents and a history of its own, kept as a
directory of the fleet. This spec is the record of groups as built in 0.6.x (#144, sub-issues
#149–#154; the reasons and what was rejected are in `docs/groups.md`): the model and its files, the
peers and the checks on every path between agents, the message to a group and what a member gets, the
tab and the section of the dashboard, the management in the settings, and how an existing fleet
migrates.

## Requirements

### Requirement: A group is a directory of the fleet

flotti SHALL read a group from `groups/<id>/group.json` in the fleet directory, next to `local/` and
`remote/`; the directory name is the id of the group. The file has `members` (required: ids of the
agents, in the order they were added, may be empty), `name` (optional: what is shown; the id when
absent) and `topic` (optional: what the group is about, given to the agents as it is). The id SHALL
follow the rule of an agent id — letters, digits, `.`, `_`, `-`, starting with a letter or a digit —
and ids of groups and of agents are separate namespaces. A member id the fleet does not have SHALL be
kept in the file and shown as *not in the fleet*, not refused. Fields flotti does not know SHALL be
kept, as in a manifest. Deleting an agent from the settings SHALL take it out of every group.

#### Scenario: A fleet with groups loads

- **WHEN** the fleet directory has `groups/release/group.json` with `members: ["eva", "reviewer"]`
- **THEN** the fleet loads with a group `release` of those two members, and the `fleet` message of the
  socket carries it

#### Scenario: A wrong group file is refused with the file named

- **WHEN** `groups/release/group.json` has a member that is not an agent id
- **THEN** `flotti run` refuses with a sentence naming the file and the field, like
  `…/groups/release/group.json: members[1] must be an agent id — …`

#### Scenario: A member not in the fleet is kept

- **WHEN** a group names a member id no agent of the fleet has
- **THEN** the fleet loads, the member is shown as *not in the fleet*, and it is a member again when an
  agent of that id is added

### Requirement: The peers of an agent are the members of its groups

flotti SHALL treat the members of every group an agent is in, itself excluded, as its peers; an agent
in no group has no peers. `list_agents` SHALL return the peers only, each with `groups` — the ids of
the groups shared with the caller — and the caller's own entry marked `you`; an agent with no peers
gets an empty list and a sentence saying it is in no group yet. The tool `list_groups` SHALL return the
groups the caller is in (`id`, `name`, `topic`, `members` with ids and names), read-only. The roster of
a remote agent (`docs/a2a-fleet.md`) SHALL list the peers only and carry a `groups` array of the same
shape, and SHALL be sent again when a membership changes. Administrators (`restart_agent`,
`clear_context`, the `admin` requests of the inbox) SHALL act on their peers and on themselves only.
The tools and the roster are the live source of the groups: flotti SHALL NOT put the groups in the
system prompt or the instructions of an agent.

#### Scenario: list_agents shows the peers only

- **WHEN** eva is in group `release` with reviewer and in no group with tester
- **THEN** eva's `list_agents` lists reviewer with `groups: ["release"]` and eva itself marked `you`,
  and does not list tester

#### Scenario: An agent in no group

- **WHEN** an agent is a member of no group
- **THEN** its `list_agents` is an empty list with a sentence saying it is in no group yet, and the
  roster of a remote agent goes out with an empty `agents` and a `text` that says so

#### Scenario: The roster follows a membership change

- **WHEN** a person adds a remote agent to a group
- **THEN** that agent gets its roster again, with the new peers and the group in `groups`

### Requirement: Writing to a non-peer is refused with the words for a missing agent

flotti SHALL refuse a message, a forward or a task from an agent to an agent that is not its peer on
every path — the fleet tools (`send_message`, `reply`, `forward`, `delegate`), the inbox of a remote
agent and a task — with the same sentence as for an agent that does not exist:
`there is no agent "x" among the agents you can write to; list_agents names them`. The tab of the
sender, which a person reads, SHALL say the real reason (`"x" is not in a group with "eva"`). The
check is one function, `canReach(from, to)`, asked at the three doors every agent-to-agent message
goes through; a person's message — a tab, the broadcast — is not checked. An exchange allowed at the
door SHALL complete even after a membership change: the answer flotti sends at the end of a turn, the
outcome of a task and a task taken back reach the agent that started it.

#### Scenario: A message to an agent outside every shared group

- **WHEN** eva calls `send_message` to tester, and the two share no group
- **THEN** the tool answers `there is no agent "tester" among the agents you can write to; list_agents
  names them`, tester gets nothing, and eva's tab says `"tester" is not in a group with "eva"`

#### Scenario: The same refusal on the inbox and on a task

- **WHEN** a remote agent posts `to: "tester"` through the inbox, or an agent delegates a task to tester,
  and the sender is in no group with tester
- **THEN** the message or the task is refused with the same words as for an agent that does not exist,
  and tester is not told

#### Scenario: An outcome comes back after the membership changed

- **WHEN** eva gave reviewer a task while they shared a group, and the person then took reviewer out of it
- **THEN** the outcome of the task still reaches eva

### Requirement: A message to a group reaches every other member

flotti SHALL deliver a message to a group to every member but the sender, each on its own, as a
broadcast does — a member that is down or busy holds nobody up — and SHALL write it to the history of
the group (`groups/<id>/.flotti-history.jsonl`, one message per line: who wrote it, the text, the time,
what it answers, and how each member took it: `taken`, `queued`, `failed` and why). A person posts
with `POST /api/groups/<id>/messages` (the `SendRequest` of a broadcast: `text`, `replyTo`,
`forwarded`), answered agent by agent like `POST /api/broadcast`. An agent posts with `send_message` or
`forward` with `group`, or `reply` when the last message came through a group; a remote agent posts
with `group` beside `to` under the inbox extension, with `kind: message` only. `to` and `group` together,
or a group the sender is not in or that does not exist, SHALL be refused with a line in the tab of the
sender saying why. A stopped member SHALL NOT get the message and nothing is kept for it; the history
says so for that member.

#### Scenario: The person writes to a group

- **WHEN** the person sends a message in the tab of group `release` with members eva and reviewer
- **THEN** eva and reviewer each get it, the history of the group has one line with the deliveries, and
  the tab shows under the message how each member took it

#### Scenario: An agent writes to a group

- **WHEN** eva calls `send_message` with `group: "release"`
- **THEN** every other member of `release` gets it as a message from eva, the history of the group has
  one line, and eva's tab shows the message as sent to the group

#### Scenario: to and group together are refused

- **WHEN** a message names both `to` and `group`
- **THEN** it is refused, and the tab of the sender says why

#### Scenario: A stopped member

- **WHEN** a member of the group is stopped when a message is posted
- **THEN** it does not get the message, nothing is kept for it, and the history line says so for that
  member

### Requirement: A member gets a group message marked with the group

flotti SHALL deliver a group message to a member as a message from the sender marked with the group:
in the text for a local agent over ACP and for a remote agent without the inbox —
`[from eva in group release] …`, and `[in group release] …` when the person wrote — and as `group`
beside `from` in the inbox metadata for a remote agent with the inbox (`{"group": "release"}` without
`from` for the person). The `message` event of the member's tab SHALL carry `group` next to `from`,
and the tab of the member shows the message marked with the group.

#### Scenario: A local agent gets the group in the text

- **WHEN** eva posts to group `release` and reviewer is a local agent over ACP
- **THEN** reviewer's turn starts with `[from eva in group release] …`

#### Scenario: A remote agent gets the group in the metadata

- **WHEN** eva posts to group `release` and reviewer is a remote agent with the inbox extension
- **THEN** reviewer gets the message with `{"from": "eva", "group": "release"}` under the extension URI

#### Scenario: What the member's tab shows

- **WHEN** a group message reaches reviewer
- **THEN** the `message` event of reviewer's tab carries `group: "release"`, and the tab shows the
  message marked with the group

### Requirement: A member's answer is posted to the group as one round

flotti SHALL post what a member answers in the turn a group message started to the group — its
history, its tab, the other members — as a message from that member that answers the one it got,
marked as an answer flotti posted (`turnAnswer`). A member's turn on such an answer SHALL post nothing
back by itself, so one message to a group earns at most one round of answers; a member with more to
say says it on purpose with `send_message` and `group`.

#### Scenario: One round of answers

- **WHEN** the person posts to a group of eva and reviewer and both answer in their turns
- **THEN** each answer is posted to the group once, the other member gets it, and the turns those
  answers start post nothing back

### Requirement: The tab of a group

The dashboard SHALL give every group a tab (`_group:<id>`) with a header — the name, the topic, the
members as marks and names with a member not in the fleet in grey, and **Edit**, which opens the group
in Settings → Groups — one lane in the order the messages were sent (the person's messages, the agents'
messages, the answers marked as answers, quotes and forwards, and under a message how the members took
it, folded), and a composer at the bottom: Enter sends to the group, Reply quotes. The history of a
group SHALL be read over the socket as `group-message`, asked for on `subscribe` under the tab id of the
group.

#### Scenario: The tab shows the conversation of the group

- **WHEN** the person opens the tab of a group after a message and the members' answers
- **THEN** the lane shows the message, the answers marked as answers, and how each member took the
  message, folded under it

#### Scenario: Edit in the header

- **WHEN** the person clicks Edit in the header of the tab
- **THEN** the page goes to that group's form in Settings → Groups

### Requirement: The Groups section of the rail

The rail SHALL have a **Groups** section listing the groups of the fleet with the marks of their
members; a group with something new carries the dot a conversation carries. When the fleet has agents
but no group, the section SHALL say that the agents do not see each other yet and offer one click that
puts every agent of the fleet in one group named «Everyone». The details of an agent («i» in the
header) SHALL list its groups.

#### Scenario: A fleet with agents and no group

- **WHEN** the fleet has agents and `groups/` is empty or absent
- **THEN** the Groups section says the agents do not see each other yet and offers one click that makes
  the group «Everyone» of every agent

#### Scenario: A group with something new

- **WHEN** a message is posted to a group whose tab is not open
- **THEN** the group carries the unread dot in the Groups section

### Requirement: Groups are created and managed in Settings → Groups

Settings → Groups SHALL list the groups and offer **Add group** (the id picked once — it names the
directory — the name, the topic and the members as ticks), **Edit** and **Delete**, which moves the
directory to `.trash/` like an agent's. A new or changed group SHALL be checked before it is written,
with the check of `flotti run` (`parseGroup`) and its sentences, and written atomically like a
manifest through `GET/POST/PUT/DELETE /api/groups[/<id>]`. An unknown member id typed by hand SHALL be
allowed and shown as *not in the fleet*.

#### Scenario: A group made in the settings

- **WHEN** the person adds a group in Settings → Groups
- **THEN** `groups/<id>/group.json` is on disk, the group is in the Groups section, and the agents see
  it on their next `list_agents`

#### Scenario: A wrong id is refused

- **WHEN** the person types an id that does not follow the rule of an agent id
- **THEN** the form refuses it with the sentence of `parseGroup`, and nothing is written

#### Scenario: Delete moves the directory to the trash

- **WHEN** the person deletes a group
- **THEN** its directory is moved to `.trash/` and the group leaves the section and the fleet

### Requirement: An existing fleet gets no group on upgrade

flotti SHALL make no group on the first run over a fleet without `groups/`: every agent sees no peers,
`list_agents` says the agent is in no group yet, the roster of a remote agent goes out with an empty
`agents`, and the Groups section offers the one click that makes «Everyone». An older flotti SHALL
ignore `groups/` as it ignores `.trash/`.

#### Scenario: First run after the upgrade

- **WHEN** flotti 0.6.0 runs a fleet that has no `groups/`
- **THEN** no group is made, no agent has a peer, and the Groups section offers «Everyone»

### Requirement: Groups add optional fields only

The events, the socket and the history files SHALL gain optional fields only for groups — `group` on
a `message` event, `groups` in the `fleet` message of the socket, `group-message` on the socket — so a
page or an adapter written before 0.6.0 sees a shorter roster and fields it ignores, and loses nothing.
A deleted agent is out of every group, and the messages it wrote in a group stay in the history under
its id, shown as *not in the fleet*.

#### Scenario: An adapter written before 0.6.0

- **WHEN** a remote agent with an adapter that knows the roster and `to` only is put in a group
- **THEN** its roster is shorter and carries a `groups` it ignores, a group message reaches it with
  `from` it reads and `group` it ignores, and it can write to any peer with `to`
