## 1. #173 No feed of the fleet, and the shape of the rail

Nothing depends on it and it touches the rail first. Assumes open question 3 (two sections).

- [x] 1.1 Remove `web/src/fleet-feed.ts`, `FleetFeedPanel.tsx`, their story and unit test, the filter by agent, `feedOpen` in `web/src/App.tsx`, the `_feed` id and `feedId` in `sidebar-sections.ts` and `Sidebar.tsx`, the i18n keys `sidebar.allMessages*` and `fleetFeed.*`
- [x] 1.2 Settle the sections per open question 3: `SECTIONS`, `sectionOf`, the markers; `useSidebarSection` falls back to the first section on an unknown saved value (`fleet`, `conversations`); «All agents» stays as the first tab of Agents. *Done in #173 without Conversations' part:* the rail is Agents, Groups, Conversations until 3.6 removes Conversations, which is when `conversations` becomes an unknown value too
- [x] 1.3 Keep `group` on the `message` event and the `group-message` of the socket (#172 needs them); drop only the `group`/`answer` tags of feed rows
- [x] 1.4 Remove the e2e of #114; rewrite the e2e of #136 that counts four tabs; the tests of the sections pass on the new set
- [x] 1.5 README («The dashboard», the feed paragraph) and CHANGELOG

## 2. #175 A group is managed from its tab

May run with 1 (both touch `Sidebar.tsx`; whichever lands second rebases).

- [x] 2.1 Edit in the header of the group tab opens `GroupForm` in place over the lane, id read-only; Save → `PUT /api/groups/<id>`, Cancel drops the draft; the check is the server's `parseGroup`
- [x] 2.2 Delete in the editor with a confirmation naming the group → `DELETE /api/groups/<id>`; the page goes to the next tab of the Groups section or its empty state
- [x] 2.3 Add group as a tab at the end of the Groups section, opening the same form for a new group as a panel; a saved group opens its tab; the «Everyone» offer stays one click
- [x] 2.4 Remove Settings → Groups: `GroupSettings.tsx`, `GroupEditor`, `atGroup` and `editGroupOf` in `web/src/App.tsx`, the sentence `sidebar.noGroupsWhy`
- [x] 2.5 Unit tests for the draft shared with the form; e2e — from the tab of a group: rename, change members, delete, and `groups/<id>/group.json` follows; Add group in the section makes a group and opens its tab; Settings has no Groups
- [x] 2.6 README («Groups», «The dashboard», «Settings») and CHANGELOG

## 3. #171 Agents talk only inside groups

The server part may run with 1 and 2; the page part after 1 (the rail without Conversations lands on the new sections). Assumes open question 1 = (a).

- [x] 3.1 `send_message` and `forward` lose `to` in the tool schema; a call with `to` is refused with `"to" is gone: a message to another agent goes through a group — name the group in "group" and the agent with @<id> in the text`
- [x] 3.2 `reply` answers in the group the last message came from; when none came through a group yet it says so and names `send_message` with `group`
- [x] 3.3 The inbox: `to` with `kind: message` is refused with `could not deliver the message to "x": a message to another agent goes through a group; name it in "group"` in the sender's tab; the agent is not told
- [x] 3.4 The rule in front of `canReach` at the three doors (`sendRefusal`, `Supervisor.forward`, `Delegations.delegate`): a message with `to` between agents is refused before `canReach` is asked; `canReach` stays for the task, the administrators and the answer sent back at the end of a turn
- [x] 3.5 The task per open question 1: `delegate` takes `group` and `to`, the inbox `task` goes with `group` and `to`; the task is posted to the group as a message from the giver mentioning the doer, with the task mark and the deadline; the outcome is posted to the group with `task.state`; the group tab shows the task card; `sendBack` with `to` is kept for the task only
- [x] 3.6 Remove Conversations from the page: `web/src/conversations.ts`, `ConversationPanel`, `conversationsId`, the section `conversations` of `sidebar-sections.ts`, their tests, story and i18n keys
- [x] 3.7 Unit — an agent cannot reach another with `to` on the tools, the inbox and a message; through a group it can; `list_agents` and the roster unchanged; e2e — no Conversations, two agents in a group talk in the tab of the group only; the e2e of #144 rewritten: an agent writes to the group and mentions the member
- [x] 3.8 `docs/a2a-inbox.md` Tasks section finished per open question 1; README («The fleet tools», «Groups») and CHANGELOG

## 4. #172 Isolation by chat

May run with 3 (it is a rule about `group`, and 0.6.0 already puts it on the message; the mark on the whole turn is new). Assumes open questions 2 (old rows stay) and 6 (the whole turn goes).

- [x] 4.1 The supervisor puts `group` on every event of the turn a group message started (`keep`, before `store`, using `followTurn` / `AgentAnswers.asked`), not on the first message only; the history file keeps every event
- [x] 4.2 The reducer of `web/src/feed.ts` drops the events that carry `group` on the way into the agent tab; a permission request of that turn stays, marked with the group; one pure rule with a unit test
- [x] 4.3 `hasUnread` in `web/src/sidebar-sections.ts` follows the last event shown, not the last kept
- [x] 4.4 Unit — a group message and the member's answer produce no rows in the member's tab, a permission request of that turn does, a direct message of the person produces no row in any group; e2e — after a group message and a direct message the agent tab has one message and the group tab has one
- [x] 4.5 README («The dashboard», «Groups») and CHANGELOG

## 5. #174 Mentions

Depends on 3 (the tool surface and the refusal sentences) and 4 (without it the turn of a member that owes no answer would show in its tab). The parser may start on day one. Assumes open questions 4 (`@<id>` only) and 5 (no inbox of mentions).

- [x] 5.1 `src/mentions.ts`, pure: `mentionsIn(text, members) → ids` — `@` at the start or after a space, a bracket or a comma, followed by a member id; `eva@example.com` is not a mention; unit tests (ids, the mail address, the non-member)
- [x] 5.2 Run the parser where a group message is taken in: `POST /api/groups/<id>/messages`, `send_message` and `forward` with `group`, `reply` to a group, the inbox with `group`, the answer flotti posts at the end of a turn; a non-member is refused — tool: `there is no "x" among the members of group "release"; list_groups names them`, person: `400` with `"x" is not a member of group "release"`, inbox: a line in the sender's tab — and the message is not posted
- [x] 5.3 `mentions: [ids]` on the history line of the group (order of the text, absent when none), on the `group-message` of the socket, on the `message` event and in the inbox metadata beside `from` and `group`; the text mark `[from eva in group release, to you] …` / `, to codex] …` / `[in group release, to you] …`
- [x] 5.4 `AgentAnswers.wantsAnswer` asks for an answer from the mentioned members only, from every member when there is no mention; a not-mentioned member's turn answer is not posted; a mentioned member's answer quotes the message and mentions nobody by itself
- [x] 5.5 The composer of a group tab: `@` opens a pure picker over the members (mark, name, id) with the arrows and Enter, inserts `@<id> `, Escape closes; the row shows a mention as a chip with the mark and the name, a click opens the agent's tab, an id not in the fleet is shown as is
- [x] 5.6 Unit — `mentions` on the history line and in the metadata, the answering rule; e2e — a group message with `@codex`: codex answers, the others do not; the `@` picker; the chip in the row
- [x] 5.7 `docs/a2a-inbox.md` finished for `mentions`; README («Groups», «The fleet tools») and CHANGELOG
