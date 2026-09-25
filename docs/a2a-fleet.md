# A2A extension: the fleet — who else is there

URI: `https://github.com/micromagicman/flotti/blob/main/docs/a2a-fleet.md`

An agent of the fleet can write to another one through its inbox ([a2a-inbox.md](a2a-inbox.md)): `to`
names the agent. A local agent learns the names with the `list_agents` tool of the fleet MCP server; a
remote one has no such server and, without this extension, learns the id of another agent only when that
one writes to it first. With this extension flotti tells it who is in the fleet — when it opens the inbox,
and again whenever that changes. Nothing new to reach, no new secret: it goes the way every other request
goes, down the same SSH tunnel for an agent reached over SSH.

## The agent declares it

Next to the inbox, which the roster goes with — an agent without the inbox (or one that cannot stream) is
not sent the roster:

```json
{
    "capabilities": {
        "streaming": true,
        "extensions": [
            {"uri": "https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md", "required": false},
            {"uri": "https://github.com/micromagicman/flotti/blob/main/docs/a2a-fleet.md", "required": false}
        ]
    }
}
```

## The roster

```json
{
    "version": 3,
    "agents": [
        {"id": "builder", "name": "Builder", "kind": "local", "harness": "codex", "status": "working", "admin": true},
        {"id": "reviewer", "name": "Reviewer", "kind": "remote", "description": "Reviews merge requests", "status": "idle", "you": true}
    ],
    "text": "The agents of the fleet flotti runs — …"
}
```

- `agents` — every agent of the fleet, the agent itself too, in the order of the dashboard. `id` is what
  goes in `to`; `name`, `description` and `harness` are there when flotti knows them; `status` is one of
  `starting`, `idle`, `working`, `waiting`, `error`, `stopped`. `you` marks the entry of the agent the
  roster is for, `admin` an administrator of the fleet — as `list_agents` marks them for a local agent.
- `version` — grows with every roster flotti sends the agent. The roster is whole every time: the agent
  keeps the one with the greatest version and drops the one before.
- `text` — the same as text, ready to be handed to a model as it is.

## With the inbox request

When flotti opens the inbox — after start, every restart and every reconnect — the roster goes in the
metadata of the inbox request, as `fleet` beside `action`, and the message and the `A2A-Extensions`
header name both extensions:

```json
{
    "message": {
        "messageId": "…",
        "role": "ROLE_USER",
        "parts": [{"text": "flotti listens for what you say of your own."}],
        "extensions": [
            "https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md",
            "https://github.com/micromagicman/flotti/blob/main/docs/a2a-fleet.md"
        ],
        "metadata": {
            "https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md": {
                "action": "subscribe",
                "fleet": {"version": 1, "agents": […], "text": "…"}
            }
        }
    }
}
```

An agent that declares the inbox only gets the inbox request as it was, with no `fleet` in it.

## When the fleet changes

An agent comes or goes, is renamed, becomes an administrator or stops being one, its status changes:
flotti gathers the changes for about a second and sends the whole roster as a `SendMessage` of its own,
with this extension in the `A2A-Extensions` header and the roster in the metadata beside
`"action": "fleet"`:

```json
{
    "message": {
        "messageId": "…",
        "role": "ROLE_USER",
        "parts": [{"text": "The fleet changed; the roster is in the metadata."}],
        "extensions": ["https://github.com/micromagicman/flotti/blob/main/docs/a2a-fleet.md"],
        "metadata": {
            "https://github.com/micromagicman/flotti/blob/main/docs/a2a-fleet.md": {
                "action": "fleet", "version": 4, "agents": […], "text": "…"
            }
        }
    }
}
```

The request belongs to no conversation — no `contextId`, no `taskId` — and is no message of a person: the
agent keeps the roster and does not start a turn on it. flotti does not wait for it in the line of
messages, does not show it in the tab, and reads nothing of the answer: a completed task or a message
will do. A roster that did not go through is a line in the tab and is not sent again; the next change
sends the whole roster anew. Nothing is sent when nothing the agent sees changed.
