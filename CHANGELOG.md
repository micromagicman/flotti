# Changelog

All notable changes to flotti are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Remote agents over SSH, in one step.** Settings → **Connect over SSH** takes `user@host` and
  nothing else: flotti asks the host which agents it publishes, adds them, opens an SSH tunnel to each
  one with the published token and keeps it up, reopening it after a drop. The dashboard shows the
  state of the connection and why it failed. In a manifest, `"ssh": "user@host"` takes the place of
  `url`; the contract for agents is in [docs/a2a-ssh.md](docs/a2a-ssh.md) (#22).

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
