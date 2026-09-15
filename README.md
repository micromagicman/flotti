# supavisor

Simple ai agents orchestrator for humans.

At this point supavisor **reads and checks** the list of agents it is going to supervise. Starting the
agents, heartbeats, restarts and remote machines are the next steps of the `v0.1.0` milestone; reading
the configuration starts nothing by itself.

## Requirements

Node.js 20.11 or newer.

## Build and run

```bash
npm ci
npm run build
node build/index.js [--config <path>]
```

`node build/index.js` prints the agents it found and exits with `0`; on any problem with the
configuration it prints one sentence explaining it and exits with a non-zero code.

## Where the configuration comes from

The first of these that is set wins:

1. `--config <path>` (also `--config=<path>`);
2. the `SUPAVISOR_CONFIG` environment variable;
3. `~/.config/supavisor/configuration.json` — the default.

A leading `~` is expanded by supavisor itself, from `HOME` (or `USERPROFILE` on Windows), because
under `npx` there is no shell to do it. A relative path is resolved against the current directory.

## Configuration file

JSON, and JSON has no comments — so the fields are explained here rather than in the file. A minimal
configuration:

```json
{
    "agents": [
        {
            "name": "claude",
            "command": "claude",
            "arguments": ["-p", "Hello, claude!"]
        }
    ]
}
```

`agents` is a non-empty array of agents. Agent names must be unique — they are how an agent is
referred to in logs and, later, in commands.

| Field                 | Required | Type                     | Default                          | Meaning                                                                  |
|-----------------------|----------|--------------------------|----------------------------------|--------------------------------------------------------------------------|
| `name`                | yes      | non-empty string         | —                                | Unique name of the agent.                                                 |
| `command`             | yes      | non-empty string         | —                                | Executable to run.                                                        |
| `arguments`           | yes      | array of strings         | —                                | Arguments for the executable; use `[]` for none.                          |
| `workdir`             | no       | non-empty string         | supavisor's own working directory | Directory the agent is started in.                                        |
| `env`                 | no       | object of strings        | `{}`                             | Variables added to the agent environment.                                 |
| `restart`             | no       | `always`, `on-failure`, `never` | `on-failure`              | What to do when the agent stops.                                          |
| `heartbeatTimeoutSec` | no       | positive number          | `60`                             | Seconds without a heartbeat before the agent counts as lost.               |

`restart` and `heartbeatTimeoutSec` are read and checked now so that the file format does not change
again when restarts and heartbeats arrive; nothing acts on them yet.

A full example:

```json
{
    "agents": [
        {
            "name": "claude",
            "command": "claude",
            "arguments": ["-p", "Hello, claude!"]
        },
        {
            "name": "codex",
            "command": "codex",
            "arguments": ["--full-auto"],
            "workdir": "/srv/app",
            "env": {"OPENAI_API_KEY": "..."},
            "restart": "always",
            "heartbeatTimeoutSec": 15
        }
    ]
}
```

Fields supavisor does not know are ignored, so a configuration written for a later version still
works with this one.

## When something is wrong with it

Every case is reported as one sentence naming the file and the place inside it, and ends with a
non-zero exit code — never a stack trace:

| Case                                              | Example of what supavisor prints                                                     |
|---------------------------------------------------|--------------------------------------------------------------------------------------|
| The file does not exist (the usual first run)     | `Configuration file not found: …` plus a sample configuration to start from           |
| The file may not be read                          | `Configuration file is not readable (permission denied): …`                           |
| The file is not JSON                              | `…: the file is not valid JSON (Expected double-quoted property name … line 3 …)`      |
| A required field is missing                       | `…: agents[1].command is missing (expected a non-empty string)`                        |
| A field has the wrong type                        | `…: agents[0].arguments[1] must be a string, got number`                               |
| Two agents share a name                           | `…: agents[1].name repeats the name "claude" of agents[0]`                             |
| The agents list is empty                          | `…: agents must list at least one agent`                                               |

## Development

```bash
npm test        # compiles with tsc and runs the checks in build/
npm run typecheck
```
