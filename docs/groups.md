# Groups: agents see and write to each other only inside a group

Spec of #144, the main feature of 0.6.0. Status: **built in 0.6.0** — the [sub-issues](#sub-issues)
#149–#154 are the code, as reviewed here; the [open questions](#open-questions) keep the decisions taken.
**0.7.0 changes it** — agents talk only inside groups, one message is read in one place, mentions, a
group managed from its tab: the spec of #171–#175 is the section [0.7.0: groups only](#070-groups-only)
at the end, with its own open questions and sub-issues; the sections before it are 0.6.0 as built, and a
line under each one 0.7.0 touches says what changes.

Today every agent of the fleet sees every other one — `list_agents` for a local agent, the roster of
[the fleet extension](a2a-fleet.md) for a remote one — and can write to any of them: `send_message`,
`delegate`, `forward`, or `to` of [the inbox](a2a-inbox.md). After this, **agents see and reach each
other only through a group**: a topical conversation with a name, a topic, a set of agents and a
history of its own. An agent outside a group does not get its members as peers and cannot write to
them. The person sees and reaches everyone, as before.

## What stays

- **The person is bound by nothing.** Every tab, the broadcast to all agents, the feed of every message
  (#114) and the conversations of pairs (#50) stay fleet-wide: groups are a rule for agents, not a
  filter on the dashboard.
  *0.7.0:* the feed (#173) and the conversations (#171) go; the person reads a group in its tab and an
  agent in its tab, and the broadcast stays — [0.7.0](#070-groups-only).
- **The rule lives in flotti, not in the agents.** Every message between agents already goes through
  the supervisor — a tool of the fleet, the inbox of a remote agent, a task — and that is where the
  check goes. An agent cannot get round it, and an agent that knows nothing of groups is not broken by
  them: it sees fewer peers, that is all.
- **One message, one path.** A message to a group is delivered the way a broadcast is, to every member
  on its own; a message to one agent inside a group goes the way it goes today. No new transport, no
  new protocol method.

## The model

A group is a directory of the fleet, next to the agents, and the directory name is its id:

```
~/.flotti/agents/
├── local/
├── remote/
└── groups/
    └── release/
        ├── group.json              the group
        └── .flotti-history.jsonl   its messages, written by flotti
```

```json
{
    "name": "Release 0.6.0",
    "topic": "Ship 0.6.0: the groups feature, its docs and the release notes.",
    "members": ["eva", "reviewer", "tester"]
}
```

| Field     | Required | Meaning                                                                                  |
|-----------|----------|------------------------------------------------------------------------------------------|
| `name`    | no       | What the dashboard and the agents show; the id when absent.                              |
| `topic`   | no       | What the group is about, a line or a paragraph; the agents get it as it is.              |
| `members` | yes      | Ids of the agents in the group, in the order they were added. May be empty.              |

- **The id** follows the rule of an agent id — letters, digits, `.`, `_`, `-`, starting with a letter or
  a digit — because it goes in tool arguments and in tab addresses. Ids of groups and of agents are
  separate namespaces: a group `eva` and an agent `eva` may both exist, and nothing ever takes one for
  the other, since a tool names a group in `group` and an agent in `to`.
- **A member is named by id only.** A member that is not in the fleet — deleted, or typed by hand — is
  kept in the file and shown as *not in the fleet*; it is not an error, and the fleet loads. When an
  agent of that id is added, it is in the group again. Deleting an agent from the settings takes it out
  of every group, the way it moves its directory to `.trash/`: the settings write the files, and a person
  editing by hand may leave the id.
- **An agent may be in several groups**, and the person is in none: the person is above the groups.
- **Where it lives — the fleet directory, and nothing else.** A group belongs to a fleet: switching the
  fleet directory switches the groups, several fleets on one machine keep apart, and a person can read
  and edit it by hand, as the README promises of the whole fleet (*Why JSON*). Fields flotti does not
  know are kept, as in a manifest.
- **Who changes membership.** In 0.6.0 only a person, from the dashboard (or by editing the file). The
  tools give an agent no way to join, leave or invite — see [open question 1](#open-questions).
- **The history** is the group's own, in `.flotti-history.jsonl` of the group, one message per line —
  who wrote it (an agent id, or nothing for the person), the text, the time, what it answers, and how
  each member took it — bounded and rewritten the way an agent's history is (`src/agent-history.ts`).

Rejected: *membership in the manifest of each agent* (`"groups": […]` in `agent.json`) — the topic
would have no home, a change of membership would rewrite N manifests and restart N agents, since a
changed manifest restarts its agent, and a deleted agent would leave nothing to clean; *groups in
`~/.flotti/settings.json`* — that file is one per machine, not per fleet, and holds secrets; *a history
derived from the tabs of the members*, as conversations are — a message to N members lands in N tabs,
rotates out with the busiest tab first, and vanishes with a deleted member, so the group would hold no
history of its own, which is the point of a group.

## Visibility

The **peers** of an agent are the members of every group it is in, itself excluded. An agent in no group
has no peers.

- **`list_agents`** returns the peers only, each with `groups` — the ids of the groups the caller shares
  with it — and the caller's own entry marked `you` as today. An agent with no peers gets an empty list
  and a sentence saying it is in no group yet, so it does not take the fleet for empty.
- **A new tool `list_groups`** returns the groups the caller is in: `id`, `name`, `topic`, `members`
  (ids and names). Read-only.
- **The roster** of a remote agent ([a2a-fleet.md](a2a-fleet.md)) lists the peers only and gets a
  `groups` array beside `agents`, of the same shape as `list_groups`; `text` says so. The roster is
  already built per agent (`you` marks it), so this is a filter on the way out, and a roster goes out
  again when a membership changes, as it does when an agent comes or goes. An adapter written before
  this ignores `groups` and sees a shorter `agents`: nothing to change.
- **Writing to a non-peer is refused** on every path, with the same words as for an agent that does not
  exist: `there is no agent "x" among the agents you can write to; list_agents names them`. An agent
  outside a group learns nothing of the members — not even that they exist. The tab of the sender, which
  a person reads, says the real reason (`"x" is not in a group with "eva"`), the way it says today that
  an agent is stopped.
- **Where the check goes** — one function of a new `src/groups.ts`, `canReach(from, to)`, called at
  the three doors every agent-to-agent message goes through: `sendRefusal` of the fleet tools
  (`src/fleet-mcp.ts`, for `send_message`, `reply`, `forward`), `Supervisor.forward` (`src/supervisor.ts`,
  for `to` of the inbox and for what the supervisor sends on), and `Delegations.delegate`
  (`src/delegations.ts`, for tasks, both tools and inbox). A person's message —
  `POST /api/agents/<id>/messages`, the broadcast — is not checked.
- **The door is checked on the way in; what comes back from an exchange that was allowed goes back.**
  The answer flotti sends at the end of a turn, the outcome of a task and a task taken back reach the
  agent that started the exchange even when the two no longer share a group by then: a task given
  legitimately must not lose its outcome to a membership edited in the meantime. A message sent on
  purpose — `reply`, `send_message` — is a new exchange and is checked anew.
- **Administrators** (`restart_agent`, `clear_context`, the `admin` requests of the inbox) act on the
  agents they see — the peers — and on themselves. An administrator that is to look after the whole
  fleet is put in every group; see [open question 4](#open-questions).
- **The broadcast** «All agents» stays what it is: the person's message to every agent, or the ones left
  ticked. Groups do not take it over — the person is not bound by them, and a message to a group is the
  tab of the group.
- **The feed of the fleet** (#114) stays one feed of everything, the person's view. A message to a group
  is one row, not one per member: who wrote it → the name of the group, with the group as the tag where
  a forward or a task has theirs, and a click opens the tab of the group at that message. The filter by
  agent matches a group message an agent wrote or got.
  *0.7.0:* removed (#173).
- **The conversations** of pairs show direct messages only, as today. What was said in a group is in the
  group.
  *0.7.0:* removed with the direct messages (#171).

Rejected: *administrators see the whole fleet* — that would make them the one kind of agent groups do
not apply to, and the id an administrator acts on is «as `list_agents` gives it», so the two would
disagree; *the broadcast becomes per group* — the person loses the one way to reach everyone at once;
*one feed per group* — the tab of the group is that already; *a different refusal for «not your peer»
and «no such agent»* — it tells an agent outside the group that the agent exists.

## Messaging

### A message to a group

Reaches every member but the sender, each on its own, as a broadcast does — an agent that is down or
busy holds nobody up — and is written to the history of the group with how each member took it
(`taken`, `queued`, `failed`, and why).

- **From the person:** the composer of the tab of the group; `POST /api/groups/<id>/messages` with the
  `SendRequest` of a broadcast (`text`, `replyTo`, `forwarded`), answered agent by agent like
  `POST /api/broadcast`. The tab shows, under the message, how each member took it, as the broadcast page
  does.
- **From an agent with the tools:** `send_message` takes **either `to` (an agent) or `group` (a group
  id), never both**; so does `forward`. `reply` answers where the last message came from: the group when
  it came through a group, the agent when it came straight. `delegate` names an agent only — a task has
  one doer; a task to «whoever in the group» is not in 0.6.0.
- **From a remote agent through the inbox:** `group` beside `to` under the extension URI, one or the
  other, with `kind: message` only; `task` goes with `to` only. A message with both, or with a group the
  agent is not in, is a line in the tab of the sender saying why, as an undeliverable `to` is today.
- **What a member gets:** the message in its tab from the sender, marked with the group (*0.7.0:* kept
  in its history, not shown in its tab — #172, and `mentions` beside it — #174). A local agent over ACP,
  and a remote one without the inbox, get it in the text — `[from eva in group release] …` —
  and a remote one with the inbox gets `group` beside `from` in the metadata. The person's message to a
  group reaches a member as `[in group release] …`, and as `{"group": "release"}` without `from` over
  the inbox. The `message` event of the tab carries `group` next to `from`, so the tab shows the group
  the way it shows a forward or a task.
- **What a member answers** in the turn the group message started is posted to the group — its history,
  its tab, the other members — as a message from that member that answers the one it got, marked the way
  an answer flotti sends back on its own is marked today (`turnAnswer`): a member's turn on such an
  answer posts nothing back by itself, so one message earns at most one round of answers, never a loop.
  A member with more to say says it on purpose with `send_message` and `group`. See
  [open question 3](#open-questions): this is where the cost of a group is decided.
- **The sender's tab** shows the message as sent to the group, the way it shows a message sent with `to`.
- **A member in the group but stopped** does not get the message; the history says so for that member,
  as the broadcast page does. Nothing is kept for it: the line of messages of an agent already holds what
  waits for a busy one, and a stopped agent takes nothing, today and after.

### A message to one agent inside a group

*0.7.0:* gone — a message between agents goes through a group, addressed with `@<id>` when it is for
one of them (#171, #174); what becomes of a task is [open question 1 of 0.7.0](#open-questions-070).

Exactly what an agent-to-agent message is today — `send_message` with `to`, `to` of the inbox, a task —
checked once at the door with `canReach`. It lands in the conversation of the pair, not in a group: a
direct message between two agents that share several groups belongs to no one group, and asking the
agent to name one would refuse messages for a reason no agent cares about.

Rejected: *answers to a group message stay in the tab of the member*, as they do for a broadcast — the
group would then never hold a conversation, which is what it is for; *answers go to the sender only* —
the other members miss the answer, and the person reads it in a pair instead of in the group; *a
`group` on a direct message* — nothing in 0.6.0 reads it; *a task to a group* — a task has one doer and
one outcome.

### What the adapter of an agent sees

The tools and the roster are the live source of the groups; instructions are not. A membership changes
at any time, a local agent's system prompt is fixed when its session starts, and a restart per change is
what the manifest rule already costs — so no `groups` in `systemPrompt.append` or in the instructions of
the adapter. A remote agent is told of a change through the roster, as of any change of the fleet; a
local one asks `list_groups` when it needs to.

The topic of a group reaches an agent in `list_groups` and in the roster, as it is written — so a person
writes it for the agents: what the group is for, and what its members are expected to do there.

## The dashboard

The rail of #136 gets a fourth section — **Groups** — between Agents and Conversations: Fleet, Agents,
Groups, Conversations. *0.7.0:* Conversations and the feed go (#171, #173); the shape of what is left is
[open question 3 of 0.7.0](#open-questions-070). It lists the groups of the fleet with the marks of their
members; a group with something new carries the dot a conversation carries, and a closed section its
marker. Where exactly the
tab sits and how a group is drawn on it are chosen through variants.

**The tab of a group** (`_group:<id>`, the address the feed jumps to):

- a header with the name, the topic, the members as marks and names — a member not in the fleet in grey
  — and **Edit**, which opens the group in the settings;
- one lane, in the order the messages were sent: the person's messages, the agents' messages, the
  answers marked as answers, quotes and forwards as in a conversation; under a message, how the members
  took it, folded, as the broadcast page shows deliveries;
- a composer at the bottom, as in an agent's tab: Enter sends to the group, Reply quotes.

**Creating and managing** is in **Settings → Groups**, the way agents are (*0.7.0:* moved to the tab of
the group and to the Groups section; Settings → Groups goes — #175): the list, **Add group** with
the id (picked once, it names the directory), the name, the topic and the members as ticks; **Edit**;
**Delete**, which moves the directory to `.trash/` like an agent's. A new or changed group is checked
before it is written and refused with the sentence `flotti run` would print. An unknown member id typed
by hand is allowed and shown as *not in the fleet*. The form follows the agent form and needs no variants.

**Elsewhere:** the details of an agent («i» in the header) list its groups; the feed of the fleet tags a
group message with the group; the Groups section, when the fleet has agents but no group, says that the
agents do not see each other yet and offers **one click to put every agent in one group** — see
[open question 2](#open-questions).

Rejected: *groups replace Conversations* — the conversations of pairs are the only place direct
messages between two agents are read as one lane, and #136 just gave them their tab; *groups inside the
Agents section*, as folders — an agent in several groups would be listed several times, and a group
with a history of its own is a tab, not a folder; *managing groups in the Groups section* — the settings
page is where files are written, and it says so.

## Migration

An existing fleet has no `groups/`. On the first run after the upgrade **no group is made**: every
agent sees no peers, `list_agents` says the agent is in no group yet, the roster of a remote agent goes
out with an empty `agents`, and the Groups section says the agents do not see each other yet, with the
one click that puts every agent of the fleet in one group named «Everyone». What the agents said to each
other before stays in their tabs, in the conversations and in the feed.

This is the strict reading of the feature, and it is [open question 2](#open-questions): the alternative
is a default group made by flotti, which keeps an old fleet talking and makes «nobody sees anybody» a
state no existing fleet is ever in.

An older flotti opened on a fleet with `groups/` ignores the directory — it reads `local/` and `remote/`
only, as it ignores `.trash/` — and every agent sees everyone again, which is what that version does.
Nothing in the files breaks it.

## Compatibility

- **Adapters written before 0.6.0** — a remote agent that knows the roster of a2a-fleet.md and `to` of
  a2a-inbox.md — keep working: the roster is shorter and carries a `groups` field they ignore; a group
  message reaches them with `group` in the metadata they ignore and `from` they read, and where their
  answer goes is flotti's decision, not theirs. They cannot post to a group until their adapter learns
  `group`; they can write to any peer.
- **Local agents** need nothing: `list_agents` shrinks, `list_groups` is one tool more, `send_message`
  gets an argument.
- **Remote agents over the tunnel of #113** — the mini client — are not built yet. The rule is on the
  routing path of the supervisor, not in any adapter, so whatever brings an agent in — ACP, A2A, the
  client of #113 — gets it without knowing: the client's `list_agents` is the fleet's.
- **The events, the socket and the history files** gain optional fields only (`group` on a `message`
  event; `groups` in the `fleet` message of the socket; a `group-message` message of the socket for the
  history of a group, asked for on `subscribe` under the tab id of the group as the events of an agent
  are asked for under its id). A page or a file written before does not see them and loses nothing.
- **A deleted agent** is out of every group, and the messages it wrote in a group stay in the history
  under its id, shown as *not in the fleet*.

## Open questions

Decisions a person has to take. Each has a recommendation, which is what the spec assumes above; a
different answer changes the sub-issue it names.

1. **May agents change membership themselves — join, leave, invite a peer?** *Recommended: no in
   0.6.0; a person only, from the dashboard.* Groups are the boundary of what an agent sees; a boundary
   an agent can widen by itself is advice, not a rule. If agents are to invite, the first step is a
   request the person allows or refuses, the way an administrator's action can wait for a person today —
   a follow-up, not part of this. Changes sub-issue 2 (a tool) and 5 (the confirmation).
2. **What does an existing fleet look like after the upgrade — silent until the person makes a group, or
   one default group of everyone?** *Recommended: silent, with the one click in the Groups section that
   makes «Everyone».* It is the feature; the section says why the agents are quiet and fixes it in one
   click; a default group made by flotti is a group the person did not ask for and has to delete to get
   what 0.6.0 is about. Changes sub-issue 1 (the first run) and 4 (the empty state).
3. **Does what a member answers to a group message go to the group, to the sender only, or nowhere?**
   *Recommended: to the group, one round, no loop.* A group that holds no answers is a notice board.
   The cost is that every member reads every answer of every other — N−1 turns for the message and up
   to (N−1)(N−2) for the answers — which the person controls through the size of the group. Changes
   sub-issue 3.
4. **Are administrators bound by groups like everyone, or do they see the whole fleet?** *Recommended:
   bound like everyone; an administrator for the whole fleet is a member of every group.* One rule, and
   the id an administrator acts on is «as `list_agents` gives it». Changes sub-issue 2.

## Sub-issues

Six, in this order; the dependencies are the arrows. 4 and 5 may start their variants while 2 and 3 are
built. Every sub-issue updates the README and the CHANGELOG for what it brings, as every change does.

1. **The model: groups in the fleet directory and their API.** `src/groups.ts`: `groups/<id>/group.json`
   read with the fleet (`loadFleet`, checked like a manifest, unknown members kept), `groupsOf(agent)`,
   `peersOf(agent)`, `canReach(from, to)`; `GET/POST/PUT/DELETE /api/groups[/<id>]` in the settings API,
   written atomically like a manifest, Delete to `.trash/`; the `fleet` message of the socket carries the
   groups; deleting an agent takes it out of every group.
   *Acceptance:* a fleet with `groups/` loads and lists them; a wrong `group.json` is refused with a
   sentence naming the file; a member not in the fleet loads; unit tests for the loader, the API and the
   three functions. No UI, no routing yet.
2. **Visibility on every path between agents.** → 1. `canReach` at the three doors (`sendRefusal`,
   `Supervisor.forward`, `Delegations.delegate`); `list_agents` filtered with `groups`; the new
   `list_groups`; the roster filtered with `groups` and sent again on a membership change; administrators
   act on their peers; the refusal says nothing of who exists.
   *Acceptance:* unit tests — an agent outside a group is refused on the tools, the inbox and a task with
   the same words as for no agent; inside it gets through; an outcome comes back after the membership
   changed; the roster of a remote agent lists its peers only, and again after an edit. The e2e of
   «an agent writes to another» gets its group.
3. **Messages to a group.** → 2. `POST /api/groups/<id>/messages`; `group` on `send_message`, `forward`
   and the inbox, `reply` to the group; delivery to every member but the sender; the history of the
   group and its `group-message` on the socket; the sender line `[from … in group …]` and `group` in the
   inbox metadata; the answers of the members posted to the group as one round; `group` on the `message`
   event.
   *Acceptance:* unit tests — a message from the person and from an agent reaches every other member and
   is one line of the history with the deliveries; a member's answer is in the history and reaches the
   others once, and their turns post nothing back; `to` and `group` together are refused; a group the
   sender is not in is refused. a2a-inbox.md and a2a-fleet.md are updated with `group` and `groups`.
4. **The Groups section and the tab of a group.** → 1 for the section, 3 for the lane. **Variants
   first:** where the fourth rail tab goes and how a group is drawn on it (marks of the members, the dot),
   the header of the group tab, the lane with answers and deliveries, the empty state with the one click,
   the tag and the row of a group message in the feed. Then the section, the tab with its composer, the
   unread markers, the jump from the feed, the groups in the details of an agent.
   *Acceptance:* the look chosen by the owner; unit tests for the pure parts (the section, the markers,
   the rows of the feed); e2e — a group has a tab that shows what was said in it and how each member took
   it, a message from the feed opens it, and a fleet with agents but no group offers the one click.
5. **Settings → Groups.** → 1. The list, Add group, Edit, Delete, the members as ticks, the check before
   writing; the form follows the agent form (no variants). *Acceptance:* e2e — a group made in the
   settings is on disk as `group.json` and in the Groups section, an edit changes the members and the
   agents see it on their next `list_agents`, Delete moves it to `.trash/`; a wrong id is refused with the
   sentence of the check.
6. **Acceptance end to end and the docs.** → 2, 3, 4, 5. The e2e of the acceptance of #144 as one
   scenario: two groups, an agent in one cannot write to the other's member and does not list it, inside
   it can and the person reads the conversation in the tab of the group; the README gets a «Groups»
   section and the fleet layout gets `groups/`; the CHANGELOG entry of 0.6.0 names the feature.
   *Acceptance:* the scenario passes on CI; every sentence of the README about who sees whom is true.

## 0.7.0: groups only

Asked by the owner on 30.09.2026, after a day with 0.6.0: five changes, one spec — #171 (agents talk
only inside groups), #172 (isolation by chat), #173 (no feed of the fleet), #174 (mentions), #175 (a
group is managed from its own tab). Two of them were decided by the owner in the issues and are not
open here: a mention **addresses** and does not narrow delivery (#174, variant a), and **Settings →
Groups goes away** (#175). What is decided below, what was rejected and why, the
[open questions](#open-questions-070) and the [sub-issues](#sub-issues-070) follow the form of 0.6.0.
The sections above stay as the record of 0.6.0; where 0.7.0 changes one of them, a line under it says
so and points here.

### The idea

0.6.0 made groups the boundary of what an agent sees, and left three fleet-wide views beside them: the
conversations of pairs, the feed of every message, and the tab of an agent that shows the group traffic
too. The first day with it showed the person reading the same exchange in three places and the agents keeping
a private channel next to every group. 0.7.0 closes that: **an agent says something to another agent
in a group, or not at all**, and **every message is read in one place** — the tab of the group for what
was said in a group, the tab of the agent for what the person and the agent say to each other.

### Agents talk only inside groups (#171)

- **The tools.** `send_message` and `forward` take `group` only; `to` goes out of their schema. A call
  that still names `to` — an agent with old instructions — is refused with a sentence that names the
  way: `"to" is gone: a message to another agent goes through a group — name the group in "group" and
  the agent with @<id> in the text`. `reply` answers in the group the last message came from; when no
  message came through a group yet it says so and names `send_message` with `group`, as it does today
  when nobody wrote. `list_agents`, `list_groups`, the roster and the peers stay exactly as in 0.6.0:
  what an agent *sees* does not change, only how it *writes*.
- **The inbox.** `to` with `kind: message` is refused: a line in the tab of the sender, as an
  undeliverable `to` is today — `could not deliver the message to "x": a message to another agent goes
  through a group; name it in "group"` — and the agent is not told, since the inbox has no answer to
  give it. `group` is the one address of a message. Whether `to` keeps a meaning for a task is
  [open question 1](#open-questions-070).
- **The doors.** The check of 0.6.0 stays where it is — `sendRefusal` (`src/fleet-mcp.ts`),
  `Supervisor.forward` (`src/supervisor.ts`), `Delegations.delegate` (`src/delegations.ts`) — and gets
  one rule more in front of it: a *message* with `to` between agents is refused before `canReach` is
  asked. `canReach` itself is still needed: for the task (open question 1), for the administrators
  (`restart_agent`, `clear_context`, `kind: admin`), and for the answer flotti sends back at the end of a
  turn, which goes back even after a membership edit, as in 0.6.0. `mayPost` is the check of every
  message from now on.
- **The answer of a turn** goes to the group the message came through, as today. Nothing ever goes
  back to one agent straight: `sendBack` with `to` (`src/supervisor.ts`) is left for the task only, or
  removed with it.
- **The Conversations section** and the pair tabs (`_pair:<a>:<b>`, `web/src/conversations.ts`,
  `ConversationPanel`, `conversationsId`, the section `conversations` of `web/src/sidebar-sections.ts`,
  their tests, story and the i18n keys) go: nothing lands there any more. The pairs of 0.6.x were never
  a store of their own — a lane was gathered from the tabs of the two agents — so nothing is migrated
  and nothing is lost: what a pair said is still in the tabs of both, as rows from one agent to another.
  Whether those rows stay in sight is [open question 2](#open-questions-070).
- **The refusals for a non-peer** stay as #150 made them: the same words as for an agent that does not
  exist. A mention of an agent outside the group is refused the same way — see #174 below.

Rejected: *`to` kept as a shorthand for «a message to the group, addressed to this one»* — the message
would then land in a group the sender did not name, and an agent in two groups with the receiver
would not know which; *a pair conversation kept as a group of two made by flotti* — a group is the
person's decision, and a group the person did not make is what open question 2 of 0.6.0 refused;
*`to` accepted and rewritten into a mention by flotti* — same as the first: which group.

### Isolation by chat (#172)

**The tab of an agent shows what the person and the agent say to each other; the tab of a group shows
what was said in the group.** One message, one place.

- **What stays in the tab of an agent:** the person's messages to it (its own tab, the broadcast, a
  forward the person made, a reply), everything the agent does in the turns they start, what the agent
  says of its own (`kind: message` of the inbox without `group`, a local agent's message outside a
  turn), the lines of flotti, the status and the harness, the actions of an administrator on it.
- **What leaves it:** a message that came through a group — the `message` event with `group` — and
  **the whole turn it started**: the agent's messages (the answer, which is in the group), its thoughts,
  its tool calls, the `turn-end`. What the agent did for the group is the group's business; its status
  badge still says `working` while it does it, since a status is not traffic. One exception, decided
  here: **a permission request raised in a group turn stays in the tab of the agent**, marked with the
  group — it waits for the person, and the person answers it where every permission is answered; the
  `waiting` mark of the sidebar follows it as today. The same for a request of an administrator that
  waits for the person. Whether thoughts and tool calls of a group turn should stay too is
  [open question 6](#open-questions-070).
- **Where the rule lives — the supervisor marks, the page filters.** The supervisor already knows which
  turn a group message started (`followTurn` and `AgentAnswers.asked`, `src/supervisor.ts`,
  `src/agent-answers.ts`); in `keep`, before `store`, it puts `group` on every event of that turn, not
  on the first message only. The history file keeps every event, as it keeps what the tab got today —
  **the file is the record of what the agent was told and did, and a hidden line is still a line** —
  and a page written before 0.7.0 shows them as it does now. The page drops the events that carry
  `group` on the way into the tab, in the reducer of `web/src/feed.ts`, one pure rule with a unit test:
  a group message and the turn it started produce no items; a permission request of that turn does.
  The unread mark of an agent's tab (`hasUnread`, `web/src/sidebar-sections.ts`) follows the last event
  *shown*, not the last event kept, or a group turn would light a tab that has nothing new in it.
- **The tab of a group** already shows the message and the answers of the members as one lane
  (#152); nothing changes there except that the answer is now read in one place. How each member took
  the message stays under it.
- **The broadcast** is the person's message: it reaches every agent in its tab and the answers stay
  there, as today. It is not a group.
- **Old rows** — a group message of 0.6.x in the tab of a member carries `group` on the message and
  nothing on the answer that followed: the message is hidden, the answer stays as a row of the agent
  until it ages out. Rewriting histories is not done.

Rejected: *not writing group traffic to the history of the agent at all* — the file would no longer say
what the agent was told, a reloaded page and a page of 0.6.x would disagree with the live one, and the
`AgentAnswers` and the delegations follow live events, not the file, so nothing is saved by it;
*filtering on the server, in `history()` and the `event` notice* — the page then cannot show the traffic
on purpose later (a «show group turns» switch is a page decision), and two pages of different versions
would read different histories of the same agent; *hiding the answer only and keeping the tool calls* —
see open question 6; *hiding permission requests with the turn* — an agent waiting for the person in a
turn nobody can see is a hang.

### No feed of the fleet (#173)

- **The «All messages» tab goes**, and with it `web/src/fleet-feed.ts`, `FleetFeedPanel.tsx`, its
  story and test, the filter by agent, the jump from a row to the tab it lives in (`feedOpen` in
  `web/src/App.tsx`), the `_feed` id, `feedId` in `sidebar-sections.ts` and `Sidebar.tsx`, the i18n keys
  `sidebar.allMessages*` and `fleetFeed.*`, the e2e of #114, the README paragraph. The `group` and
  `answer` tags of a feed row go with the feed; the lane of a group keeps its own «answer» mark.
- **Nothing else read the feed.** The socket, the histories and `group` on a `message` event stay —
  #172 needs the field. The jump from the feed to a group message (#152) goes with the feed;
  `found` and the quote jumps inside a lane stay.
- **The Fleet section** is left with «All agents» alone. The broadcast stays — it is the one way to
  reach every agent at once, and a group never holds every agent and the person. Where it sits when it
  is alone is [open question 3](#open-questions-070); the recommendation is a rail of **two sections,
  Agents and Groups**, with «All agents» the first tab of Agents.

Rejected: *one feed per group instead* — the tab of the group is that already, as 0.6.0 said; *the feed
kept for messages between a person and an agent only* — that is the tab of the agent, N times.

### Mentions: `@agent` in a group (#174)

The owner decided **variant (a), addressing**: a message with a mention reaches every member as today;
only the mentioned members answer in the round, the others get it for context and owe no answer.

- **The form: `@<id>`** in the text, the id as `list_groups` gives it. A mention is `@` at the start of
  the text or after a space, a bracket or a comma, followed by an id — so `eva@example.com` is a mail
  address, not a mention. Whether `@<name>` is read too is [open question 4](#open-questions-070); the
  spec assumes not.
- **One parser, every path.** `src/mentions.ts`, pure: `mentionsIn(text, members) → ids`, shared by the
  server and the page (`web/src` imports from `src/` as it imports `groupTabId`). It runs where a group
  message is taken in: `POST /api/groups/<id>/messages`, `send_message` and `forward` with `group`,
  `reply` to a group, the inbox with `group`, and the answer flotti posts at the end of a turn.
- **A mention of a non-member is refused** with one sentence, whether the id is an agent of another
  group or nobody at all — an agent in a group learns nothing of the fleet outside it, as in 0.6.0:
  the tool answers `there is no "x" among the members of group "release"; list_groups names them`, the
  person gets `400` with `"x" is not a member of group "release"`, the inbox a line in the tab of the
  sender. A message with a refused mention is not posted at all.
- **What the history keeps:** `mentions: [ids]` on the line of the group, in the order they appear in
  the text; absent when there is none. The `group-message` of the socket carries it.
- **What a member gets.** Over the inbox, `mentions` beside `from` and `group` in the metadata —
  `{"from": "eva", "group": "release", "mentions": ["codex"]}` — the same array for every member; the
  mentioned one finds itself in it. In the text, for a local agent over ACP and a remote one without the
  inbox: `[from eva in group release, to you] …` for a mentioned member, `[from eva in group release,
  to codex] …` for the others, `[in group release, to you] …` when the person wrote. The `message`
  event of the tab carries `mentions` too.
- **Who answers.** `AgentAnswers.wantsAnswer` (`src/agent-answers.ts`) asks for an answer from a
  mentioned member, and from every member when there is no mention — as today. A member not
  mentioned takes the message as a turn — its model has to read it to have it in context — and what
  it says in that turn is not posted to the group; by #172 it is not shown in its tab either, and rests in
  its history. That is the cost of variant (a), N−1 turns for the message as before, and it is the
  owner's choice: the message is for the group, the question is for one.
- **The answer is a group message like any other:** a mentioned member's answer quotes the message
  (`replyTo`) and mentions nobody by itself; a member that wants a particular agent to answer next
  writes `@id` on purpose. So a round is still one round: an answer flotti posts earns no answer.
- **The composer** of a group tab: `@` offers the members — mark, name, id — with the arrows and
  Enter, and inserts `@<id> `; Escape closes the list. The picker is a pure list over the members and
  the text before the caret (`web/src/mentions...`, tested), the field stays the `Composer` of today.
  An agent posts with `@<id>` in the text of `send_message`; nothing is added to the tool schema.
- **The row** of the lane shows a mention as a chip with the mark and the name of the agent in place
  of `@id`; a click opens the tab of that agent. A mentioned member that is not in the fleet any more is
  shown by id, as in the members line.

Rejected: *variant (b), delivery to the mentioned only* — decided against by the owner: the others
would read the exchange only in the history of the group and lose the context of the round;
*`mentions` given by the sender in the metadata or a tool argument* — two ways to say one thing, and
the text is what every path has; *an automatic mention of the sender on the answer* — every answer
would then ask the sender for another round; *a mention resolved by the display name in the text* — see
open question 4; *`@all` / `@here`* — a message without a mention already reaches everyone; it is the
default, not a word.

### A group is managed from its tab (#175)

The owner decided: **Settings → Groups goes away**; a group is made in the Groups section and changed
in its own tab.

- **Edit** in the header of the group tab opens the form **in place**, over the lane: the same
  `GroupForm` (`web/src/components/GroupForm.tsx`, the draft of `web/src/group-draft.ts`) with the id
  read-only, the name, the topic, the members as ticks, ids not in the fleet as *not in the fleet* and
  the line for ids typed by hand; **Save** puts `PUT /api/groups/<id>` and the lane comes back with the
  header changed; **Cancel** drops the draft. The check is the server's, `parseGroup`, with its
  sentences, as today.
- **Delete** stands in the editor, with a confirmation naming the group; `DELETE /api/groups/<id>`
  moves the directory to `.trash/` as today, and the page goes to the next tab of the Groups section —
  or to its empty state with the «Everyone» offer when none is left.
- **Add group** is a tab at the end of the Groups section, as **Add agent** is in Agents: it opens the
  same form for a new group (the id picked once) as a panel, and a saved group opens its tab. The
  «Everyone» offer of an empty section stays and stays one click.
- **Settings** loses the Groups list, `GroupSettings.tsx`, `GroupEditor`, `atGroup` and
  `editGroupOf` (`web/src/App.tsx`), and the sentence in the empty state of the Groups section that
  points to Settings (`sidebar.noGroupsWhy`). The API of groups does not change.
- **The agents** see the change on their next `list_agents`, and a remote one gets the roster again, as
  in 0.6.0.

Rejected: *a separate page for a group* — the tab is the place of the group, the form is small, and the
agent form of Settings stays where it is because agents have a settings page for other reasons
(harness, memory, admin); *Settings → Groups kept as a read-only list* — a list of what the rail
already lists; *Add group in the header, next to Add agent* — a group is born in its section, the owner
said, and the header is full on a phone (#102).

### What stays in 0.7.0

The model of a group, its files and API; the peers, `list_agents`, `list_groups`, the roster and its
`groups`; `canReach` at the doors for what still goes between agents; the message to a group, its
history with the deliveries, the one round of answers; the tab of a group as #152 built it, plus the
mentions and the editor; the broadcast; the migration of 0.6.0 (no group made on upgrade, the
«Everyone» offer); administrators bound by groups (open question 4 of 0.6.0).

### Compatibility (0.7.0)

- **Adapters of remote agents** ([a2a-inbox.md](a2a-inbox.md), [a2a-fleet.md](a2a-fleet.md)) — a
  message with `to` between agents is refused with a line in the tab of the sender; an adapter that
  posts with `group` needs nothing. `mentions` is one optional field more on the way in, ignored by an
  adapter written before; on the way out a mention is `@<id>` in the text, nothing to learn. The roster
  is unchanged; `id` is what a mention names. The two documents are updated in this PR for the parts
  decided here; the task ([open question 1](#open-questions-070)) after the answer.
- **Local agents** — `send_message` and `forward` lose `to`; `reply` is unchanged; the sentence of the
  refusal teaches an agent with old instructions the new way.
- **Events, socket, files** gain optional fields only: `mentions` on the line of a group and on a
  `message` event, `group` on the events of a group turn. A page of 0.6.x shows the group turns in the
  tab of the agent, as it does now, and knows nothing of mentions: it loses nothing.
- **A fleet of 0.6.x** needs nothing. Its pair conversations were derived, not stored.

### Open questions (0.7.0)

Decisions the owner takes. Each has a recommendation, which is what the spec assumes above; a different
answer changes the sub-issue it names.

1. **What becomes of a task between agents — `delegate`, `cancel_delegation`, `task` and `cancel` of
   the inbox?** A task is a direct exchange, and #171 removes those. Three ways: **(a)** a task to one
   member *inside a group* — `delegate` takes `group` and `to`, the inbox `task` goes with `group` and
   `to`; the task is posted to the group as a message from the giver addressed to the doer (a mention),
   with the task mark and the deadline, the doer's turn is the task as today, and the outcome is posted
   to the group as a message from the doer with `task.state`; the group tab shows the task card the
   agent tab shows now; `canReach` is asked of the doer as a member of that group. **(b)** remove the
   task for 0.7.0 — a task is `@doer do this` and the answer of the round is the result; deadline and
   taking back come later, if missed. **(c)** keep the task direct, in the tabs of the two — against #171.
   *Recommended: (a).* A task is the one thing agents do together that has a state and a deadline,
   and the group is where the person reads it; (b) is the lean fallback if 0.7.0 must be small. Changes
   sub-issue #171 (the largest part of it) and the two adapter documents.
2. **The rows of 0.6.x between two agents in the tabs — a message with `from` or `to` an agent and no
   `group`, and the tasks of a pair — stay in sight, or are hidden like group traffic?** *Recommended:
   they stay.* They are history, they age out with the limit of the history, and the filter of #172 stays
   one rule about `group`; hiding them would hide the tasks too, until open question 1 is built. Changes
   sub-issue #172.
3. **The rail once Conversations and the feed are gone: three sections with Fleet holding «All
   agents» alone, two sections — Agents with «All agents» first, and Groups — or no broadcast at
   all?** *Recommended: two sections, and the broadcast stays.* A section of one tab is a heading for
   nothing; the broadcast is still the one way to reach every agent at once, since no group holds every
   agent and the person is in none. The pick of a section survives a reload (#136) and `fleet` and
   `conversations` become unknown values, which fall back to the first section. Changes sub-issue #173
   (and the e2e of #136 that counts four tabs).
4. **A mention by id only, or by name too?** *Recommended: `@<id>` in the text; the picker offers the
   names and inserts the id; the row shows the name.* Names have spaces and change, ids do neither; a
   parser of names would guess where a mention ends. Changes sub-issue #174.
5. **Does an agent need a list of where it was mentioned — an inbox of mentions in its details or its
   tab?** *Recommended: no in 0.7.0.* The group tab shows the chip and the history keeps `mentions`, so
   the list can be built later without a migration. Changes sub-issue #174.
6. **In the tab of an agent, does the whole group turn go — thoughts, tool calls, the turn end — or the
   messages only, with the work kept?** *Recommended: the whole turn, permission requests excepted.*
   Isolation is the point: a tab that shows tool calls without the message that caused them is a
   puzzle. The status badge still says `working`; a «show group turns» switch on the tab is a follow-up
   if the work is missed. Changes sub-issue #172.

### Sub-issues (0.7.0)

The five issues of the milestone are the sub-issues; no new one is made here. The order and the arrows;
`∥` may run at the same time. Every issue updates the README («The dashboard», «Groups», «The fleet
tools») and the CHANGELOG for what it brings.

1. **#173 No feed of the fleet, and the shape of the rail.** Nothing depends on it and it touches the
   rail first: remove the feed (module, panel, story, tests, i18n, README), settle the sections per open
   question 3 (`SECTIONS`, `sectionOf`, the markers, `useSidebarSection` on an unknown saved value),
   keep the broadcast. *Acceptance:* e2e — the rail has no «All messages»; the unit tests of
   `fleet-feed` are gone with the module; the tests of the sections pass on the new set.
2. **#175 A group is managed from its tab.** ∥ 1 (both touch `Sidebar.tsx`: Add group is a tab of the
   Groups section; whichever lands second rebases). The inline editor from `GroupForm`, Delete with the
   confirmation, Add group in the section, Settings → Groups removed. *Acceptance:* e2e — from the tab
   of a group: rename, change members, delete, and the file follows; Add group in the section makes a
   group and opens its tab; Settings has no Groups; unit for the draft shared with the form.
3. **#171 Agents talk only inside groups.** → 1 (the rail without Conversations lands on the new
   sections); the server part ∥ 1 and 2. `to` refused for a message on the three doors with the
   sentences above, `send_message`/`forward` without `to`, `reply` to the group only, the task per open
   question 1, Conversations removed from the page. The e2e of #144 («inside its group an agent writes
   to a member and to the group») is rewritten: an agent writes to the group and mentions the member.
   *Acceptance:* unit — an agent cannot reach another with `to` on the tools, the inbox and (if kept) a
   message; through a group it can; `list_agents` and the roster unchanged; e2e — no Conversations,
   two agents in a group talk in the tab of the group only.
4. **#172 Isolation by chat.** ∥ 3 (it is a rule about `group`, and 0.6.0 already puts it on the
   message; the mark on the whole turn is new). The supervisor marks the turn, the reducer filters,
   the unread mark follows what is shown, permission requests stay. *Acceptance:* unit — a group message
   and the member's answer produce no rows in the member's tab, a permission request of that turn does,
   a direct message produces no row in any group; e2e — after a group message and a direct message the
   agent tab has one message and the group tab has one.
5. **#174 Mentions.** → 3 (the tool surface and the refusal sentences) and → 4 (without it the turn of a
   member that owes no answer would show in its tab). The parser ∥ everything: `src/mentions.ts` and
   its tests can start on day one. *Acceptance:* unit — the parser (ids, the mail address, the
   non-member), `mentions` on the history line and in the metadata, the answering rule; e2e — a group
   message with `@codex`: codex answers, the others do not; the `@` picker of the composer; the chip in
   the row. a2a-inbox.md is finished for `mentions`.

If the owner prefers smaller PRs, #171 splits along the line above — the server (the doors, the tools,
the task) and the page (Conversations) — and the page part could go into #173, which already reshapes
the rail; this spec makes no sixth issue for it.
