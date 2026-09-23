# Reaching an A2A agent over SSH

A remote agent usually listens on the loopback of its own machine, and the machine is reached with
SSH. Before, a person had to open the tunnel (`ssh -N -L …`), keep it open, and copy the agent's
bearer token into an environment variable of the flotti machine. Now flotti does all of it; the
person gives `user@host`, and their public key is already on the host.

What makes that possible is this contract: **the agent publishes, on its own host, where it listens
and which token it expects**, in a file flotti reads over SSH.

## The agent publishes itself

When its A2A server is up, the agent (its A2A adapter) writes one file per agent into the home
directory of the SSH user:

```
~/.flotti/a2a/<id>.json
```

```json
{
    "name": "Eva",
    "description": "AI teammate of the team",
    "url": "http://127.0.0.1:18741/",
    "token": "<the bearer token the A2A server expects>"
}
```

| Field         | Required | Meaning                                                                        |
|---------------|----------|--------------------------------------------------------------------------------|
| `url`         | yes      | Where the A2A server listens, as seen **from that host** — usually its loopback. |
| `token`       | no       | Bearer token the server expects; flotti sends `Authorization: Bearer <token>`. Leave it out for a server that expects none. |
| `name`        | no       | Name shown in the dashboard; the id when absent.                               |
| `description` | no       | One line about the agent.                                                      |

- `<id>` — letters, digits, `.`, `_`, `-`, starting with a letter or a digit — becomes the id of the
  agent in the fleet, unless the fleet already has one of that name.
- **The file holds a secret**: write it with mode `0600` (and the directory with `0700`), and write it
  atomically — to a temporary file first, then rename — so flotti never reads half of it.
- Rewrite it whenever the port or the token changes; flotti reads it again every time the tunnel is
  opened, so a new token is picked up after the next reconnect.
- Removing the file when the agent goes away is polite, not required: flotti reports an agent that
  does not answer either way.
- The card of the agent may name the same loopback address in its interfaces: flotti sends requests
  to that address down the tunnel, so the card does not have to know about the tunnel.

## What flotti does

For an agent with `"ssh": "user@host"` in its manifest (or `{"target": "user@host", "agent": "<id>"}`
when the host publishes several):

1. Runs `ssh user@host` with a POSIX `sh` command that prints every `~/.flotti/a2a/*.json`. SSH runs
   with `BatchMode=yes` — no password prompts, the key or nothing — and
   `StrictHostKeyChecking=accept-new`: a host seen for the first time is remembered, a host whose key
   changed is refused.
2. Picks the agent, and opens `ssh -N -L 127.0.0.1:<free port>:<host>:<port> user@host` to the `url`
   it publishes, with `ExitOnForwardFailure` and a keep-alive (`ServerAliveInterval=15`,
   `ServerAliveCountMax=3`), so a silent host is noticed in under a minute.
3. Talks A2A to the agent through the tunnel, with the published token. The token lives in memory
   only: it is not written to the manifest, the logs or the dashboard.
4. When the tunnel drops, flotti opens it again — asking the host once more — until it is back or
   the agent is stopped. The agent shows `starting` with the reason while it tries, and `error` with
   the reason of the failed attempt and "trying again in N s" between attempts; the pauses grow from
   1 s to 30 s. A host that cannot be reached when flotti starts is tried again the same way.

Everything goes through the `ssh` of the flotti machine, so `~/.ssh/config` (ports, jump hosts, which
key), the SSH agent and the known hosts are the person's own.

## Adding it from the dashboard

**Settings → Connect over SSH**: `user@host`, **Connect**. flotti asks the host what it publishes and
adds every agent it does not have yet as a remote agent over SSH, starting it at once. When it cannot
— the key is not accepted, the host is unknown or unreachable, nothing is published — the form says
which, and nothing is written.
