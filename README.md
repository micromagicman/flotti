<h1><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/micromagicman/flotti/main/assets/logo/flotti-logo-dark.svg"><img src="https://raw.githubusercontent.com/micromagicman/flotti/main/assets/logo/flotti-logo.svg" alt="flotti" height="56"></picture></h1>

Let your AI agents talk — to you and to each other.

flotti is a messenger for AI agents. They talk to each other and give each other tasks inside the groups
you put them in, and you read every group in its tab; you write to any one agent in its tab — with its status, live output and a
restart button — or to all of them at once with a broadcast. It **runs local agents** over ACP (starts
them, talks to them, restarts them when they fall over) and **talks to remote agents** over A2A (see
[Talking to a remote agent](#talking-to-a-remote-agent)). flotti is standalone today, on your own
machine; a cloud edition is planned.

## Requirements

Node.js 20.11 or newer.

## Install

```bash
npm install -g flotti
```

That puts the `flotti` command on your `PATH`. Without installing, `npx flotti <command>` does the same.

## Run

```bash
flotti start    # starts the fleet and the dashboard in the background: http://127.0.0.1:4870/
flotti status   # lists the agents of the fleet with their status
flotti stop     # stops them, from any terminal
flotti run      # what start does, in the foreground: Ctrl+C stops it
```

That is the whole command line; everything else is done in the dashboard — agents are added, changed,
removed, started and stopped there, and the fleet directory is picked there too (see
[Settings](#settings)). Every command also takes `--fleet <dir>`, for tests and for several fleets on
one machine (see [Where the fleet comes from](#where-the-fleet-comes-from)); `start` and `run` also
take `--port <port>` or `FLOTTI_PORT`.

- **`flotti start`** runs the fleet in the background and gives the terminal back once the dashboard
  listens, printing its address. What `flotti run` would print goes to `.flotti.log` in the fleet
  directory, rewritten on every start. If the fleet does not come up — a broken manifest, a taken
  port — `start` prints why and exits with `1`, leaving nothing running. If the fleet already runs,
  `start` does not start a second one: it says so, prints the address of its dashboard and exits
  with `0`.
- **`flotti run`** does the same in the foreground and stays there until it is stopped: Ctrl+C, a
  `SIGTERM`, or `flotti stop`. It stops its agents before it exits. An agent that fails to start
  does not stop the others: its tab says why, and the restart button tries again. One fleet is run
  by one flotti: a second `flotti run` of the same fleet refuses.
- **`flotti stop`** stops a fleet started by either of them. It finds the flotti that runs the fleet
  by `.flotti-run.json` in the fleet directory, asks it to stop, and waits until it has — up to 30 s.
  It asks over the dashboard rather than with a signal, because on Windows a signal kills at once and
  would leave the agents running. With nothing running it says so and exits with `0`.
- **`flotti status`** asks the running flotti for its agents and prints them as a table, one line an
  agent; the harness is `-` where flotti does not know it (see [A local agent](#a-local-agent)). When
  an agent of the fleet is reached over SSH, the table also has the health of its connection — the
  latency, the reconnects in all and in the last hour, how long the tunnel has been up, and `POOR:`
  with the reason when it is poor (see [The health of the connection](#the-health-of-the-connection)):

  ```text
  flotti runs /home/me/.flotti/agents (process 4242), dashboard http://127.0.0.1:4870/

  ID      TYPE    HARNESS  STATUS
  claude  local   claude   idle
  codex   local   codex    working
  eva     remote  -        waiting
  ```

  With nothing running it says so and exits with `1`.

On any problem with the fleet flotti prints one sentence explaining it and exits with a non-zero
code, see [When something is wrong with it](#when-something-is-wrong-with-it).

From the source: `npm ci`, `npm run build`, then `node build/index.js start` (or `npm link` for the
`flotti` command).

## The dashboard

It listens on `127.0.0.1` only and has no login: it is for the person at this machine.

- **A tab per agent**, local ones first: its name, its status — `starting`, `idle`, `working`, `waiting
  for you`, `error`, `stopped` — and a dot when it has said something since you last looked.
  `waiting for you` — a permission to grant, an answer the agent asked for — stands out the most.
- **The header of the tab** names the harness that runs the agent — `claude` or `codex`, from the
  `adapter` of its manifest; a remote agent names its own in its published file or its card
  ([docs/a2a-ssh.md](https://github.com/micromagicman/flotti/blob/main/docs/a2a-ssh.md#which-harness-runs-the-agent)), and a name flotti does not know
  is shown as it is. A local agent with no `adapter` and a remote agent that says nothing do not tell
  which harness runs them, and the header says `harness unknown` rather than guess.
- **Inside the tab**: the agent's output as it comes — messages, collapsed reasoning, tool calls with
  their progress, permission requests with the options the agent offered, diagnostics, and whatever
  else the protocol said, raw and collapsed. An answer reaches the tab the way **Answers** in Settings
  says, the same for every agent: piece by piece as it is written, or whole once the agent has
  finished it. Below it, a field to write to the agent: Enter sends,
  Shift+Enter makes a new line. A message to a busy agent waits in line at the end of the feed, under a
  dashed line "NEXT UP": each one with its place in line and **✕ cancel** to take it back before the
  agent gets it; the tab in the sidebar says how many wait ("working · 2 in line"). Once the agent takes
  a message, it joins the feed where its turn starts. A message the line lost — the agent was stopped
  or restarted, or flotti was — says "Not delivered" and why, with **Send again**.
  **Restart** restarts the agent — a local one keeps its session when it can, a remote one is asked to
  restart itself or starts a new conversation (see [Lifecycle](#lifecycle) and
  [Talking to a remote agent](#talking-to-a-remote-agent)); **Stop** stops it until **Start** starts it
  again; **Cancel** drops the message in work.
- **Chat and Memory**: the header of a tab switches between the chat and the agent's memory bank.
  **Memory** shows the notes of `memory/`, read-only: the folders and a search on the left, the note on
  the right — rendered markdown, where a `[[link]]` opens the note it names, a link to a note that is
  not there is grey and dashed, and "Linked from" lists the notes that link to this one. On a narrow
  screen the list comes first and a note opens over it, with **← All notes** back. Only `.md` files
  inside the bank are read — no hidden ones, none a symbolic link leads out of it, none over a
  megabyte — and the dashboard never writes there. A remote agent, and a local one started over SSH, keep
  their memory on another machine: the view says so instead, and so it does for a bank that cannot be
  read — an unavailable bank is never shown as an empty one. Next to the harness, the details of the agent
  («i» in the header) say whether it has [memory](#memory): **memory on · policy v1**, **memory
  unsupported** or **memory unavailable**, with why on hover.
- **Reply and Forward** sit on the corner of every message, on hover or focus (always, on a touch
  screen). **Reply** puts the message above the field as a quote; the agent gets the quoted text above
  your answer, and in the tab the quote leads back to the message it answers — in this tab or another
  one — until the message is gone from the history. **Forward** sends the message, as it was, to
  another agent you pick: its tab shows it under a bar "FORWARDED · AUTHOR" in the tone of whoever
  wrote it, and the agent gets it as `Forwarded from …:` and the text. Escape drops the reply.
- **Every agent keeps one mark** everywhere — a shape in a muted hue by its name in the sidebar, in
  the header of its tab and among the members of a group — and a faint tone of that hue on the bar of
  its envelopes. There are no conversations of pairs any more: agents talk inside groups (#171).
- **Groups**, the second section of the sidebar, lists every group of the fleet
  ([docs/groups.md](docs/groups.md)): the marks of its members in a row (a member not in the fleet a
  hollow grey square, more than four «+N»), its name, how many members and messages, and a dot when
  something was said in it since you last looked; a closed section carries the dot on its icon. The tab
  of a group is the tab of an agent for a group: a header with the members by mark and name and
  **Edit**, which opens the group's form in place of the lane (see [Groups](#on-the-dashboard)), the
  topic under it; one lane of what was said in
  it, in the order it was sent — your messages on the right, the agents' as envelopes on the left, an
  answer a member gave in the turn a message started marked «answer» and quoting the message it
  answers; under every message, folded, how each member took it («claude, codex got it · tester
  failed»), and open, the list of the broadcast page — a member that was busy is «in line» until it
  takes the message or fails it, and then the fold says so, as does the history a page opened later
  reads; a task given in the group as the card of the task, in the state it stands in, and its outcome
  from the doer marked «task completed» (or failed, canceled) and quoting it; and a field at the foot:
  Enter sends to every member, **Reply** quotes. A group is read in its tab and nowhere else: there is
  no feed of the whole fleet (#173). **Add group**, the last tab of the section, opens the form for a
  new group; a saved group opens its tab (#175). A fleet with agents but no group says in the section
  that the agents do not see each other yet, and one click **Everyone** puts every agent of the fleet
  in one group of that name. The details of an agent («i») list its groups.
- **All agents**, the first tab of the Agents section, sends one message to every agent you leave ticked.
  The sidebar has a rail of two sections — **Agents** and **Groups** — and remembers the one
  you picked across reloads. Each gets it on its own, so an
  agent that is down or busy holds nobody up; the page shows, agent by agent, whether the message was
  delivered, waits in line or failed, and the answers come in each agent's tab.
- **Administrators** of the fleet are marked `admin` in the header of their tab. What one does to an
  agent — a restart, a cleared context — is a line in its own tab and in the tab of that agent; a
  cleared context is a divider in the tab of the agent it was cleared for, and the history above it
  stays. See [Administrators of the fleet](#administrators-of-the-fleet).
- **Settings** sets the fleet up; see below.

### Settings

The settings page does what would otherwise be done by editing files, and it does it by writing the
same files: the fleet stays directories a person can read and edit by hand.

- **Connect over SSH.** A remote agent in one step: its `user@host`, and **Connect**. Your public key
  has to be on the host; flotti asks the host which agents it publishes, adds them and keeps an SSH
  tunnel to each one up — no `ssh -L`, no port, no token to copy. When it cannot, it says why: the key
  is not accepted, the host is unknown or unreachable, the host publishes nothing. See
  [Over SSH](#over-ssh).
- **Agents.** Each agent of the fleet with its status and **Start**/**Stop**, **Restart**, **Edit**
  and **Delete**. **Add local agent** and **Add remote agent** open a form with every field of
  [the manifest](#the-manifest-agentjson) and, for a local agent, its system prompt. Picking an adapter
  fills in the command it is started with. A field left empty is left out of `agent.json`, so the
  documented default applies; fields the form does not know are kept as they are in the file.
- **Checked before it is written.** A new or changed agent is checked the way `flotti run` checks the
  fleet, and nothing is written when the check fails: the form shows the same sentence the command line
  would print. The id names the directory, so it is picked once and stays.
- **Put to work at once.** A new agent is started as soon as it is saved. A changed one is restarted
  with its new manifest — unless it was stopped, then it stays stopped — and its tab keeps its history.
- **Delete** stops the agent and moves its directory — memory bank and skills with it — to `.trash/`
  in the fleet directory, as `<local|remote>-<id>-<time>`. The fleet does not read `.trash/`; to bring
  an agent back, move its directory back and run flotti again.
- **Groups are not here.** Since 0.7.0 a group is made with **Add group** in the Groups section and
  changed or deleted from its own tab — see [Groups on the dashboard](#on-the-dashboard) (#175).
- **Fleet directory.** Shows the directory the run works with and where it came from. **Switch** points
  the run at another one: the agents of the old fleet stop, those of the new one start, and
  `.flotti-run.json` moves along so `flotti stop` still finds the run. A directory that is not there
  yet is created — that is how a new fleet begins; one with a broken manifest is refused, and nothing
  changes. The choice is saved in `~/.flotti/settings.json`, and the next `flotti run` opens it.
- **Notifications.** For when you are away from the dashboard; see
  [Notifications outside the browser](#notifications-outside-the-browser).
- **Administrators.** **Administrator** in the form of an agent gives it the role (`admin` in its
  manifest); only a person gives and takes it. **Ask me before an administrator restarts an agent or
  clears its context** makes every such action wait for **Allow** in the tab of the administrator —
  **Refuse** reaches the administrator as a refusal; off, the action is done at once. It is off by
  default, saved in `~/.flotti/settings.json` and read at every action.
- **Answers.** How an answer of an agent reaches its tab — one rule for every
  agent, local over ACP or remote over A2A, whatever way the agent sends its answer. **As it is
  written, piece by piece** shows the message growing as the pieces come; **Whole, once the agent has
  finished it** shows the message once, when it is complete — at the end of the message, or at the end
  of the turn when nothing marks the end of the message — and nothing partial before: no growing
  bubble. Tool calls and reasoning between the pieces show as they come, and the message follows them.
  What an agent says outside a turn has no end to wait for and shows as it comes. The rule is applied
  once, on the way to the dashboard; what agents send one another is not held. Piece by piece by
  default, saved in `~/.flotti/settings.json` as `answerDelivery` (`streamed` or `whole`); a change
  holds for the next message, and no agent is restarted. The history of a tab keeps what the tab got:
  the pieces when streamed, one message when whole — either way the tab reads the same after a reload.

### Notifications outside the browser

The tab of the dashboard tells you when an agent waits — but only while it is open. Set up a channel on
the settings page and flotti tells you wherever you are. Nothing is set up at first, and then nothing
is sent.

- **When.** Each switched on its own: an agent **waits** for an answer or a permission, an agent
  **fails** or its process falls, the **SSH connection** to an agent is lost. One notification per
  wait, failure or lost connection, however long it lasts. When the agent gets its answer, the
  notification of the wait is taken back. **Remind every** tells again, every so many minutes, that an
  agent still waits; `0` tells once.
- **Telegram.** A bot of your own: its token from [@BotFather](https://t.me/BotFather) and the chat it
  writes to — your id, or a group the bot is in. The message says who waits and why, with a link to
  the tab of the agent; the answer deletes it (or, where Telegram no longer lets the bot, marks it
  *Answered.*). `FLOTTI_TELEGRAM_API` points flotti at another Bot API server.
- **Web Push.** **Notify this browser** registers the service worker of the dashboard and subscribes
  the browser: notifications then come with the dashboard closed, as long as the browser runs. flotti
  sends them itself — signed with a key of its own (VAPID) and encrypted for that browser — through
  the push service of the browser, which sees neither the text nor the agents. While a page of the
  dashboard is in front of you, it tells you itself.
- **Link to the dashboard.** The links lead to this dashboard on `127.0.0.1`; if you reach it another
  way — a tunnel, another name — put that address here.
- **Send a test** sends one over every channel switched on, and says how each went.

Everything is saved under `notifications` in `~/.flotti/settings.json`, which only its owner may
read. The bot token and the private key never go back to the page — it learns only that a token is
saved — and never into a log: a failed notification is reported on standard error without them.
Types for any other channel are in `src/notifier.ts`: a channel sends a notification and takes back
those of a key.

The server is the one source of truth and the page only follows it: every event of an agent has a
number, and a page that connects — or reconnects after losing the connection — says which it has seen
and gets only the rest. So a reload or a second window shows the same history.

The history also survives a restart — of one agent, of flotti, of the machine. flotti writes every
event of an agent to `.flotti-history.jsonl` in the agent directory, one JSON event per line, and reads
it back when it starts: the tab shows the conversation, tool calls, permission requests and status
lines as they were, then a line *flotti was started again; everything above is from before*, and goes
on. Event numbers go on too, so a page left open over the restart gets only what it has not seen. Each
agent keeps its last 5000 events: once the file holds twice that many, it is rewritten with the newest
5000, and the oldest are gone. The file is the agent's, like the rest of its directory: it goes to
`.trash/` with it, and deleting the file clears the tab from the next start on. A file flotti cannot
read or write is reported once on standard error; the agent runs on, without the history on disk.

### What the page talks to

The page reads over a WebSocket and acts over plain HTTP; the types are in `src/dashboard-protocol.ts`.

| Request                                       | What it does                                           |
|-----------------------------------------------|--------------------------------------------------------|
| `GET /api/agents`                             | the agents and their statuses; `health` for an agent over SSH |
| `POST /api/agents/<id>/messages` `{text, replyTo?, forwarded?, retryOf?}` | a message to one agent: `taken`, `queued` or `failed`; `replyTo` quotes a message, `forwarded` sends one on (`text` may then be empty), `retryOf` names the undelivered message it sends again |
| `DELETE /api/agents/<id>/queue/<messageId>`   | takes a message that waits in line back out of it; 404 once the agent took it |
| `POST /api/broadcast` `{text, agents?}`       | one message to these agents, or to all; a result each  |
| `POST /api/groups/<id>/messages` `{text, replyTo?, forwarded?}` | a message to a group: every member gets it on its own, a result each in the order of the members; it is one message of the group, with the deliveries, on the socket and in the group's history — a `queued` delivery is written to that message as `taken` or `failed` once it ends, and the message goes out on the socket again |
| `POST /api/agents/<id>/restart`               | restarts the agent; answers at once, the status follows |
| `POST /api/agents/<id>/cancel`                | drops the message in work                              |
| `POST /api/agents/<id>/start`, `…/stop`       | starts or stops the agent; start answers at once        |
| `POST /api/agents` `{kind, id, …}`            | a new agent: writes its directory and starts it         |
| `POST /api/ssh-agents` `{target}`             | adds the agents `user@host` publishes, reached over SSH |
| `GET /api/agents/<id>`                        | its manifest as the file says it, and its system prompt |
| `PUT /api/agents/<id>` `{kind, id, …}`        | a changed manifest: writes it and restarts the agent    |
| `DELETE /api/agents/<id>`                     | stops the agent and moves its directory to `.trash/`    |
| `GET /api/agents/<id>/memory` `?q=`           | the notes of the agent's memory bank, with the words `q` when given; `available: false` and why for an agent whose memory is not here |
| `GET /api/agents/<id>/memory/<path>`          | one note and its text; `<path>` is its path in the bank, encoded as one segment |
| `GET /api/fleet`, `PUT /api/fleet` `{path}`   | the fleet directory; switches to another one            |
| `GET /api/groups`                             | the groups of the fleet: `id`, `name`, `topic`, `members` |
| `POST /api/groups` `{id, name?, topic?, members?}` | a new group: writes `groups/<id>/group.json`; `members` left out is none yet |
| `GET /api/groups/<id>`                        | its file as it says it                                  |
| `PUT /api/groups/<id>` `{name?, topic?, members?}` | a changed group: writes the file, keeps the fields the page does not edit |
| `DELETE /api/groups/<id>`                     | moves its directory to `.trash/`, as `group-<id>-<time>` |
| `POST /api/agents/<id>/permissions/<request>` `{optionId?}` | answers a permission request; no option refuses it |
| `GET /api/notifications`, `PUT /api/notifications` `{events?, repeatMinutes?, dashboardUrl?, telegram?, webPush?}` | the notification settings, without secrets; a change of them |
| `POST /api/notifications/subscriptions`, `DELETE …` `{endpoint, keys}` | a browser subscribes to Web Push, or stops |
| `POST /api/notifications/test`                | a test notification over every channel switched on      |
| `GET /api/admin-settings`, `PUT /api/admin-settings` `{confirmActions}` | whether actions of administrators wait for a person |
| `GET /api/answer-delivery`, `PUT /api/answer-delivery` `{mode}` | how answers reach the tabs: `streamed` piece by piece, `whole` once complete |
| `POST /api/admin-actions/<action>` `{allow}`  | allows or refuses an action of an administrator waiting for it |
| `/ws`                                         | `fleet` — the agents and the groups — first, and again on every change of the fleet; the page answers `subscribe` with the last number it has seen of each agent, and of each group under `_group:<id>`, and gets the events and the `group-message`s after them, then live ones — a `group-message` with a `seq` the page has is that message with a delivery that was in line settled; `health` whenever the health of the SSH connection of an agent changes |

With no login, the server guards against other web pages rather than against people: it answers only
to the host names of this machine (a page elsewhere cannot rebind a name of its own to `127.0.0.1`),
takes actions only as JSON (a form of another site cannot send it), and refuses a WebSocket opened
from another site.

## The fleet

Every agent is a directory, and the directory name is the agent id:

```
~/.flotti/agents/
├── local/                  agents flotti starts itself
│   └── claude/
│       ├── agent.json      the manifest
│       ├── system-prompt.md  optional
│       ├── skills/         the agent's own skills
│       ├── memory/         the agent's memory bank: markdown notes linked with [[…]]
│       └── .flotti-history.jsonl  what its tab shows, kept across restarts
├── remote/                 agents that run elsewhere, reached over A2A
│   └── eva/
│       ├── agent.json
│       └── .flotti-history.jsonl
└── groups/                 groups of agents: who sees and reaches whom
    └── release/
        └── group.json      the group: its name, its topic and its members
```

- An id is letters, digits, `.`, `_` and `-`, starting with a letter or a digit. Ids are shared by
  local and remote agents: `local/eva` and `remote/eva` cannot live in one fleet.
- Entries whose names start with `.` are skipped, so `.DS_Store` and the like do no harm. Anything else
  in `local/` or `remote/` must be an agent directory.
- `local/` and `remote/` may be absent — that group is simply empty.
- `groups/` holds the groups of agents: each is a directory named by its id with `group.json` in it —
  an optional `name` and `topic`, and `members`, the ids of the agents in it, which may be empty. It is
  read with the fleet and checked like a manifest, naming the file when something is wrong; a member
  that is not in the fleet is kept and shown so; fields flotti does not know are kept. A fleet has no
  `groups/` until a person makes a group — none is made for it. The messages of a group are in its
  `.flotti-history.jsonl`, written by flotti and bounded like an agent's. What a group does is in
  [docs/groups.md](docs/groups.md).
- `skills/` and `memory/` belong to the agent: flotti creates them when they are missing, and writes
  there only what [memory](#memory) needs — the built-in skill `skills/flotti-memory`, never over a skill
  of the agent's own of that name, and the notes the agent writes with the memory tools; the dashboard
  only shows the notes of `memory/`. It hands them to the agent, as told in [Running a local agent](#running-a-local-agent).
- `logs/` is where flotti keeps what a running agent said; see the same section.
- `.flotti-history.jsonl` is the history of the agent's tab, written by flotti; see
  [The dashboard](#the-dashboard).

### Where the fleet comes from

The first of these that is set wins:

1. `--fleet <dir>` (also `--fleet=<dir>`);
2. the `FLOTTI_FLEET` environment variable;
3. the directory picked on the [settings page](#settings), saved in `~/.flotti/settings.json`;
4. `~/.flotti/agents` — the default.

Pointing at another directory is how tests and several fleets on one machine keep apart. A leading `~`
is expanded by flotti itself, from `HOME` (or `USERPROFILE` on Windows), because under `npx` there
is no shell to do it. A relative path is resolved against the current directory.

A missing default or saved directory is an empty fleet — that is what the first run looks like. A
missing directory named by `--fleet` or `FLOTTI_FLEET` is an error: it is most likely a typo. A run
started with `--fleet` or `FLOTTI_FLEET` may still switch on the settings page; the next run started
the same way opens that directory again, since those two win over the saved one.

## Groups

**Agents see and write to each other only inside a group** ([docs/groups.md](https://github.com/micromagicman/flotti/blob/main/docs/groups.md), #144; the requirements as built are in [`openspec/specs/groups`](https://github.com/micromagicman/flotti/blob/main/openspec/specs/groups/spec.md)).
A group is a topical conversation — a name, a topic, a set of agents and a history of its own. An
agent outside a group does not get its members as peers and cannot write to them; you are above the
groups and see and reach everyone, as before. The rule lives in flotti, on every path a message
between agents takes, so no agent can get round it — and an agent that knows nothing of groups is
not broken by them: it sees fewer peers, that is all.

### What a group is

A group is a directory of the fleet, `groups/<id>/`, next to the agents; the directory name is its
id (letters, digits, `.`, `_` and `-`, starting with a letter or a digit — the rule of an agent id,
since it goes in tool arguments and tab addresses). `group.json` in it holds an optional `name` —
the id when absent — an optional `topic`, which the agents get as it is written, and `members`, the
ids of the agents in it, which may be empty:

```json
{
    "name": "Release 0.6.0",
    "topic": "Ship 0.6.0: the groups feature, its docs and the release notes.",
    "members": ["eva", "reviewer", "tester"]
}
```

- Ids of groups and of agents are separate namespaces: a group `eva` and an agent `eva` may both
  exist — a tool names a group in `group` and an agent in `to`.
- An agent may be in several groups; you are in none.
- A member is named by id only. A member that is not in the fleet — deleted, or typed by hand — is
  kept in the file and shown as *not in the fleet*; it is not an error, and the fleet loads.
  Deleting an agent in the settings takes it out of every group.
- Only a person changes membership: from the tab of the group ([On the dashboard](#on-the-dashboard))
  or by editing the file. No
  tool lets an agent join, leave or invite; `list_groups` says so.
- The messages of a group are its own, in `groups/<id>/.flotti-history.jsonl`, written by flotti and
  bounded like an agent's — see [The fleet](#the-fleet) for the layout.

### Who sees whom

The **peers** of an agent are the members of every group it is in, itself excluded. An agent in no
group with anyone has no peers.

- `list_agents` names the peers only, each with `groups` — the ids of the groups the caller shares
  with it — and the caller's own entry marked `you`; an agent with no peers gets an empty list and a
  sentence saying it is not in a group with anyone yet, so it does not take the fleet for empty.
  `list_groups` names the groups the caller is in, with the topic and the members by id and name.
  The [roster of a remote agent](#talking-to-a-remote-agent) lists the peers the same way, with
  `groups` beside `agents`, and goes out again when a group changes.
- **Agents talk inside groups only** (0.7.0, #171). `send_message`, `reply` and `forward` post to a
  group the caller is in; `to` is gone from them, and a call that names it is refused before anything
  else is asked, with `"to" is gone: a message to another agent goes through a group — name the group
  in "group" and the agent with @<id> in the text`. `to` of [the inbox](https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md)
  with `kind: message` gets a line in the tab of the sender instead, `could not deliver the message to
  "x": a message to another agent goes through a group; name it in "group"`.
- `delegate`, `task` of the inbox and the actions of an administrator reach an agent by name: a task
  a member of the group it names, an action a peer. Any other agent — outside that group, in no group
  with the sender, or not in the fleet at all — is refused with the same words,
  `there is no agent "x" among the agents you can write to; list_agents names them`, so an agent
  outside a group learns nothing of the members, not even that they exist. The tab of the sender,
  which you read, says the real reason: `"x" is not in a group with "eva"`, or `"x" is not in group
  "release"`.
- **Administrators are bound like everyone**: `restart_agent`, `clear_context` and the `admin`
  requests of the inbox act on the peers of the administrator and on itself. An administrator that is
  to look after the whole fleet is put in every group.
- **The check is at the door.** What comes back from an exchange that was allowed — the answer flotti
  sends back at the end of a turn, the outcome of a task — reaches the agent that started it even when
  the two no longer share a group by then. A message sent on purpose is a new exchange and is checked
  anew.
- **You are bound by nothing.** The message of a tab and the broadcast to all agents stay
  fleet-wide: groups are a rule for agents, not a filter on the dashboard.

### A message to a group

A message to a group reaches every member but the sender, each on its own, as a broadcast does — a
member that is down or busy holds nobody up — and is one line of the group's history with how each
member took it: `taken`, `queued`, or `failed` and why. A member that is stopped does not get it, and
the history says so. The socket carries the line as a `group-message`, and a page asks for the messages
of a group on `subscribe` under `_group:<id>`, as it asks for the events of an agent under its id.

- **From you:** the field of the tab of the group, or `POST /api/groups/<id>/messages` with the body
  of a broadcast, answered member by member like `POST /api/broadcast`.
- **From an agent:** `send_message` and `forward` take `group` — the id of a group the caller is in —
  and a member the message is for is named in the text, `@<id>`; `reply` answers in the group the last
  group message came from, and says so when none came yet. A remote agent posts with `group` in the
  metadata of its inbox, with `kind: message`.
  A group the caller is not in is refused with the words for one that does not exist,
  `there is no group "x" among the groups you are in; list_groups names them`; the tab of the sender
  says the real reason.
- **What a member gets:** the message in its tab, marked with the group — a `message` event with
  `group` beside `from`. A local agent over ACP, and a remote one without the inbox, read it as
  `[from eva in group release] …`, and your message to a group as `[in group release] …`; a remote
  agent with the inbox gets `group` beside `from` in the metadata.
- **What a member answers** in the turn the message started is posted to the group — its history, its
  tab, the other members — as an answer from that member, marked `turnAnswer` («answer» in the tab) and
quoting the message. Such
  an answer earns no answer back: one message gets at most one round of answers, never a loop. A member
  with more to say says it on purpose, with `send_message` and `group`.
- **A task inside a group** — `delegate` with `group` and `to`, `task` of the inbox with `group` and
  `to` — goes to one member: it is posted to the group as a message from the giver mentioning the
  doer (`@reviewer …`), with the task and its deadline, and handed to the doer alone; the doer's turn is
  the task, and the outcome is posted to the group as a message from the doer, answering the task, with
  how it ended, and comes back to the giver. The tab of the group shows the card of the task. A task
  with a group and no doer is refused: a task has one.

The tab of a group shows, under every message, how each member took it. A member that was busy is
recorded as `queued` when the message is posted; when it takes the message or fails it, the line of the
history is written again with `taken` or `failed` and the reason, and goes out on the socket as a
`group-message` once more — so the fold says the real outcome, as does a page opened later.

### On the dashboard

- **The Groups section** of the sidebar lists the groups of the fleet, and **the tab of a group** —
  `_group:<id>` — is where you read the conversation and write to every member; the details of an
  agent list its groups. How each
  looks is in [The dashboard](#the-dashboard).
- **A group is managed where it is read** (#175). **Edit** in the header of its tab opens the form in
  place of the lane: the id names the directory `groups/<id>/` and stays, read-only; the name, the
  topic the agents get as it is, and the members as ticks over the agents of the fleet, plus ids typed
  by hand for agents that are not in it yet. A member the fleet does not have — deleted, or typed by
  hand — is kept and shown as *not in the fleet*. **Save** checks the group the way `flotti run` does
  before `group.json` is written, refuses it with the same sentence, and brings the lane back with the
  header changed; **Cancel** drops what was typed. The agents in the group see the change on their
  next `list_agents`, and a remote one gets the roster again. **Delete**, in the same form, asks first
  and names the group, then moves the directory to `.trash/` as `group-<id>-<time>`; the page goes to
  the next group of the section, or to Add group when it was the last.
- **Add group** is the last tab of the Groups section, as Add agent is the last of Agents: the same
  form for a new group, whose id is picked once; a saved group opens its tab. Settings has no Groups
  list since 0.7.0.
- **Everyone.** A fleet with agents but no group says in the Groups section that the agents do not see
  each other yet, and one click puts every agent of the fleet in one group named «Everyone» — a group
  like any other, to edit or delete from its tab.

### An existing fleet

A fleet made before 0.6.0 has no `groups/`, and the first run after the upgrade makes none: every agent
sees no peers, `list_agents` says it is not in a group with anyone yet, the roster of a remote agent
goes out with an empty `agents`, and the Groups section offers **Everyone**. What the agents said to each
other before stays in their tabs, in the conversations and in the feed. A flotti older than 0.6.0
opened on a fleet with `groups/` reads `local/` and `remote/` only, so nothing in the files breaks it —
and every agent sees everyone again, which is what that version does.

Adapters written before 0.6.0 keep working: the roster of a remote agent is shorter and carries a
`groups` field they ignore; a group message reaches them with `group` in the metadata they ignore and
`from` they read; a local agent needs nothing — `list_agents` shrinks, `list_groups` is one tool more,
`send_message` gets an argument. They cannot post to a group until they learn `group`; they can write
to any peer.

## The manifest: `agent.json`

JSON, and JSON has no comments — so the fields are explained here rather than in the file. Fields
flotti does not know are ignored, so a manifest written for a later version still works with this
one.

### A local agent

The smallest one:

```json
{
    "command": "npx",
    "arguments": ["-y", "@agentclientprotocol/claude-agent-acp@0.81.1"]
}
```

| Field                 | Required | Type                            | Default                        | Meaning                                                                          |
|-----------------------|----------|---------------------------------|--------------------------------|----------------------------------------------------------------------------------|
| `command`             | yes      | non-empty string                | —                              | Executable to run: an agent that speaks ACP, or an ACP adapter.                  |
| `arguments`           | no       | array of strings                | `[]`                           | Arguments for the executable.                                                    |
| `name`                | no       | non-empty string                | the id                         | Name shown to people.                                                            |
| `description`         | no       | non-empty string                | —                              | One line about the agent.                                                        |
| `id`                  | no       | non-empty string                | —                              | If given, must equal the directory name; the directory is what counts.            |
| `adapter`             | no       | `claude-code`, `codex`          | —                              | Which ACP adapter `command` starts, so flotti knows how to hand over the model, the system prompt and the skills. Without it the agent gets plain ACP only. |
| `model`               | no       | non-empty string                | the adapter's own default      | Model the agent is asked to use.                                                 |
| `ssh`                 | no       | `user@host`, `user@host:port`   | —                              | Start the agent on that host over SSH instead of here: see [On another host](#on-another-host). |
| `workdir`             | no       | non-empty string                | the agent directory            | Directory the agent is started in; a relative one is taken from the agent directory, `~` is expanded. With `ssh`, a path on that host, `~` there by default. |
| `env`                 | no       | object of strings               | `{}`                           | Variables added to the agent environment.                                        |
| `restart`             | no       | `always`, `on-failure`, `never` | `on-failure`                   | What to do when the agent stops.                                                 |
| `heartbeatTimeoutSec` | no       | positive number                 | `60`                           | Seconds without a heartbeat before the agent counts as lost.                      |
| `admin`               | no       | `true`, `false`                 | `false`                        | An administrator of the fleet: see [Administrators of the fleet](#administrators-of-the-fleet). |

The system prompt is not a field: it is the file `system-prompt.md` next to the manifest. A prompt is
prose, often long, and a JSON string is a poor place to write prose in.

What flotti does with `adapter`, `model`, `restart` and `heartbeatTimeoutSec` is in
[Running a local agent](#running-a-local-agent).

A full example:

```json
{
    "name": "Claude",
    "description": "Writes and reviews the code",
    "adapter": "claude-code",
    "model": "opus",
    "command": "npx",
    "arguments": ["-y", "@agentclientprotocol/claude-agent-acp@0.81.1"],
    "workdir": "~/src/app",
    "env": {"LOG_LEVEL": "debug"},
    "restart": "always",
    "heartbeatTimeoutSec": 15
}
```

### A remote agent

```json
{
    "name": "Eva",
    "url": "https://eva.example.org/a2a",
    "auth": {"type": "bearer", "tokenEnv": "EVA_A2A_TOKEN"}
}
```

| Field         | Required | Type             | Default            | Meaning                                         |
|---------------|----------|------------------|--------------------|-------------------------------------------------|
| `url`         | yes, or `ssh` | `http:` or `https:` address | —  | Where the agent is.                             |
| `ssh`         | yes, or `url` | `"user@host"`, or an object, below | — | Reach the agent through an SSH tunnel; see [Over SSH](#over-ssh). |
| `protocol`    | no       | `a2a`            | `a2a`              | How to talk to it; A2A is the only one for now.  |
| `auth`        | no       | object, below    | `{"type": "none"}` | How flotti proves itself to the agent.           |
| `name`        | no       | non-empty string | the id             | Name shown to people.                            |
| `description` | no       | non-empty string | —                  | One line about the agent.                        |
| `id`          | no       | non-empty string | —                  | If given, must equal the directory name.         |
| `admin`       | no       | `true`, `false`  | `false`            | An administrator of the fleet: see [Administrators of the fleet](#administrators-of-the-fleet). |

`auth` is one of:

- `{"type": "none"}`;
- `{"type": "bearer", "tokenEnv": "<variable>"}` — sends `Authorization: Bearer <value of the variable>`;
- `{"type": "api-key", "header": "<header>", "valueEnv": "<variable>"}` — sends the value of the
  variable in that header.

The manifest names the environment variable that holds the secret, never the secret itself: manifests
are plain files, they get copied, shown in the dashboard and edited by it. flotti reads the variable
when it connects; a value that does not look like a variable name is refused.

An agent reached over SSH has `ssh` in place of `url`:

```json
{
    "name": "Eva",
    "ssh": {"target": "eva@build.example.org", "agent": "eva"}
}
```

`"ssh": "eva@build.example.org"` is the same when the host publishes one agent. `target` is
`user@host` or `user@host:port`; `agent` picks one of the agents the host publishes. `url` and `ssh`
cannot both be given; `auth` may, for a host that publishes no token.

## Running a local agent

flotti starts `command` with `arguments` in `workdir` as a child process and talks
[ACP](https://agentclientprotocol.com) to it over stdio: `initialize`, then one session, then a
`session/prompt` for every message. Claude Code and Codex speak ACP through adapters:

| Agent       | `adapter`     | `command` and `arguments`                                          |
|-------------|---------------|--------------------------------------------------------------------|
| Claude Code | `claude-code` | `npx`, `["-y", "@agentclientprotocol/claude-agent-acp@0.81.1"]`    |
| Codex       | `codex`       | `npx`, `["-y", "@agentclientprotocol/codex-acp@1.13.1"]`           |

Pin the adapter version: adapters move and change — both have already changed their package names
once. Keep `-y`: without it `npx` asks whether to install, and it asks on stdin, which belongs to ACP.
On Windows `npx`, `codex` and other npm commands are `.cmd` scripts: flotti finds them through `PATH`
and `PATHEXT` like the shell does and runs them through `cmd.exe`, so `"command": "npx"` works as it
is, without `.cmd`. `cmd.exe` cannot pass a line break on, so arguments of such a command hold none.
Log in to Claude Code or Codex the usual way before: flotti keeps no keys, and an agent that wants a
login stops at once with a message saying so.

### What the agent gets from its directory

ACP has a standard way for the model only; the system prompt and the skills each adapter takes its own
way, so flotti needs `adapter` to know which.

| What                | `claude-code`                                                            | `codex`                                                                               | no `adapter`   |
|---------------------|--------------------------------------------------------------------------|---------------------------------------------------------------------------------------|----------------|
| `model`             | the session's `model` config option                                      | the same                                                                              | the same       |
| `system-prompt.md`  | `_meta.systemPrompt.append` — added to Claude Code's own prompt          | `developer_instructions` in `CODEX_CONFIG` — added to Codex's own prompt              | not passed; a log event says so |
| `skills/`           | the agent directory is loaded as a local plugin, `_meta.claudeCode.options.plugins` | the link `.agents/skills` → `skills/`, where Codex looks in every workspace root | not passed     |
| the agent directory | an extra workspace root, when the agent supports them                    | the same                                                                              | —              |

The extra workspace root is what lets the agent read its skills and keep its memory bank in `memory/`.
A `CODEX_CONFIG` of your own, in `env` or in the environment, is kept; a `developer_instructions` in it
wins over `system-prompt.md`. The system prompt is read at every start, so an edit takes effect on a
restart. A model the agent does not offer stops the start at once: a retry would not change the answer.

### The fleet tools

Every agent flotti starts gets the fleet as tools, with nothing to set up in the agent itself: flotti
serves an MCP server of its own and names it in `mcpServers` of every `session/new`, `session/resume`
and `session/load`. A bare Claude Code or Codex sees them as `mcp__flotti__…`:

| Tool           | What it does                                                                          |
|----------------|---------------------------------------------------------------------------------------|
| `list_agents`  | the agents the caller can write to — those in a group with it — id, name, description, harness, status, `groups` it shares with each; the caller is marked `you`, administrators `admin`; an agent in no group with anyone gets an empty list and a sentence saying so |
| `list_groups`  | the groups the caller is in: `id`, `name`, `topic`, `members` — id and name of each member that is in the fleet |
| `send_message` | sends `text` to every other member of a group the caller is in — `group`, its id; a member it is for is named in the text, `@<id>`; `to` is gone (#171) |
| `reply`        | answers in the group the last group message came from, quoting it |
| `forward`      | forwards the last message another agent sent, as it was, to a group (`group`); `comment` goes before it |
| `delegate`     | gives a member of a group a task: `group`, `to` — the member — `text`, optional `deadline_minutes`; returns the id of the task; a task goes to one member, never to the whole group |
| `cancel_delegation` | takes back a task the caller gave: `id` — as `delegate` returned it                |

A message sent so reaches the other members like one from a person, but from that agent: its `message`
event has `from` — the sender's id — and `group`, and the agent gets it as `[from <id> in group <group>]
<text>`, the way every message from an agent reaches it (#23). What a member answers in its turn stays
in its own tab and is posted to the group as well, as a message from it that quotes the message
answered — the same way for A2A and ACP agents, on both sides. An answer gets no answer back by itself, so two agents do not answer each
other for ever; only the answer goes, not the progress of the turn, and a cancelled turn sends nothing (#45).
A `reply` and a `forward` are the reply and the forward of the dashboard: the `message` event carries
`replyTo` or `forwarded`, and the tab shows the quote or the forwarded message the same way (#30).
`forward` acts on the last message from another agent whichever way it came: through the tools, from a
remote A2A agent, or as an answer posted at the end of a turn (#98); `reply` on the last one that came
through a group.
Messages queue as a person's do; a tool call does not wait for the answer.

`delegate` is `send_message` with an outcome, to one member of a group. The task is posted to the group,
mentioning the doer, and goes in line like a message; the turn the doer spends on it is its work: when
the turn ends, flotti posts the outcome to the group and sends it back to the agent that gave the task
by itself, as a message from the doer that quotes the task — `completed` with what the agent answered in
the turn, `failed` or `canceled` with why. A turn that ends with `end_turn`
completes the task, a cancelled one cancels it, any other end fails it; a turn that pauses to ask a
person goes on with the answer. A task to an agent that is not a member of the group, is stopped, or
refuses the message fails at once, and the tool says why. `cancel_delegation` takes the task out of the line, or
cancels the turn working on it; the giver gets no outcome for a task it took back. A task not done by its
deadline fails, and the agent working on it is told to stop. Both tabs and the tab of the group show the
task as a card — who gave it to whom, where it stands, and the result or the reason once it is over
(#51). An A2A agent gives and
takes back tasks through its inbox: see [docs/a2a-inbox.md](https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md); who is in the fleet it
learns through [the fleet extension](https://github.com/micromagicman/flotti/blob/main/docs/a2a-fleet.md).

Which agents a tool reaches is a matter of groups: `list_agents` names the peers of the caller,
`send_message`, `reply` and `forward` reach a group the caller is in, and `delegate` a member of one —
the rule, the refusal and what a message to a group does are in [Groups](#groups).

The server speaks MCP over HTTP (the streamable transport, with plain JSON answers) on a free port of
`127.0.0.1`, and every agent gets a token of its own in the `Authorization` header: the token tells who
is sending, and without one of the fleet's tokens the server answers nothing. HTTP is the transport
both adapters take — claude-agent-acp 0.81.1 declares `mcpCapabilities` `http` and `sse`, codex-acp
1.13.1 `http` only, and both take `stdio`, which ACP requires of every agent — and the one an SSH
tunnel carries to an agent on another host. An agent that declares no `http` gets no tools, and a log
event says so. A remote A2A agent — one with a loop of its own — gets no tools; a message from an agent
reaches it with a line saying who wrote.

### Memory

A local agent with an `adapter`, on this machine, has a memory that outlives its conversations: the
notes of its `memory/`, one fact per markdown file, with a front matter of `title`, `description` and
`updated` — the same files the Memory view shows, and files a person may edit too. Nothing needs to be
installed; flotti hands it over on every start (#101):

- **The tools.** The fleet tools get four more for such an agent:

  | Tool            | What it does                                                                         |
  |-----------------|--------------------------------------------------------------------------------------|
  | `memory_search` | `query` — the notes whose id, title, description or text hold the words: id, title, description, `updated`, a snippet |
  | `memory_read`   | `id` — the note, with its `revision`                                                 |
  | `memory_write`  | `title`, `description`, `body`, optional `id` and `expected_revision` — writes the note and answers `{id, revision, scope, at}` once it is on disk |
  | `memory_delete` | `id`, optional `expected_revision` — answers `{id, deleted: true}` once it is gone    |

  The id of a note is its path in the bank without `.md`; the revision is a hash of the file, so an edit
  made outside the tools changes it too. Without `id`, `memory_write` adds a new note; a note that is
  there is changed only with the revision it has now — a stale one is a conflict, and nothing is
  written. A write goes to a hidden file that takes the note's place in one rename. Nothing is read or
  written outside the bank: no `..`, no hidden entry, no folder that leads out of it. `scope` may be
  given; anything but `agent` is refused as not supported yet.
- **The policy.** A few rules go after the agent's own system prompt, through the channel of its adapter
  (`_meta.systemPrompt.append` or `developer_instructions`): asked about the past, search; asked to
  remember, search for a duplicate, then write; asked to forget, delete; confirm that something is
  stored only after the tool succeeded, and say so when it failed; no secrets, no archive of every
  message. It is composed anew at every start: `system-prompt.md` is never written, and nothing piles up.
- **The skill.** `skills/flotti-memory/SKILL.md` holds the details — duplicates, contradictions,
  conflicts, forgetting, failures, what not to store — and reaches the agent the way its skills do. Its
  last line carries its version and a hash of its text: flotti brings its own skill up to date, and
  leaves alone a skill of that name it did not write, or one a person edited. The policy still arrives
  then, and the status says the skill is the agent's own.
- **The index.** The first message of every session — new, resumed, loaded, or opened when the context
  is cleared — starts with the rule and a bounded index of the bank: the ids, titles and descriptions of
  the newest 50 notes, when it was taken, and a mark when it was cut short. It is a block marked as data,
  not instructions, and not part of the system prompt: Codex fixes that when its process starts, and a
  resumed session would keep a stale index. The feed shows the message as it was written.

The status in the details of the agent is decided by what flotti delivered, not by what the agent says: **on** when
the tools are in the session and the policy went with the instructions, **unavailable** when `memory/`
cannot be read and written, **unsupported** for an agent without an adapter, one that takes no MCP
server over HTTP, one on another host — memory there waits for an end-to-end test on the storage it has
— and a remote A2A agent (#94). A running turn is never interrupted: an agent gets the contract, and a
new version of the policy, on its next start. Memory calls show in the feed like any other tool call.

Not yet — candidates for a second stage: a memory of the whole fleet with access rights; recalling the
relevant notes on the server before every message; a handshake that holds messages until the agent
acknowledged the policy; a warning when an agent says it remembered without a write; memory for remote
and SSH agents.

### Administrators of the fleet

An agent with `"admin": true` in its manifest — or **Administrator** ticked in the settings — may
look after the other agents without a person at hand. There may be several administrators or none;
by default there are none. An administrator gets two more tools:

| Tool             | What it does                                                                        |
|------------------|-------------------------------------------------------------------------------------|
| `restart_agent`  | restarts an agent: `id` — its id; a local agent as a process, a remote one through [the restart extension](https://github.com/micromagicman/flotti/blob/main/docs/a2a-restart.md), or with a new conversation when it has none |
| `clear_context`  | starts the conversation of an agent anew: a local agent gets a new ACP session, a remote one a new `contextId`; what it is doing now is cancelled |

A remote administrator asks the same through [the inbox](https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md#requests-of-an-administrator).
An administrator may name itself; the action is then done once the turn it asked in is over. It acts on
the agents it sees — those in a group with it, as `list_agents` names them — and on itself; an
administrator for the whole fleet is put in every group ([docs/groups.md](https://github.com/micromagicman/flotti/blob/main/docs/groups.md)).
Whether the caller may is decided by flotti: an agent that is not an administrator is refused, with
the reason, and nothing happens. No tool gives or takes the role — only a person does, in the manifest
or the settings. A cleared context drops the session only: the tab keeps its history, with a divider
where the context was cleared. With the confirmation on in the settings, every action waits for a
person to allow it, and a refusal reaches the administrator as one.

### On another host

With `"ssh": "user@host"` flotti starts the agent on that host rather than here, and runs it like one
here: start, stop, restart, the restart policy, the heartbeat and the status are the same. It is
`ssh` that flotti starts, with `command` and `arguments` run on the host; ACP goes through the SSH
connection, and so do the commands the agent runs and the files it works with — they are the host's.

```json
{
    "adapter": "codex",
    "command": "npx",
    "arguments": ["-y", "@agentclientprotocol/codex-acp@1.13.1"],
    "ssh": "dev@build.example.org",
    "workdir": "~/projects/app"
}
```

- **Access** is your SSH key, as for [remote agents over SSH](#over-ssh): the `ssh` of this machine
  with your `~/.ssh/config` and agent, never asking anything. Nothing else is set up on the host but
  what the agent needs to run: `npx` in the `PATH` of a non-interactive SSH session, and a login to
  Claude Code or Codex there.
- **`workdir`** is a path on the host — absolute, relative to the home directory there, or starting
  with `~` — and the home directory when the manifest names none. The host says what it is before the
  command starts, because ACP wants an absolute path.
- **`env`** is all the agent gets of an environment besides the host's own: nothing of this machine
  goes along.
- **The fleet tools** go through a reverse tunnel of the same SSH connection: a port the host picks,
  on its loopback, leads to the tools here.
- **What stays here**: the agent directory — the manifest, `logs/`, the history of its tab. The system
  prompt goes along as text; `skills/` and `memory/` do not, and a log event says so.
- **Stop** ends `ssh`; the agent on the host gets the end of its input and goes.

### Lifecycle

The states follow supervisord:

| State      | Meaning                                                                         |
|------------|---------------------------------------------------------------------------------|
| `stopped`  | not started, or stopped by a person                                             |
| `starting` | the process is up; `initialize` and the session are not done yet                |
| `running`  | the session is ready for messages                                               |
| `backoff`  | it stopped when it should not have; flotti waits before the next try            |
| `stopping` | being stopped by a person                                                       |
| `exited`   | it stopped, and `restart` says to leave it so                                   |
| `fatal`    | flotti gave up; only a person starts it again                                   |

- **Restart policy.** `always` restarts after any exit, `on-failure` — after a non-zero exit code, a
  lost heartbeat or a message that would not cancel, `never` — never.
- **Backoff.** The first restart waits 1 s, every next one in a row twice as long, up to 15 s. A
  process that lived 10 s counts as a good start, and the count starts over; the fourth failed start
  in a row is `fatal`. So is a failure a retry cannot fix: a command that does not exist, a login the
  agent wants, a model it refuses.
- **The session survives a restart** when the agent can pick it up: `session/resume`, or else
  `session/load` — the history it replays is not shown again. An agent that can do neither gets a new
  session, and a log event says the context is lost. A message that was in work when the process died
  fails; restarting does not send it again.
- **Heartbeat.** ACP has none, so flotti asks: from the answer to `initialize` on, it sends an
  extension request every third of `heartbeatTimeoutSec`. Any message from the agent counts as a sign
  of life, the "method not found" answer too. Silence longer than `heartbeatTimeoutSec` is a lost
  agent: it is killed, and the policy decides the rest.
- **Messages** sent while the agent is busy wait in line, in memory: a `queued` event says so, and the
  `message` event with the same `messageId` follows once the agent takes it. A stop, a restart or a
  crash drops what waits, and an `unqueued` event says why; so does flotti itself when it starts again
  and finds messages that were in line when it stopped.
- **Cancel** sends `session/cancel` and answers the open permission requests with `cancelled`. An agent
  that does not end the message within 5 s is killed.
- **Stop** cancels the message in work, then ends the process with SIGTERM and, 5 s later, SIGKILL —
  to the whole process group, because the adapter starts `claude` or `codex`, and those start MCP
  servers. **Restart** is stop and start, keeping the session.

### Logs and events

Everything a running agent says is kept in `logs/` of its directory: `acp.jsonl` — every ACP message
both ways, a JSON line each, for debugging an adapter; `stderr.log` — what the agent writes to stderr.
The files grow; nothing rotates them yet.

In code, `LocalAgentProcess` (`src/local-agent.ts`) runs one agent. It is a `FleetAgent`, the same
as a remote agent — see [One interface for every agent](#one-interface-for-every-agent).

## Talking to a remote agent

flotti speaks A2A through the official SDK, [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js),
so the protocol details — transports, the `A2A-Version` header, version 0.3 of the protocol — are the
SDK's and not flotti's. In code it is `A2AAgent` (`src/a2a-agent.ts`), a `FleetAgent` like a local
agent: the dashboard gets the same events and drives it the same way.

- **The card.** It is read from `<url>/.well-known/agent-card.json`, or from `url` itself when that
  names a `.json` file. It is read once on connecting, not before every message: a card whose
  `Cache-Control` says it is fresh is not asked for at all, and after that it is asked for with
  `If-None-Match`. When the card offers an extended card, that one is read too.
- **Versions.** Agents that speak A2A 1.0 and 0.3 both work; the dashboard shows which one is spoken.
  Of the transports, JSON-RPC and HTTP+JSON are used; gRPC is not.
- **Answers.** An agent that can stream answers as it goes. One that cannot is asked for its task every
  two seconds until the task is done.
- **Broken streams.** A stream the agent closes when the task is done or waits for a person is the
  normal end. A stream that breaks off while the task is still going is reconnected to — the message is
  not sent again — up to five times in a row, with growing pauses.
- **Conversation.** Messages to one agent make one conversation. A task that waits for input shows the
  agent as waiting, and the next message answers that task. A message sent while the agent is busy waits
  until it is done.
- **Cancel** cancels the task the agent is working on.
- **Restart.** An agent that declares the [restart extension](https://github.com/micromagicman/flotti/blob/main/docs/a2a-restart.md) is asked to restart
  itself, and flotti reconnects once it is back. Any other agent cannot be restarted from here, so
  for it restart means a new conversation.
- **What the agent says of its own.** An agent that declares the [inbox extension](https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md)
  gets a stream that flotti opens once and keeps open: through it the agent sends messages nobody asked
  for — "the merge request is ready" — and lines about what it is busy with, and they show in its tab
  like any other. A broken inbox is reconnected to for as long as the agent is connected. Without the
  extension an A2A agent has no way to speak first: its tab shows only its answers.
- **Who is in the fleet.** An agent that declares the [fleet extension](https://github.com/micromagicman/flotti/blob/main/docs/a2a-fleet.md) next to the
  inbox gets the roster of the fleet — the same entries `list_agents` gives a local agent, the agents in
  a group with it, its own marked `you` and administrators `admin`, and its groups beside them — with the
  inbox request, and again whenever the fleet or a group changes. So it can write to any peer without
  waiting for that one to write first.

### Over SSH

A remote agent often listens on the loopback of its own machine, reached with SSH. For it the manifest
says `"ssh": "user@host"`, and flotti does the rest with nothing but the user's key:

- **Asks the host** over SSH where the agent listens and which token it expects: the agent's A2A
  adapter publishes both in `~/.flotti/a2a/<id>.json` on its host — the contract is in
  [docs/a2a-ssh.md](https://github.com/micromagicman/flotti/blob/main/docs/a2a-ssh.md). The token stays in memory: it is never written to the manifest,
  a log or the dashboard.
- **Opens the tunnel**: `ssh -N -L` from a free port on `127.0.0.1` to the published address, and sends
  every request to that address — the one the card names too — down the tunnel.
- **Keeps it up.** When the tunnel drops, the agent shows `starting` with the reason while flotti
  tries again and `error` with "trying again in N s" between attempts, with pauses from 1 s to 30 s,
  until it is back or the agent is stopped. A host that is away when flotti starts is tried the same way.
- **Says why it could not**: the key is not accepted (and where the public key goes), the host is not
  known, cannot be reached, or its key changed; the host publishes nothing, or several agents and the
  manifest does not say which.
- **Shows how healthy the connection is** — see below.

SSH runs non-interactively (`BatchMode=yes`) through the `ssh` of this machine, so `~/.ssh/config`,
the SSH agent and the known hosts are the user's own; a host seen for the first time is remembered
(`StrictHostKeyChecking=accept-new`), one whose key changed is refused.

#### The health of the connection

The status says whether the tunnel is up now; the health says whether it is stable. The header of the
agent's tab and its row in **Settings** show, and keep up to date without a reload:

- **latency** — the round trip of a request to the agent down the tunnel: flotti asks for the agent
  card when the tunnel comes up and every 15 s after, with no secret in the request;
- **reconnects** — how many times the tunnel came back after it dropped since the agent was started, how
  many of them in the last hour, and when the last one was;
- **last activity** — when the agent last said something or answered a request;
- **tunnel up** — how long the tunnel that is open now has been up, or `down`.

A connection with 3 or more reconnects in the last hour, or a latency of 1 s or more, is **poor**: the
health turns red and says why, and the tab of the agent says `poor connection`, seen from any tab.
`flotti status` shows the same numbers. The health carries numbers and times only — no address, no
token, no header — and is not written to the history of the tab.

Not done, on purpose:

- **Push notifications.** They need an address the agent can reach, and flotti runs on `localhost`;
  a stream or polling does the same job for the dashboard.
- **Checking the card signature.** The client reports whether the card is signed, but does not verify
  the signature: a key fetched from the address the card itself names proves nothing, and the manifest
  has no field for a key to trust yet.
- **Security schemes of the card.** How flotti proves itself is what the manifest says; the schemes
  the card declares are shown, not acted upon.

## One interface for every agent

The dashboard does not know whether an agent is a local process or a remote service: both are a
`FleetAgent` (`src/agent-events.ts`) — `start`, `send`, `cancel`, `answerPermission`, `restart`, `stop`,
`status` and `subscribe`. `send` resolves once the agent has taken the message; what comes of it arrives
as events. Every event carries the agent id, a `seq` that grows by one per agent — so a consumer can ask
for everything after N — and its time:

| Event        | What it says                                                                                   |
|--------------|------------------------------------------------------------------------------------------------|
| `status`     | `starting`, `idle`, `working`, `waiting`, `error` or `stopped`, and why                        |
| `message`    | a piece of a message: pieces with one `messageId` make one message, `append` adds to its end; `from` — the agent that sent it, when not a person |
| `thought`    | a piece of the agent's reasoning                                                               |
| `progress`   | a line about what the agent is doing, shown in the open                                        |
| `tool-call`  | a tool call started or changed                                                                 |
| `permission` | the agent waits until a person picks an option                                                 |
| `turn-end`   | the agent is done with a message: `end_turn`, `cancelled`, `error`, `input_required`, …        |
| `log`        | a line of diagnostics                                                                          |
| `raw`        | whatever else the protocol said, untouched                                                     |

Events do not have to answer a message: what an agent says or does on its own, between the messages of a
person, comes the same way. A local agent does so with any ACP `session/update` it sends outside a
prompt; a remote one through the [inbox extension](https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md).

A kind of event one protocol has not got simply does not come from it: A2A has no thoughts, tool calls
or permission requests — an A2A agent asks a person by pausing its task, and the next message answers.

## Why JSON

- **Nothing to install.** `JSON.parse` is built into Node.
  YAML or TOML would bring a parser along.
- **The dashboard writes manifests too.** Editing the fleet from the settings page means rewriting
  `agent.json`; JSON survives a read-modify-write untouched, while the comments YAML or TOML would
  allow get lost on such a rewrite anyway.
- **What JSON is bad at is kept out of it.** The long text — the system prompt — lives in its own
  markdown file, and comments live in this README.

## When something is wrong with it

Every case is reported as one sentence naming the file and the place inside it, and ends with a
non-zero exit code — never a stack trace:

| Case                                                   | Example of what flotti prints                                                        |
|--------------------------------------------------------|--------------------------------------------------------------------------------------|
| `--fleet`/`FLOTTI_FLEET` points at nothing             | `Fleet directory not found: …`                                                       |
| A file where an agent directory is expected            | `…/local/claude.json: every agent is a directory with agent.json in it, …`           |
| A directory name that cannot be an id                  | `…/local/my agent: "my agent" cannot be an agent id — …`                              |
| An agent directory without `agent.json`                | `Agent manifest not found: …` plus a manifest to start from                           |
| The manifest may not be read                           | `Agent manifest is not readable (permission denied): …`                               |
| The manifest is not JSON                               | `…/agent.json: the manifest is not valid JSON (Expected double-quoted property name … line 3 …)` |
| A required field is missing                            | `…/agent.json: command is missing (expected a non-empty string)`                      |
| A field has the wrong type                             | `…/agent.json: arguments[1] must be a string, got number`                             |
| The manifest names another id                          | `…/agent.json: id is "claude", but the agent directory is "agent"; …`                 |
| A secret where a variable name is expected             | `…/agent.json: auth.tokenEnv must name an environment variable …`                     |
| A local and a remote agent share an id                 | `…/remote/eva: the id "eva" is already taken by the local agent …`                    |
| A group directory without `group.json`                 | `Group file not found: …` plus a group to start from                                 |
| Something is wrong in a group file                     | `…/groups/release/group.json: members[1] must be an agent id — …`                     |
| The dashboard port is taken                            | `Port 4870 is taken, so the dashboard cannot start.` plus how to pick another         |
| The fleet is already run by another flotti             | `flotti already runs this fleet (process …, dashboard …).`                            |

## Development

```bash
npm test          # compiles with tsc and runs the checks in build-test/
npm run typecheck # the server, the tests and the page
npm run lint
npm run dev:web   # the page with hot reload, talking to a `flotti run` on the default port
npm run test:e2e  # builds, starts flotti with pretend agents and drives the dashboard in Chromium
```

The page is React, built by Vite from `web/` into `build/web`, which the server serves. `test:e2e`
uses Playwright's Chromium — `npx playwright install chromium` once; `FLOTTI_E2E_CHROMIUM=<path>`
points it at another Chromium instead.

The `checks` workflow runs lint, types, the build, `npm test`, `test:e2e` and the validation of the
specs (below) on every pull request and on pushes to `main` and `develop`.

### Specs

What flotti does is written down in [OpenSpec](https://github.com/Fission-AI/OpenSpec) under
`openspec/`: `openspec/specs/<capability>/spec.md` is the record of what is built — the source of
truth for the requirements — and `openspec/changes/<id>/` is a change that is proposed and not built
yet: a proposal with its open questions, a design, the tasks and the deltas to the specs. **A change is
reviewed in a pull request before its implementation starts**; when it ships, it is archived into the
specs. The documents under `docs/` explain and keep the reasons — what was rejected and why — and where
a document and a spec disagree, the spec is right. The specs are in English, like everything else here.

```bash
npx --yes @fission-ai/openspec@1.4.1 validate --all --strict   # what the openspec job of checks runs
npx --yes @fission-ai/openspec@1.4.1 list --specs              # the capabilities
npx --yes @fission-ai/openspec@1.4.1 show <change>             # a change with its deltas
```

The version of the CLI is pinned — in the workflow as one variable — because the rules of validation
move between releases; bumping it is a commit of its own.

### Storybook

The components of the dashboard, each on its own and in every state it has — empty, waiting, in
error, with long names, on a phone, in the dark — with no fleet running:

```bash
npm run storybook        # http://localhost:6006, with hot reload
npm run build-storybook  # static pages in storybook-static/
```

The stories are in `web/stories/`, one file per component, with a pretend fleet in `fleet.ts`; the
setup is in `.storybook/`. The toolbar switches the colour scheme, the language and the width of
the page. A story runs without a server: what calls `/api` — the actions of an agent, its memory —
gets an error back, which is a state of its own.

### Releasing

Bump `version` in `package.json`, merge, then push a tag `v<version>` — the `publish` workflow
checks the tag against `package.json`, builds, runs the tests and publishes to npm with the
`NPM_TOKEN` repository secret. A tag pushed earlier is released by running `publish` by hand
(Actions → publish → Run workflow) with that tag.

## License

flotti is licensed for noncommercial use only, under the
[PolyForm Noncommercial License 1.0.0](LICENSE) (SPDX `PolyForm-Noncommercial-1.0.0`) — from 0.6.0
on. Versions up to and including 0.5.0 were released under ISC and stay under it.
