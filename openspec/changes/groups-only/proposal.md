## Why

0.6.0 made groups the boundary of what an agent sees, and left three fleet-wide views beside them: the
conversations of pairs, the feed of every message, and the tab of an agent that shows the group traffic
too. The first day with it (30.09.2026) showed the person reading the same exchange in three places and
the agents keeping a private channel next to every group. The owner asked for 0.7.0 as five changes
with one spec — #171 (agents talk only inside groups), #172 (isolation by chat), #173 (no feed of the
fleet), #174 (mentions), #175 (a group is managed from its own tab). 0.7.0 closes the gap: **an agent
says something to another agent in a group, or not at all**, and **every message is read in one
place** — the tab of the group for what was said in a group, the tab of the agent for what the person
and the agent say to each other.

Two decisions the owner already took in the issues and that are not open here: a mention **addresses**
and does not narrow delivery (#174, variant a — comment in #174), and **Settings → Groups goes away**
(#175 — comment in #175). What was rejected on the way, and why, is in `design.md`.

## What Changes

- **#171 Agents talk only inside groups.** `send_message` and `forward` take `group` only; `to` leaves
  their schema, and a call that still names it is refused with a sentence that names `group` and
  `@<id>`. `reply` answers in the group the last message came from. `to` with `kind: message` of the
  inbox is refused with a line in the sender's tab. The three doors of 0.6.0 stay and get the rule in
  front of `canReach`; `list_agents`, `list_groups` and the roster do not change — what an agent *sees*
  does not change, only how it *writes*. The Conversations section and the pair tabs go; pairs were
  derived from the tabs, nothing is migrated. **BREAKING** for the tool schema of local agents and for
  adapters that post `to` between agents.
- **#172 Isolation by chat.** The agent tab shows what the person and the agent say to each other;
  the group tab what was said in the group. The supervisor marks every event of a turn a group message
  started with `group`, the history file keeps everything, the page filters in the reducer of
  `web/src/feed.ts`; the unread mark follows what is shown. Permission requests of a group turn stay in
  the agent tab — they wait for the person.
- **#173 No feed.** The «All messages» tab, `fleet-feed.ts`, `FleetFeedPanel`, the filter, the jump,
  the i18n keys and the e2e of #114 go; `group` on the `message` event stays (#172 needs it). The
  broadcast stays, the first tab of Agents (decision 3).
- **#174 Mentions — variant (a), as decided.** `@<id>` in the text, one pure parser
  (`src/mentions.ts`) on every path; a mention of a non-member is refused with one sentence and the
  message is not posted; `mentions: [ids]` on the history line, in the inbox metadata and on the
  `message` event; the text mark says `, to you` / `, to codex`; only the mentioned members' turn
  answers are posted, the others get the message for context. The composer's `@` picker over the
  members; a chip in the row.
- **#175 Managed from the tab — Settings → Groups goes, as decided.** Edit opens the `GroupForm` in
  place over the lane (id read-only), Delete with a confirmation in the editor, **Add group** as a tab
  at the end of the Groups section like Add agent; the API of groups does not change.
- **Adapters.** `docs/a2a-inbox.md`: `to` between agents refused from 0.7.0, `mentions` on the way in,
  the mark in the text; `docs/a2a-fleet.md`: `id` is what a mention names. The Tasks section of the
  inbox follows decision 1.

### What stays in 0.7.0

The model of a group, its files and API; the peers, `list_agents`, `list_groups`, the roster and its
`groups`; `canReach` at the doors for what still goes between agents; the message to a group, its
history with the deliveries, the one round of answers; the tab of a group as #152 built it, plus the
mentions and the editor; the broadcast; the migration of 0.6.0 (no group made on upgrade, the
«Everyone» offer); administrators bound by groups (open question 4 of 0.6.0).

## Capabilities

### New Capabilities

None: every part of 0.7.0 changes a rule that already exists.

### Modified Capabilities

- `groups`: the member's tab no longer shows group traffic (isolation), mentions in a group message,
  the tab of a group gets the editor, Settings → Groups is replaced by management in the Groups section
  and the tab.
- `direct-messages`: the direct message between agents and the conversation of the pair are removed;
  the task is reshaped to go inside a group (assumes open question 1 = (a)).
- `fleet-feed`: removed.
- `dashboard-rail`: two sections instead of four (assumes open question 3 = two sections), Add group
  as a tab of the Groups section, the unread mark follows what is shown.

## Decisions

Taken by the owner (Evgeny) on 30.09.2026, in Telegram (the button of message 7280): **every
recommendation is accepted**, so the deltas and the tasks stand as they were written. They were the open
questions of this proposal and keep their numbers, so «open question N» in the design, the deltas and
the tasks names the decision below.

1. **(a)** — a task goes to one member inside a group.
2. **They stay** — the rows of 0.6.x between two agents stay in sight.
3. **Two sections**, Agents with «All agents» the first tab and Groups; **the broadcast stays**.
4. **`@<id>` in the text**; the picker offers the names and inserts the id; the row shows the name.
5. **No** inbox of mentions in 0.7.0.
6. **The whole group turn goes** from the tab of the agent, permission requests excepted.

What each question weighed, as it was asked:

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
   task group 3 (#171, the largest part of it) and the two adapter documents.
2. **The rows of 0.6.x between two agents in the tabs — a message with `from` or `to` an agent and no
   `group`, and the tasks of a pair — stay in sight, or are hidden like group traffic?** *Recommended:
   they stay.* They are history, they age out with the limit of the history, and the filter of #172 stays
   one rule about `group`; hiding them would hide the tasks too, until open question 1 is built. Changes
   task group 4 (#172).
3. **The rail once Conversations and the feed are gone: three sections with Fleet holding «All
   agents» alone, two sections — Agents with «All agents» first, and Groups — or no broadcast at
   all?** *Recommended: two sections, and the broadcast stays.* A section of one tab is a heading for
   nothing; the broadcast is still the one way to reach every agent at once, since no group holds every
   agent and the person is in none. The pick of a section survives a reload (#136) and `fleet` and
   `conversations` become unknown values, which fall back to the first section. Changes task group 1
   (#173, and the e2e of #136 that counts four tabs).
4. **A mention by id only, or by name too?** *Recommended: `@<id>` in the text; the picker offers the
   names and inserts the id; the row shows the name.* Names have spaces and change, ids do neither; a
   parser of names would guess where a mention ends. Changes task group 5 (#174).
5. **Does an agent need a list of where it was mentioned — an inbox of mentions in its details or its
   tab?** *Recommended: no in 0.7.0.* The group tab shows the chip and the history keeps `mentions`, so
   the list can be built later without a migration. Changes task group 5 (#174).
6. **In the tab of an agent, does the whole group turn go — thoughts, tool calls, the turn end — or the
   messages only, with the work kept?** *Recommended: the whole turn, permission requests excepted.*
   Isolation is the point: a tab that shows tool calls without the message that caused them is a
   puzzle. The status badge still says `working`; a «show group turns» switch on the tab is a follow-up
   if the work is missed. Changes task group 4 (#172).

## Impact

- **Server:** `src/fleet-mcp.ts` (`send_message`, `forward`, `reply`, `sendRefusal`, `delegate`),
  `src/supervisor.ts` (`forward`, `sendBack`, `keep`/`followTurn` marking the group turn),
  `src/delegations.ts`, `src/agent-answers.ts` (`wantsAnswer`), new `src/mentions.ts`, the inbox
  handling of `to`/`group`/`mentions`, the history line of a group.
- **Page:** `web/src/feed.ts` (the filter), `web/src/sidebar-sections.ts` and `Sidebar.tsx` (sections,
  `hasUnread`, Add group), `web/src/App.tsx` (`feedOpen`, `atGroup`, `editGroupOf`), removal of
  `web/src/fleet-feed.ts`, `FleetFeedPanel.tsx`, `web/src/conversations.ts`, `ConversationPanel`,
  `GroupSettings.tsx`, `GroupEditor`; the group tab gets the inline editor, the `@` picker and the chip;
  i18n keys `sidebar.allMessages*`, `fleetFeed.*`, `sidebar.noGroupsWhy`.
- **Tests:** unit tests of the removed modules go with them; new unit tests for the parser, the
  reducer filter, the doors; the e2e of #114 goes, the e2e of #144 and #136 are rewritten.
- **Docs:** `docs/a2a-inbox.md`, `docs/a2a-fleet.md` (already updated for the decided parts), README
  («The dashboard», «Groups», «The fleet tools»), CHANGELOG — per task group.
- **Compatibility:** events, socket and files gain optional fields only (`mentions` on the line of a
  group and on a `message` event, `group` on the events of a group turn); a page of 0.6.x shows the
  group turns in the tab of the agent as it does now and knows nothing of mentions. A fleet of 0.6.x
  needs nothing: its pair conversations were derived, not stored. Adapters that post `to` between
  agents get a refusal line in the sender's tab; an adapter that posts with `group` needs nothing.
