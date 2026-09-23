# supavisor

Simple ai agents orchestrator for humans.

At this point supavisor **reads and checks** its fleet — the agents it is going to work with — and
talks to them: it **runs a local agent** over ACP (starts it, talks to it, restarts it when it falls
over) and **talks to a remote agent** over A2A (see [Talking to a remote agent](#talking-to-a-remote-agent)).
Both are driven by code for now; the dashboard is the next step of the `v0.1.0` milestone, and reading
the fleet starts nothing by itself.

## Requirements

Node.js 20.11 or newer.

## Build and run

```bash
npm ci
npm run build
node build/index.js [--fleet <dir>]
```

`node build/index.js` prints the agents it found and exits with `0`; on any problem with the fleet it
prints one sentence explaining it and exits with a non-zero code.

## The fleet

Every agent is a directory, and the directory name is the agent id:

```
~/.supavisor/agents/
├── local/                  agents supavisor starts itself
│   └── claude/
│       ├── agent.json      the manifest
│       ├── system-prompt.md  optional
│       ├── skills/         the agent's own skills
│       └── memory/         the agent's memory bank: markdown notes linked with [[…]]
└── remote/                 agents that run elsewhere, reached over A2A
    └── eva/
        └── agent.json
```

- An id is letters, digits, `.`, `_` and `-`, starting with a letter or a digit. Ids are shared by
  local and remote agents: `local/eva` and `remote/eva` cannot live in one fleet.
- Entries whose names start with `.` are skipped, so `.DS_Store` and the like do no harm. Anything else
  in `local/` or `remote/` must be an agent directory.
- `local/` and `remote/` may be absent — that group is simply empty.
- `skills/` and `memory/` belong to the agent: supavisor creates them when they are missing and never
  reads them. It hands them to the agent, as told in [Running a local agent](#running-a-local-agent).
- `logs/` is where supavisor keeps what a running agent said; see the same section.

### Where the fleet comes from

The first of these that is set wins:

1. `--fleet <dir>` (also `--fleet=<dir>`);
2. the `SUPAVISOR_FLEET` environment variable;
3. `~/.supavisor/agents` — the default.

Pointing at another directory is how tests and several fleets on one machine keep apart. A leading `~`
is expanded by supavisor itself, from `HOME` (or `USERPROFILE` on Windows), because under `npx` there
is no shell to do it. A relative path is resolved against the current directory.

A missing default directory is an empty fleet — that is what the first run looks like. A missing
directory named by `--fleet` or `SUPAVISOR_FLEET` is an error: it is most likely a typo.

## The manifest: `agent.json`

JSON, and JSON has no comments — so the fields are explained here rather than in the file. Fields
supavisor does not know are ignored, so a manifest written for a later version still works with this
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
| `adapter`             | no       | `claude-code`, `codex`          | —                              | Which ACP adapter `command` starts, so supavisor knows how to hand over the model, the system prompt and the skills. Without it the agent gets plain ACP only. |
| `model`               | no       | non-empty string                | the adapter's own default      | Model the agent is asked to use.                                                 |
| `workdir`             | no       | non-empty string                | the agent directory            | Directory the agent is started in; a relative one is taken from the agent directory, `~` is expanded. |
| `env`                 | no       | object of strings               | `{}`                           | Variables added to the agent environment.                                        |
| `restart`             | no       | `always`, `on-failure`, `never` | `on-failure`                   | What to do when the agent stops.                                                 |
| `heartbeatTimeoutSec` | no       | positive number                 | `60`                           | Seconds without a heartbeat before the agent counts as lost.                      |

The system prompt is not a field: it is the file `system-prompt.md` next to the manifest. A prompt is
prose, often long, and a JSON string is a poor place to write prose in.

What supavisor does with `adapter`, `model`, `restart` and `heartbeatTimeoutSec` is in
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
| `url`         | yes      | `http:` or `https:` address | —       | Where the agent is.                             |
| `protocol`    | no       | `a2a`            | `a2a`              | How to talk to it; A2A is the only one for now.  |
| `auth`        | no       | object, below    | `{"type": "none"}` | How supavisor proves itself to the agent.        |
| `name`        | no       | non-empty string | the id             | Name shown to people.                            |
| `description` | no       | non-empty string | —                  | One line about the agent.                        |
| `id`          | no       | non-empty string | —                  | If given, must equal the directory name.         |

`auth` is one of:

- `{"type": "none"}`;
- `{"type": "bearer", "tokenEnv": "<variable>"}` — sends `Authorization: Bearer <value of the variable>`;
- `{"type": "api-key", "header": "<header>", "valueEnv": "<variable>"}` — sends the value of the
  variable in that header.

The manifest names the environment variable that holds the secret, never the secret itself: manifests
are plain files, they get copied, shown in the dashboard and edited by it. supavisor reads the variable
when it connects; a value that does not look like a variable name is refused.

## Running a local agent

supavisor starts `command` with `arguments` in `workdir` as a child process and talks
[ACP](https://agentclientprotocol.com) to it over stdio: `initialize`, then one session, then a
`session/prompt` for every message. Claude Code and Codex speak ACP through adapters:

| Agent       | `adapter`     | `command` and `arguments`                                          |
|-------------|---------------|--------------------------------------------------------------------|
| Claude Code | `claude-code` | `npx`, `["-y", "@agentclientprotocol/claude-agent-acp@0.81.1"]`    |
| Codex       | `codex`       | `npx`, `["-y", "@agentclientprotocol/codex-acp@1.13.1"]`           |

Pin the adapter version: adapters move and change — both have already changed their package names
once. Keep `-y`: without it `npx` asks whether to install, and it asks on stdin, which belongs to ACP.
Log in to Claude Code or Codex the usual way before: supavisor keeps no keys, and an agent that wants a
login stops at once with a message saying so.

### What the agent gets from its directory

ACP has a standard way for the model only; the system prompt and the skills each adapter takes its own
way, so supavisor needs `adapter` to know which.

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

### Lifecycle

The states follow supervisord:

| State      | Meaning                                                                         |
|------------|---------------------------------------------------------------------------------|
| `stopped`  | not started, or stopped by a person                                             |
| `starting` | the process is up; `initialize` and the session are not done yet                |
| `running`  | the session is ready for messages                                               |
| `backoff`  | it stopped when it should not have; supavisor waits before the next try         |
| `stopping` | being stopped by a person                                                       |
| `exited`   | it stopped, and `restart` says to leave it so                                   |
| `fatal`    | supavisor gave up; only a person starts it again                                |

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
- **Heartbeat.** ACP has none, so supavisor asks: from the answer to `initialize` on, it sends an
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

supavisor speaks A2A through the official SDK, [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js),
so the protocol details — transports, the `A2A-Version` header, version 0.3 of the protocol — are the
SDK's and not supavisor's. In code it is `A2AAgent` (`src/a2a-agent.ts`), a `FleetAgent` like a local
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
  itself, and supavisor reconnects once it is back. Any other agent cannot be restarted from here, so
  for it restart means a new conversation.

Not done, on purpose:

- **Push notifications.** They need an address the agent can reach, and supavisor runs on `localhost`;
  a stream or polling does the same job for the dashboard.
- **Checking the card signature.** The client reports whether the card is signed, but does not verify
  the signature: a key fetched from the address the card itself names proves nothing, and the manifest
  has no field for a key to trust yet.
- **Security schemes of the card.** How supavisor proves itself is what the manifest says; the schemes
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
| `message`    | a piece of a message: pieces with one `messageId` make one message, `append` adds to its end   |
| `thought`    | a piece of the agent's reasoning                                                               |
| `tool-call`  | a tool call started or changed                                                                 |
| `permission` | the agent waits until a person picks an option                                                 |
| `turn-end`   | the agent is done with a message: `end_turn`, `cancelled`, `error`, `input_required`, …        |
| `log`        | a line of diagnostics                                                                          |
| `raw`        | whatever else the protocol said, untouched                                                     |

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

| Case                                                   | Example of what supavisor prints                                                     |
|--------------------------------------------------------|--------------------------------------------------------------------------------------|
| `--fleet`/`SUPAVISOR_FLEET` points at nothing          | `Fleet directory not found: …`                                                       |
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

## Development

```bash
npm test        # compiles with tsc and runs the checks in build-test/
npm run typecheck
```
