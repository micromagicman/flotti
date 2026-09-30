# Groups: agents see and write to each other only inside a group

Spec of #144, the main feature of 0.6.0. Status: **built in 0.6.0** — the [sub-issues](#sub-issues)
#149–#154 are the code, as reviewed here; the [open questions](#open-questions) keep the decisions taken.
This document is the record of 0.6.0 as built and of the reasons — what was decided, what was rejected
and why. **The requirements themselves live in OpenSpec** ([`openspec/specs/groups/spec.md`](../openspec/specs/groups/spec.md),
with `direct-messages`, `fleet-feed` and `dashboard-rail` beside it): where this document and a spec
disagree, the spec is right. **0.7.0 changes it** — agents talk only inside groups, one message is read
in one place, mentions, a group managed from its tab: the spec of #171–#175 is the OpenSpec change
[`openspec/changes/groups-only/`](../openspec/changes/groups-only/) (its
[proposal](../openspec/changes/groups-only/proposal.md) with the open questions, its
[design](../openspec/changes/groups-only/design.md) with what was rejected, its
[tasks](../openspec/changes/groups-only/tasks.md) with the order of the sub-issues, and the spec deltas);
a line under each section below that 0.7.0 touches says what changes and points there.

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
  agent in its tab, and the broadcast stays — [0.7.0](../openspec/changes/groups-only/proposal.md).
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
one of them (#171, #174); what becomes of a task is [open question 1 of 0.7.0](../openspec/changes/groups-only/proposal.md#open-questions).

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
[open question 3 of 0.7.0](../openspec/changes/groups-only/proposal.md#open-questions). It lists the groups of the fleet with the marks of their
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
group is managed from its own tab). The spec is the OpenSpec change
[`openspec/changes/groups-only/`](../openspec/changes/groups-only/): the
[proposal](../openspec/changes/groups-only/proposal.md) (what changes per issue, the decisions the owner
took in #174 and #175, the six open questions with a recommendation each), the
[design](../openspec/changes/groups-only/design.md) (where each rule lands, what was rejected and why),
the [tasks](../openspec/changes/groups-only/tasks.md) (the five issues as sub-issues, in order, with
the dependencies) and the deltas to the specs of `groups`, `direct-messages`, `fleet-feed` and
`dashboard-rail`. When the change ships it is archived into `openspec/specs/`, and this document stays
the record of 0.6.0.
