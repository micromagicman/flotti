# A2A extension: the fleet — who else is there

URI: `https://github.com/micromagicman/flotti/blob/main/docs/a2a-fleet.md`

An agent of the fleet can write to another one through its inbox ([a2a-inbox.md](a2a-inbox.md)): `to`
names the agent. A local agent learns the names with the `list_agents` tool of the fleet MCP server; a
remote one has no such server and, without this extension, learns the id of another agent only when that
one writes to it first. With this extension flotti tells it who it can write to — the agents in a group
with it ([groups.md](groups.md)) — and which groups it is in: when it opens the inbox, and again whenever
that changes. Nothing new to reach, no new secret: it goes the way every other request goes, down the
same SSH tunnel for an agent reached over SSH.

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
        {"id": "builder", "name": "Builder", "kind": "local", "harness": "codex", "status": "working", "admin": true, "groups": ["release"]},
        {"id": "reviewer", "name": "Reviewer", "kind": "remote", "description": "Reviews merge requests", "status": "idle", "groups": ["release"], "you": true}
    ],
    "groups": [
        {"id": "release", "name": "Release 0.6.0", "topic": "Ship 0.6.0.", "members": [{"id": "builder", "name": "Builder"}, {"id": "reviewer", "name": "Reviewer"}]}
    ],
    "text": "The agents of the flotti fleet you can write to — …"
}
```

- `agents` — the agents the roster's agent can write to: the members of every group it is in
  ([groups.md](groups.md)), the agent itself too, in the order of the dashboard; **empty when the agent is
  in no group with anyone**, and `text` says so. `id` is what goes in `to`; `name`, `description` and
  `harness` are there when flotti knows them; `status` is one of `starting`, `idle`, `working`,
  `waiting`, `error`, `stopped`; `groups` — the ids of the groups the two share (the agent's own groups
  on its own entry). `you` marks the entry of the agent the roster is for, `admin` an administrator of
  the fleet — as `list_agents` marks them for a local agent.
- `groups` — the groups the agent is in, as `list_groups` gives them to a local agent: `id`, `name`,
  `topic` when the group has one, and `members` — the id and the name of each member that is in the
  fleet. An adapter written before groups ignores the field and sees a shorter `agents`.
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

An agent comes or goes, is renamed, becomes an administrator or stops being one, its status changes, a
group is made, changed or removed so that what the agent sees changes: flotti gathers the changes for
about a second and sends the whole roster as a `SendMessage` of its own,
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
