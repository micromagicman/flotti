# Changelog

All notable changes to flotti are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Remote agents see the fleet.** An A2A agent that declares the new fleet extension gets the roster of
  the fleet — its own entry marked `you`, administrators `admin` — with the inbox request, and the whole
  roster again after a change, outside any conversation; see [docs/a2a-fleet.md](docs/a2a-fleet.md) (#94).
- **Agent memory.** Every local agent with an adapter gets a memory of its own with nothing to install:
  the tools `memory_search`, `memory_read`, `memory_write` and `memory_delete` of the fleet MCP server,
  a short policy after its system prompt, the built-in skill `flotti-memory`, and an index of its
  `memory/` at the start of the first message of every session. A write is confirmed only once the note
  is on disk, and a stale revision is a conflict, not an overwrite. The details of the agent («i») say
  whether it has memory — on, unsupported or unavailable — as flotti delivered it (#101).

### Changed

- **A calm, almost monochrome palette.** The dashboard is grey and ink, with colour kept for a few small
  marks that mean something: the primary button in a muted steel, the dot of a state (sage for work,
  ochre for waiting on you, brick for an error) while the chip and its word stay grey, and a muted hue
  on the mark of each agent, whose shape tells the agent too. Envelopes have a hairline border and a
  grey bar with a faint tone of the sender; the line of messages waiting is grey and dashed. The logo
  and the icon are ink. Both themes, text contrast AA (#96).
- **The header of an agent tab is one line.** It keeps the name, the state, Chat and Memory, the actions
  and an «i» button. The description, the type, the harness, the role and the SSH diagnostics moved to
  a details panel on the right of the chat, opened by «i» (over the chat on a phone). Trouble with the
  connection shows as a strip under the header, with a way to the details. On a phone the actions are
  in a «⋯» menu (#102).

### Fixed

- **`reply` and `forward` see every message from another agent.** A message of a remote A2A agent and
  an answer sent back at the end of a turn now count as the last message too: `reply` goes to their
  sender and quotes them, instead of saying no agent has written or answering an older sender (#98).
- **A tunnel that is down counts as trouble.** A remote agent whose connection dropped and has not come
  back was shown as fine; now it says «No connection», under the header, on its tab in the sidebar and
  in `flotti status` (#102).
- **The composer and the messages in line span the chat on a wide window.** The card of the message
  field and the Next up block no longer stop in a 900 px column: they run the width of the feed, and a
  message in line stands at its right edge, where the messages of the person do. A narrow screen and
  the broadcast look as before (#95).
- **The Administrators setting shows no box until it is read.** While the dashboard was still asking
  the server, the box stood empty, as if the setting were off, and a click on it did nothing (#91).

## [0.3.0]

A fleet that works as a team: agents give one another tasks and answer back, their conversations
in one lane, administrators of the fleet, notifications in Telegram and Web Push, the memory bank of
an agent in the dashboard, a new look for its controls, and the dashboard in English or Russian.

### Added

- **The dashboard in English or Russian.** **Language** in the settings switches every word of the page
  at once, with no reload, and the choice stays in the browser; until one is picked, the dashboard opens
  in the language of the browser when it speaks it, else in English. Numbers, counts and dates follow the
  language. Messages of agents and people are shown as they were written, and what the server says —
  an error it gives, a reason of an agent — stays in English for now. A new language is a file of
  strings in `web/src/i18n` and a line in `languages.ts`; a lint rule catches words written into a
  component past them (#86).
- **The memory bank of an agent in the dashboard.** The header of a local agent's tab switches between
  Chat and Memory: the folders and notes of its `memory/` on the left, a note on the right as rendered
  markdown, with `[[links]]` that open the notes they name and the notes that link back. Read-only:
  nothing is written there, and only `.md` files inside the bank are read (#73).
- **Logo and icon.** Three sails in a wedge over the waterline, the lead one blue, next to the word
  flotti: in the header of the dashboard, as the favicon (it follows the light or dark theme of the
  browser), on notifications and at the top of the README. The files are in `assets/logo` (#83).
- **Notifications outside the browser: Telegram and Web Push.** On the settings page, a bot of your own
  (its token and a chat id) and Web Push through the service worker of the dashboard tell you when an
  agent waits for an answer or a permission, fails, or loses its SSH connection — each switched on on
  its own, one notification per wait, reminders by setting. The answer takes the notification of a
  wait back. Secrets stay in `~/.flotti/settings.json`, readable by its owner only: never shown to the
  page, never logged. Nothing set up, nothing sent (#81).
- **Messages in line show in the chat.** A message sent to a busy agent shows at once at the end of its
  tab, in a "NEXT UP" block under a dashed amber line, with its place in line and **✕ cancel** to take
  it back; the sidebar says "working · 2 in line". Once the agent takes it, it joins the feed where its
  turn starts. A broadcast to busy agents shows in the tab of each. A message the line lost — Stop or
  Restart of the agent, or a restart of flotti — says "Not delivered" and why, with **Send again**
  (#75).
- **Tasks agents give one another.** An agent gives another a task — the `delegate` tool for a local
  agent, `to` with `task` in the inbox for an A2A one — and gets its outcome back by itself: `completed`
  with what the other agent answered in its turn, `failed` or `canceled` with why. A task to an agent
  that is not there or is stopped fails at once; the giver can take a task back (`cancel_delegation`, or
  `cancel` in the inbox), and a task not done by its optional deadline fails. Both tabs show the task as a
  card: who gave it to whom, where it stands and how it ended (#80).
- **Administrators of the fleet.** An agent with `admin` in its manifest, or **Administrator** ticked in
  the settings, may restart the agents of the fleet and clear their context — itself included — with
  the tools `restart_agent` and `clear_context`, or a remote one through the inbox (`kind: admin`).
  Anyone else is refused, and only a person gives or takes the role. Each action is a line in the tab
  of the administrator and in the tab of the agent; a cleared context is a divider there, and the
  history stays. **Ask me before an administrator…** in the settings makes every action wait for
  **Allow**; a refusal reaches the administrator as one. `list_agents` marks administrators (#84).
- **Conversations of agents.** Every two agents that wrote to each other get a tab under
  "Conversations": one read-only lane of all they sent each other, in order, with quotes and forwards,
  and **Write to …** for either agent. The sidebar names the four newest pairs; the rest, and all of
  them on a narrow screen, are in **All conversations**. The colour of an agent now also marks its tab
  in the sidebar and the header of its chat (#79).
- **Links in the chat are clickable.** An `http(s)://` address in a message — of a person or of an
  agent, in the quote of a reply and in a forwarded message — is a link in the accent colour that opens
  in a new tab; punctuation after it stays out, and markdown links `[text](url)` show their text. Links
  are built from the text, never from HTML, so markup in a message is shown, not run (#76).
- **The harness of a remote agent.** A remote agent names the program that runs it with `harness` in
  its published file (`~/.flotti/a2a/<id>.json`) or with the harness extension of its card; the
  header of its tab, `flotti status` and `list_agents` show it instead of `harness unknown`. A name
  flotti does not know is shown as it is (#78).
- **An answer to another agent reaches it.** When an agent answers, in its turn, a message another agent
  of the fleet sent it, flotti sends the answer back to the sender as well — "B → A" in the colour of B,
  quoting the message answered; an A2A agent gets it with `from`, an ACP one as `[from B]`. Only the
  answer goes, not the progress of the turn, and an answer gets no answer back by itself (#74).
- **The health of an SSH connection.** For a remote agent reached over SSH, the header of its tab and
  its row in Settings show the latency of the tunnel, the reconnects since the start and in the last
  hour with the time of the last one, the last activity of the agent and the uptime of the tunnel, kept
  up to date without a reload. A poor connection — 3 or more reconnects in an hour, or a latency of
  1 s or more — turns red, says why and marks the tab. `flotti status` shows the latency and the
  reconnects too. No secret goes into the health (#82).

### Changed

- **A new message field in the chat.** The field is a card in the soft capsules: the reply it answers
  at the top, the text growing with what you write up to ten lines and scrolling after, and a bar at the
  foot with the status of the agent and its line ("working · 2 in line"), the keys (Enter to send,
  Shift+Enter for a new line) and **Send** with an arrow. In a broadcast the bar counts the agents it
  goes to ("2 agents selected"), and its button is **Send** as well. Both themes, and narrow screens,
  where the keys take a line of their own (#77).
- **One look for the controls of the dashboard.** Buttons, fields, checkboxes, status badges, tabs and
  cards follow one system of soft capsules, its colours, sizes and corners kept as tokens in one place:
  tinted buttons with the main one in blue, filled fields with a visible edge, a focus ring on every
  control, a spinner while a button waits. The main button in the dark theme, the amber "waiting for
  you" and the edges of fields now pass WCAG AA contrast (#87).

### Fixed

- **`npx` and `codex` start on Windows.** A local agent whose `command` is an npm script — `npx`,
  `codex`, anything installed as a `.cmd` — is found through `PATH` and `PATHEXT` the way the shell
  finds it and started through `cmd.exe`, its arguments quoted so that spaces, quotes and `&`, `%`,
  `^`, `|` reach the agent unchanged; an `.exe` starts directly, as before. Stop and restart end
  `cmd.exe` with the whole tree under it, and a command found nowhere still says `command not found`.
  The unit tests run on Windows in CI too (#85).

## [0.2.0]

A fleet that lives on: agents that talk to each other and speak first, remote hosts over SSH, a chat
history that survives restarts, and a global install with `flotti start`.

### Added

- **Reply and forward in the chat of an agent.** Any message of a tab can be answered with a reply —
  the agent gets the quoted message above the answer, and the tab shows the quote as a link back to it
  — or forwarded to another agent of the fleet, whose tab shows it under a bar "FORWARDED · AUTHOR" in
  the author's colour. The `reply` and `forward` tools of the agents send the same `replyTo` and
  `forwarded` as the dashboard does (#30).
- **`flotti start` and `flotti status`.** After `npm install -g flotti` the fleet runs with
  `flotti start`: in the background, giving the terminal back with the address of the dashboard; a
  second `start` of a running fleet says it runs. `flotti stop` stops it, `flotti status` lists the
  agents of the running fleet — id, local or remote, harness, status. `flotti run` stays for the
  foreground (#36).
- **Bare agents talk to each other.** Every agent flotti starts gets the fleet as MCP tools in its
  session — `list_agents`, `send_message`, `reply`, `forward` — with nothing to configure in Claude Code
  or Codex. A message from an agent carries `from`, the id of the sender (#38).
- **An agent on another host, started by flotti.** `"ssh": "user@host"` in a local manifest starts the
  agent there over SSH and runs it like a local one; ACP goes through the SSH connection, the fleet
  tools through a reverse tunnel (#38).
- **The history of a tab survives a restart.** Every event of an agent — messages, tool calls,
  permission requests, status lines — is written to `.flotti-history.jsonl` in its directory and read
  back when flotti starts; the last 5000 events of each agent are kept (#28).
- **The agent speaks first.** What an agent says or does on its own, between the messages of a person,
  shows in its tab: a local agent through any ACP update it sends outside a prompt, a remote one through
  the new [inbox extension](docs/a2a-inbox.md) of A2A. A new `progress` event carries lines about what
  the agent is busy with, shown in the open (#29).
- **Remote agents over SSH, in one step.** Settings → **Connect over SSH** takes `user@host` and
  nothing else: flotti asks the host which agents it publishes, adds them, opens an SSH tunnel to each
  one with the published token and keeps it up, reopening it after a drop. The dashboard shows the
  state of the connection and why it failed. In a manifest, `"ssh": "user@host"` takes the place of
  `url`; the contract for agents is in [docs/a2a-ssh.md](docs/a2a-ssh.md) (#22).
- **Agents write to one another.** A remote agent names another agent of the fleet in `to` of an inbox
  message, and flotti delivers it to that agent as a message from the sender: an A2A agent gets `from`
  in the metadata, an ACP agent `[from <id>]` in front of the text. In the receiver's tab the message
  stands on the person's side as an envelope with a bar "SENDER → RECEIVER" in the sender's colour;
  the sender's tab shows the same envelope, and a line when it could not be delivered. Each agent gets
  a colour of its own, picked at random and kept (#23).
- **Waiting agents get attention.** A tab whose agent waits for an answer is highlighted, the page
  title counts the waiting agents, and a browser notification tells when one starts to wait (#27).
- **The harness in the header.** The header of an agent's chat names its harness — `claude`, `codex`
  — or says it is unknown (#24).
- **CI.** Checks run on pull requests and on pushes to `main` and `develop`; a `v*` tag publishes the
  package to npm (#25).

### Changed

- The linter limits functions in `src` and `web` to 20 lines; tests are exempt (#39).

## [0.1.0] — MVP

The first release: a fleet of AI agents and one dashboard to work with them.

### Added

- **`flotti run` / `flotti stop`.** `run` reads the fleet, starts every agent and serves the dashboard
  on `http://127.0.0.1:4870/` until it is stopped; `stop` stops it from any terminal. Both take
  `--fleet <dir>`, `run` also takes `--port` or `FLOTTI_PORT`. One fleet is run by one flotti (#11).
- **The fleet as directories.** Each agent is a directory `agents/{local,remote}/<id>/` with its
  manifest `agent.json`; a local agent also has its own `skills/` and `memory/`. The fleet lives in
  `~/.flotti/agents` by default, or where `--fleet`, `FLOTTI_FLEET` or the settings page point. This
  replaces the single configuration file of the first draft (#2, #8).
- **Local agents over ACP.** Claude Code and Codex are started through their ACP adapters, talked to,
  and restarted when they fall over or stop answering, keeping the session when they can (#9).
- **Remote agents over A2A.** A client on the official `@a2a-js/sdk`: A2A 1.0 and 0.3, JSON-RPC and
  HTTP+JSON, streaming with reconnects or polling, cancel, and restart on request through the
  [restart extension](docs/a2a-restart.md) (#10).
- **The dashboard.** A React page with a tab per agent — status, live output, permission requests,
  a field to write to the agent, Restart / Stop / Start / Cancel — and a broadcast to all agents at
  once with per-agent delivery (#11).
- **Fleet settings.** Add, change, remove, start and stop agents and pick the fleet directory from the
  dashboard (#12).
- **Linting** with ESLint and `@stylistic` (#5).

### Changed

- The project is renamed from `supavisor` to `flotti`: package, command, directories and environment
  variables (#15).

### Outside this repository

- The A2A adapter of Eva, so the dashboard can connect to her session
  ([micromagicman/eva#266](https://github.com/micromagicman/eva/issues/266)).
- The A2A adapter of Cutie, on the same contract as Eva's (owners/quanthread-ai-hub#218, !194).

[0.3.0]: https://github.com/micromagicman/flotti/releases/tag/v0.3.0
[0.2.0]: https://github.com/micromagicman/flotti/releases/tag/v0.2.0
[0.1.0]: https://github.com/micromagicman/flotti/releases/tag/v0.1.0
