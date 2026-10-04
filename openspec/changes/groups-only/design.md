## Context

0.6.0 (`openspec/specs/groups`, `docs/groups.md`) put the check of who may write to whom at three
doors — `sendRefusal` in `src/fleet-mcp.ts` (the tools `send_message`, `reply`, `forward`),
`Supervisor.forward` in `src/supervisor.ts` (`to` of the inbox and what the supervisor sends on) and
`Delegations.delegate` in `src/delegations.ts` (tasks, both tools and inbox) — with one function,
`canReach(from, to)` of `src/groups.ts`. A group message reaches a member as a `message` event of its
tab with `group` beside `from`; the supervisor knows which turn a group message started (`followTurn`
and `AgentAnswers.asked`, `src/agent-answers.ts`) and posts the member's answer to the group. The page
gathers the conversation of a pair from the tabs of the two agents (`web/src/conversations.ts`), shows
every message in the feed (`web/src/fleet-feed.ts`) and manages groups in Settings
(`web/src/components/GroupSettings.tsx`, `GroupForm.tsx`, the draft of `web/src/group-draft.ts`).

## Goals / Non-Goals

**Goals:**
- An agent-to-agent message goes through a group, or is refused with a sentence that teaches the new way.
- Every message is read in one place: the group tab for group traffic, the agent tab for the person and
  the agent.
- A mention addresses one member of a group without narrowing delivery.
- A group is made and changed where it is read: the Groups section and its tab.

**Non-Goals:**
- Rewriting histories: hidden lines stay lines; old rows of 0.6.x are not rewritten.
- A new transport or protocol method; the events, the socket and the files gain optional fields only.
- Agents changing membership themselves (open question 1 of 0.6.0 stays «no»).
- An inbox of mentions per agent (open question 5, recommended no).

## Decisions

### 1. The doors stay; one rule goes in front of `canReach` (#171)

The check of 0.6.0 stays where it is — `sendRefusal`, `Supervisor.forward`, `Delegations.delegate` — and
gets one rule more in front of it: a *message* with `to` between agents is refused before `canReach` is
asked. `canReach` itself is still needed: for the task (open question 1), for the administrators
(`restart_agent`, `clear_context`, `kind: admin`) and for the answer flotti sends back at the end of a
turn, which goes back even after a membership edit, as in 0.6.0. `mayPost` is the check of every message
from now on. `send_message` and `forward` lose `to` in their schema; a call with `to` answers
`"to" is gone: a message to another agent goes through a group — name the group in "group" and the
agent with @<id> in the text`. `reply` answers in the group the last message came from; when none came
through a group yet it says so and names `send_message` with `group`. On the inbox, `to` with
`kind: message` gets the line `could not deliver the message to "x": a message to another agent goes
through a group; name it in "group"` in the sender's tab, and the agent is not told — the inbox has no
answer to give it. `sendBack` with `to` (`src/supervisor.ts`) is left for the task only, or removed
with it.

The Conversations section and the pair tabs (`_pair:<a>:<b>`, `web/src/conversations.ts`,
`ConversationPanel`, `conversationsId`, the section `conversations` of `web/src/sidebar-sections.ts`,
their tests, story and the i18n keys) go. The pairs of 0.6.x were never a store of their own — a lane
was gathered from the tabs of the two agents — so nothing is migrated and nothing is lost.

Rejected: *`to` kept as a shorthand for «a message to the group, addressed to this one»* — the
message would land in a group the sender did not name, and an agent in two groups with the receiver
would not know which; *a pair conversation kept as a group of two made by flotti* — a group is the
person's decision, and a group the person did not make is what open question 2 of 0.6.0 refused;
*`to` accepted and rewritten into a mention by flotti* — same as the first: which group.

### 2. The supervisor marks the turn, the page filters (#172)

The supervisor already knows which turn a group message started; in `keep`, before `store`, it puts
`group` on every event of that turn, not on the first message only. The history file keeps every event —
**the file is the record of what the agent was told and did, and a hidden line is still a line** — and
a page written before 0.7.0 shows them as it does now. The page drops the events that carry `group` on
the way into the tab, in the reducer of `web/src/feed.ts`, one pure rule with a unit test: a group
message and the turn it started produce no items; a permission request of that turn does. The unread
mark of an agent's tab (`hasUnread`, `web/src/sidebar-sections.ts`) follows the last event *shown*, not
the last event kept, or a group turn would light a tab that has nothing new in it. The status badge
still says `working` during a group turn: a status is not traffic.

One exception, decided here: **a permission request raised in a group turn stays in the tab of the
agent**, marked with the group — it waits for the person, and the person answers it where every
permission is answered; the `waiting` mark of the sidebar follows it as today. The same for a request
of an administrator that waits for the person.

Old rows: a group message of 0.6.x in the tab of a member carries `group` on the message and nothing
on the answer that followed — the message is hidden, the answer stays as a row until it ages out.
Rewriting histories is not done.

Rejected: *not writing group traffic to the history of the agent at all* — the file would no longer say
what the agent was told, a reloaded page and a page of 0.6.x would disagree with the live one, and
`AgentAnswers` and the delegations follow live events, not the file, so nothing is saved by it;
*filtering on the server, in `history()` and the `event` notice* — the page then cannot show the traffic
on purpose later (a «show group turns» switch is a page decision), and two pages of different versions
would read different histories of the same agent; *hiding the answer only and keeping the tool calls* —
open question 6; *hiding permission requests with the turn* — an agent waiting for the person in a turn
nobody can see is a hang.

### 3. The feed goes, the field stays (#173)

`web/src/fleet-feed.ts`, `FleetFeedPanel.tsx`, its story and test, the filter by agent, the jump from a
row to the tab it lives in (`feedOpen` in `web/src/App.tsx`), the `_feed` id, `feedId` in
`sidebar-sections.ts` and `Sidebar.tsx`, the i18n keys `sidebar.allMessages*` and `fleetFeed.*`, the e2e
of #114 and the README paragraph go. The `group` and `answer` tags of a feed row go with it; the lane
of a group keeps its own «answer» mark. Nothing else read the feed: the socket, the histories and
`group` on a `message` event stay — #172 needs the field. `found` and the quote jumps inside a lane stay.

The Fleet section is left with «All agents» alone; the recommendation (open question 3) is a rail of
**two sections, Agents and Groups**, with «All agents» the first tab of Agents. `SECTIONS`, `sectionOf`,
the markers and `useSidebarSection` on an unknown saved value (`fleet`, `conversations` → the first
section) are the touch points.

Rejected: *one feed per group instead* — the tab of the group is that already; *the feed kept for
messages between a person and an agent only* — that is the tab of the agent, N times.

### 4. One parser, every path (#174)

`src/mentions.ts`, pure: `mentionsIn(text, members) → ids`, shared by the server and the page
(`web/src` imports from `src/` as it imports `groupTabId`). A mention is `@` at the start of the text
or after a space, a bracket or a comma, followed by an id as `list_groups` gives it — so
`eva@example.com` is a mail address, not a mention. It runs where a group message is taken in:
`POST /api/groups/<id>/messages`, `send_message` and `forward` with `group`, `reply` to a group, the
inbox with `group`, and the answer flotti posts at the end of a turn. A mention of a non-member is
refused with one sentence, whether the id is an agent of another group or nobody at all — the tool
answers `there is no "x" among the members of group "release"; list_groups names them`, the person gets
`400` with `"x" is not a member of group "release"`, the inbox a line in the tab of the sender — and
the message is not posted at all.

`mentions: [ids]` goes on the line of the group history in the order they appear in the text, absent
when there is none; the `group-message` of the socket and the `message` event of the tab carry it; the
inbox metadata carries it beside `from` and `group`, the same array for every member. In the text:
`[from eva in group release, to you] …` for a mentioned member, `[from eva in group release, to codex] …`
for the others, `[in group release, to you] …` when the person wrote.

`AgentAnswers.wantsAnswer` (`src/agent-answers.ts`) asks for an answer from a mentioned member, and
from every member when there is no mention. A member not mentioned takes the message as a turn — its
model has to read it to have it in context — and what it says in that turn is not posted to the group;
by #172 it is not shown in its tab either, and rests in its history. That is the cost of variant (a),
N−1 turns for the message as before, and it is the owner's choice. A mentioned member's answer quotes
the message (`replyTo`) and mentions nobody by itself, so a round is still one round.

The composer of a group tab: `@` offers the members — mark, name, id — with the arrows and Enter, and
inserts `@<id> `; Escape closes the list. The picker is a pure list over the members and the text
before the caret (`web/src/mentions…`, tested); the field stays the `Composer` of today. The row shows
a mention as a chip with the mark and the name in place of `@id`; a click opens the tab of that agent;
a mentioned member not in the fleet any more is shown by id.

Rejected: *variant (b), delivery to the mentioned only* — decided against by the owner; *`mentions`
given by the sender in the metadata or a tool argument* — two ways to say one thing, and the text is
what every path has; *an automatic mention of the sender on the answer* — every answer would ask the
sender for another round; *a mention resolved by the display name* — open question 4; *`@all` /
`@here`* — a message without a mention already reaches everyone.

### 5. The group is managed where it is read (#175)

**Edit** in the header of the group tab opens the form in place, over the lane: the same `GroupForm`
(`web/src/components/GroupForm.tsx`, the draft of `web/src/group-draft.ts`) with the id read-only, the
name, the topic, the members as ticks, ids not in the fleet as *not in the fleet* and the line for ids
typed by hand; **Save** puts `PUT /api/groups/<id>` and the lane comes back with the header changed;
**Cancel** drops the draft. The check is the server's, `parseGroup`, with its sentences. **Delete**
stands in the editor with a confirmation naming the group; `DELETE /api/groups/<id>` moves the
directory to `.trash/`, and the page goes to the next tab of the Groups section — or to its empty state
with the «Everyone» offer. **Add group** is a tab at the end of the Groups section, as Add agent is in
Agents: the same form for a new group (the id picked once) as a panel; a saved group opens its tab.
Settings loses the Groups list, `GroupSettings.tsx`, `GroupEditor`, `atGroup` and `editGroupOf`
(`web/src/App.tsx`) and the sentence `sidebar.noGroupsWhy`. The API of groups does not change; the
agents see the change on their next `list_agents`, and a remote one gets the roster again.

Rejected: *a separate page for a group* — the tab is the place of the group, the form is small, and the
agent form of Settings stays because agents have a settings page for other reasons (harness, memory,
admin); *Settings → Groups kept as a read-only list* — a list of what the rail already lists; *Add
group in the header, next to Add agent* — a group is born in its section, the owner said, and the
header is full on a phone (#102).

## Risks / Trade-offs

- **Adapters and instructions written for 0.6.x** post `to` between agents; the refusal sentence
  names the new way on every path, and the roster does not change, so the fix is one field.
- **Variant (a) of mentions** costs N−1 turns per message, as before: the person controls it through
  the size of the group.
- **Two PRs touch `Sidebar.tsx`** (#173 and #175); whichever lands second rebases.
- **The task** (open question 1) is the largest unknown of #171; the deltas assume (a), and (b) is
  the smaller change if 0.7.0 must be small.

## Order of the sub-issues

1. **#173** (feed + the shape of the rail) → 2. **#175** ∥ 1 (both touch `Sidebar.tsx`) →
3. **#171** (server part ∥ 1–2; the page part after 1) → 4. **#172** ∥ 3 → 5. **#174** → 3, 4 (the parser
can start on day one). The five issues of the milestone are the sub-issues; no new one is made. If
smaller PRs are wanted, #171 splits into the server (doors, tools, the task) and the page
(Conversations), and the page part fits #173, which already reshapes the rail.
