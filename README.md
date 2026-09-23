# flotti

Simple ai agents orchestrator for humans.

flotti runs a fleet of AI agents and gives you one page to work with them: a tab per agent with its
status and live output, a field to write to it, a button to restart it, and a broadcast to write to
all of them at once. It **runs local agents** over ACP (starts them, talks to them, restarts them when
they fall over) and **talks to remote agents** over A2A (see
[Talking to a remote agent](#talking-to-a-remote-agent)).

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
  agent; the harness is `-` where flotti does not know it (see [A local agent](#a-local-agent)):

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
  `adapter` of its manifest. A local agent with no `adapter` and a remote agent do not tell which
  harness runs them, and the header says `harness unknown` rather than guess.
- **Inside the tab**: the agent's output as it comes — messages, collapsed reasoning, tool calls with
  their progress, permission requests with the options the agent offered, diagnostics, and whatever
  else the protocol said, raw and collapsed. Below it, a field to write to the agent: Enter sends,
  Shift+Enter makes a new line. A message to a busy agent waits in line, and the field says so.
  **Restart** restarts the agent — a local one keeps its session when it can, a remote one is asked to
  restart itself or starts a new conversation (see [Lifecycle](#lifecycle) and
  [Talking to a remote agent](#talking-to-a-remote-agent)); **Stop** stops it until **Start** starts it
  again; **Cancel** drops the message in work.
- **All agents** sends one message to every agent you leave ticked. Each gets it on its own, so an
  agent that is down or busy holds nobody up; the page shows, agent by agent, whether the message was
  delivered, waits in line or failed, and the answers come in each agent's tab.
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
- **Fleet directory.** Shows the directory the run works with and where it came from. **Switch** points
  the run at another one: the agents of the old fleet stop, those of the new one start, and
  `.flotti-run.json` moves along so `flotti stop` still finds the run. A directory that is not there
  yet is created — that is how a new fleet begins; one with a broken manifest is refused, and nothing
  changes. The choice is saved in `~/.flotti/settings.json`, and the next `flotti run` opens it.

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
| `GET /api/agents`                             | the agents and their statuses                          |
| `POST /api/agents/<id>/messages` `{text}`     | a message to one agent: `taken`, `queued` or `failed`  |
| `POST /api/broadcast` `{text, agents?}`       | one message to these agents, or to all; a result each  |
| `POST /api/agents/<id>/restart`               | restarts the agent; answers at once, the status follows |
| `POST /api/agents/<id>/cancel`                | drops the message in work                              |
| `POST /api/agents/<id>/start`, `…/stop`       | starts or stops the agent; start answers at once        |
| `POST /api/agents` `{kind, id, …}`            | a new agent: writes its directory and starts it         |
| `POST /api/ssh-agents` `{target}`             | adds the agents `user@host` publishes, reached over SSH |
| `GET /api/agents/<id>`                        | its manifest as the file says it, and its system prompt |
| `PUT /api/agents/<id>` `{kind, id, …}`        | a changed manifest: writes it and restarts the agent    |
| `DELETE /api/agents/<id>`                     | stops the agent and moves its directory to `.trash/`    |
| `GET /api/fleet`, `PUT /api/fleet` `{path}`   | the fleet directory; switches to another one            |
| `POST /api/agents/<id>/permissions/<request>` `{optionId?}` | answers a permission request; no option refuses it |
| `/ws`                                         | `fleet` first, and again on every change of the fleet; the page answers `subscribe` with the last number it has seen of each agent, and gets the events after them, then live ones |

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
└── remote/                 agents that run elsewhere, reached over A2A
    └── eva/
        ├── agent.json
        └── .flotti-history.jsonl
```

- An id is letters, digits, `.`, `_` and `-`, starting with a letter or a digit. Ids are shared by
  local and remote agents: `local/eva` and `remote/eva` cannot live in one fleet.
- Entries whose names start with `.` are skipped, so `.DS_Store` and the like do no harm. Anything else
  in `local/` or `remote/` must be an agent directory.
- `local/` and `remote/` may be absent — that group is simply empty.
- `skills/` and `memory/` belong to the agent: flotti creates them when they are missing and never
  reads them. It hands them to the agent, as told in [Running a local agent](#running-a-local-agent).
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
| `list_agents`  | the agents of the fleet — id, name, description, harness, status; the caller is marked `you` |
| `send_message` | sends a message to another agent: `to` — its id, `text`                                |
| `reply`        | answers the agent whose message came last                                             |
| `forward`      | forwards the last message another agent sent, as it was, to another agent; `comment` goes before it |

A message sent so reaches the other agent like one from a person, but from that agent: its `message`
event has `from` — the sender's id — and the agent is told who wrote and how to answer. What it says in
its turn goes to its own tab, not back to the sender: an answer to an agent is a `send_message` too.
Messages queue as a person's do; a tool call does not wait for the answer.

The server speaks MCP over HTTP (the streamable transport, with plain JSON answers) on a free port of
`127.0.0.1`, and every agent gets a token of its own in the `Authorization` header: the token tells who
is sending, and without one of the fleet's tokens the server answers nothing. HTTP is the transport
both adapters take — claude-agent-acp 0.81.1 declares `mcpCapabilities` `http` and `sse`, codex-acp
1.13.1 `http` only, and both take `stdio`, which ACP requires of every agent — and the one an SSH
tunnel carries to an agent on another host. An agent that declares no `http` gets no tools, and a log
event says so. A remote A2A agent — one with a loop of its own — gets no tools; a message from an agent
reaches it with a line saying who wrote.

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
- **Messages** sent while the agent is busy wait in line.
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
- **Restart.** An agent that declares the [restart extension](docs/a2a-restart.md) is asked to restart
  itself, and flotti reconnects once it is back. Any other agent cannot be restarted from here, so
  for it restart means a new conversation.
- **What the agent says of its own.** An agent that declares the [inbox extension](docs/a2a-inbox.md)
  gets a stream that flotti opens once and keeps open: through it the agent sends messages nobody asked
  for — "the merge request is ready" — and lines about what it is busy with, and they show in its tab
  like any other. A broken inbox is reconnected to for as long as the agent is connected. Without the
  extension an A2A agent has no way to speak first: its tab shows only its answers.

### Over SSH

A remote agent often listens on the loopback of its own machine, reached with SSH. For it the manifest
says `"ssh": "user@host"`, and flotti does the rest with nothing but the user's key:

- **Asks the host** over SSH where the agent listens and which token it expects: the agent's A2A
  adapter publishes both in `~/.flotti/a2a/<id>.json` on its host — the contract is in
  [docs/a2a-ssh.md](docs/a2a-ssh.md). The token stays in memory: it is never written to the manifest,
  a log or the dashboard.
- **Opens the tunnel**: `ssh -N -L` from a free port on `127.0.0.1` to the published address, and sends
  every request to that address — the one the card names too — down the tunnel.
- **Keeps it up.** When the tunnel drops, the agent shows `starting` with the reason while flotti
  tries again and `error` with "trying again in N s" between attempts, with pauses from 1 s to 30 s,
  until it is back or the agent is stopped. A host that is away when flotti starts is tried the same way.
- **Says why it could not**: the key is not accepted (and where the public key goes), the host is not
  known, cannot be reached, or its key changed; the host publishes nothing, or several agents and the
  manifest does not say which.

SSH runs non-interactively (`BatchMode=yes`) through the `ssh` of this machine, so `~/.ssh/config`,
the SSH agent and the known hosts are the user's own; a host seen for the first time is remembered
(`StrictHostKeyChecking=accept-new`), one whose key changed is refused.

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
prompt; a remote one through the [inbox extension](docs/a2a-inbox.md).

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

The `checks` workflow runs lint, types, the build, `npm test` and `test:e2e` on every pull request
and on pushes to `main` and `develop`.

### Releasing

Bump `version` in `package.json`, merge, then push a tag `v<version>` — the `publish` workflow
checks the tag against `package.json`, builds, runs the tests and publishes to npm with the
`NPM_TOKEN` repository secret. A tag pushed earlier is released by running `publish` by hand
(Actions → publish → Run workflow) with that tag.
