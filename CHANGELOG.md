# Changelog

All notable changes to flotti are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[0.1.0]: https://github.com/micromagicman/flotti/releases/tag/v0.1.0
