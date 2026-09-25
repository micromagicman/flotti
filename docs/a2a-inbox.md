# A2A extension: the inbox — what the agent says of its own

URI: `https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md`

In A2A the client speaks first: an agent answers a message, and between the answers it has no way to
reach the client. An agent that works on its own — says "the merge request is ready", asks for an
answer, reports what it is busy with — needs one. Push notifications would do, but they need an address
the agent can reach, and flotti runs on `localhost`, often behind a tunnel that only goes the other way.

This extension turns it around: flotti opens a stream to the agent once, and keeps it open; the agent
says through it whatever it wants to say of its own. It is an ordinary A2A streaming message and an
ordinary task: no new method, nothing the SDKs do not already carry, and the connection goes the way
every other request goes — same address, same credentials, and down the same SSH tunnel for an
agent reached over SSH ([a2a-ssh.md](a2a-ssh.md)); when the tunnel is opened again after a drop, so is
the inbox.

## The agent declares it

In its agent card, next to `"streaming": true` — the inbox is a stream, and an agent that cannot stream
is not asked for it:

```json
{
    "capabilities": {
        "streaming": true,
        "extensions": [
            {"uri": "https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md", "required": false}
        ]
    }
}
```

## flotti opens the inbox

Once connected — after start and after every restart — flotti sends `SendStreamingMessage`, with the
extension named in the `A2A-Extensions` header and the request in the message metadata:

```json
{
    "message": {
        "messageId": "…",
        "role": "ROLE_USER",
        "parts": [{"text": "flotti listens for what you say of your own."}],
        "extensions": ["https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md"],
        "metadata": {
            "https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md": {"action": "subscribe"}
        }
    }
}
```

The message belongs to no conversation: no `contextId`, no `taskId`. The agent must not take the text
for a person's words.

## The agent keeps it open

The agent answers with a task in the `working` state — the **inbox task** — and does not end it. Every
time it has something to say of its own, it sends a `statusUpdate` of that task, state still `working`,
with the message in `status.message`. Artifacts of the inbox task are shown like those of any task.

The message may say what it is, under the extension URI in its own metadata:

```json
{
    "messageId": "…",
    "role": "ROLE_AGENT",
    "parts": [{"text": "Running the tests"}],
    "metadata": {
        "https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md": {"kind": "progress", "busy": true}
    }
}
```

- `kind` — `message` (the default) is a message of the agent, shown in its tab like an answer;
  `progress` is a line about what the agent is doing, shown as such and not as a message; `admin` is a
  request of an administrator of the fleet, below.
- `busy` — optional: `true` when the agent is busy on its own, `false` when it is done. The tab shows
  the agent as working in between. A message from a person has the last word while it is being worked on.
- `to` — optional: the id of another agent of the fleet (the name of its directory) the message is for;
  who is in the fleet the agent learns through [the fleet extension](a2a-fleet.md).
  flotti sends the text on to that agent as a message from this one — see below — and shows it in this
  agent's tab as sent there. A message that cannot be delivered — no such agent, the agent is stopped —
  is a line in this agent's tab saying why; the agent itself is not told. `to` goes with `kind: message`
  only.
- `task` — optional, with `to`: the message gives that agent a task, and the outcome comes back — see
  "Tasks" below. An object; `deadline` in it is an optional ISO 8601 time the task is to be done by. The
  `messageId` of the message is the id of the task.
- `cancel` — optional: the id of a task this agent gave, to take it back. The text of such a message is
  not shown.

Anything else in the metadata is ignored for now.

## Messages from other agents

A message one agent of the fleet sent to another reaches an A2A agent as an ordinary message, with the
sender under the extension URI in its metadata — `from` is the id of the sending agent, the one to put
in `to` to answer it:

```json
{
    "messageId": "…",
    "role": "ROLE_USER",
    "parts": [{"text": "The snapshot test fails, please rerun it after the fix."}],
    "extensions": ["https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md"],
    "metadata": {
        "https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md": {"from": "reviewer"}
    }
}
```

It goes in line with the messages of a person and belongs to the same conversation. What the agent
answers in the task of that message goes back to the sender by itself — the text of its messages in
that turn, not its progress lines, and nothing for a cancelled task — so the agent does not have to send
it with `to`. The sender gets it as a message from this agent that quotes the message answered
(`In reply to a message from you: …`); an answer gets no answer back by itself. The inbox request
is told from it by `"action": "subscribe"`, not by the extension URI alone. An agent that does
not declare this extension gets the sender in the text as well, as `[from reviewer] …`; so does a local
agent over ACP, which has no place for it otherwise. The dashboard shows the message in the receiver's
tab on the person's side, marked with the sender.

Each message needs a `messageId` of its own: flotti shows a message once, and a snapshot of the task —
after a reconnect — repeats the history.

## Tasks

A message with `to` and `task` gives the other agent a task (#51):

```json
{
    "messageId": "task-1",
    "role": "ROLE_AGENT",
    "parts": [{"text": "Collect the failing tests and list them"}],
    "metadata": {
        "https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md": {"to": "tester", "task": {"deadline": "2026-09-24T18:00:00Z"}}
    }
}
```

The task reaches the other agent as a message from this one, with `task` — `id` and, when given,
`deadline` — beside `from`, and the text says that what it answers in that turn is the result. How the
turn ends is how the task ends: a completed task is `completed`, with what the agent answered; a
cancelled one `canceled`; a failed or rejected one `failed`. A turn that pauses for input goes on with
the answer. The outcome comes back to this agent by itself, as a message from the other one that quotes
the task, with `task` — `id` and `state` — under the extension URI:

```json
"metadata": {
    "https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md": {"from": "tester", "task": {"id": "task-1", "state": "completed"}}
}
```

A task that cannot be given — no such agent, the agent is stopped — comes back `failed` at once, with
why in the text; so does one not done by its deadline, and the agent working on it is told to stop. To
take a task back, send a message with `{"cancel": "task-1"}`: the task leaves the line of the other
agent, or its turn is cancelled, and no outcome comes back for it. The tabs of both agents show the task
and where it stands.

## Requests of an administrator

An agent that is an administrator of the fleet (`"admin": true` in its manifest) asks flotti to restart
an agent or clear its context with a message of `kind: admin` — `action` is `restart` or
`clear-context`, `agent` the id of the agent, which may be its own:

```json
{
    "messageId": "…",
    "role": "ROLE_AGENT",
    "parts": [{"text": ""}],
    "metadata": {
        "https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md": {"kind": "admin", "action": "clear-context", "agent": "reviewer"}
    }
}
```

The request is not a message: the tab does not show its text, and `busy` and `to` are not read with it.
flotti takes it once per `messageId`, checks that the agent is an administrator and does it; the tabs of
both agents show the action. A request that is refused — the agent is not an administrator, a person
refused it, there is no such agent — or that failed comes back to the agent as a message,
`[flotti] Refused: …`, since there is no call to answer. A request on itself is done once the turn the
agent is in is over. A request with an `action` or `agent` flotti does not know is a line in the tab,
and nothing else.

`clear-context` means the next message to the agent goes with a new `contextId` — a new conversation,
without the old history; a task in work is cancelled. What the agent keeps under the old `contextId` is
its own business.

## When the stream breaks

flotti asks for the task with `GetTask` — what the agent said meanwhile is in its status and history —
and goes on with `SubscribeToTask`. The agent does not have to hold what was said while nobody listened
beyond what the task itself keeps. A task the agent does not know any more — it restarted — is replaced
by a new inbox, and flotti keeps trying, with growing pauses, as long as the agent is connected.

## Closing it

- **flotti** closes the stream when the agent is stopped or restarted. The agent should drop the inbox
  task then, or keep it until it is asked for again — either way flotti opens a new one next time.
- **The agent** may end the inbox task as `completed` or `canceled` — when it is going away, say: flotti
  opens a new one. An agent that does not want flotti in its inbox ends the task as `rejected` or
  `failed`; the text of the status message is the reason, flotti shows it and does not ask again until
  the next start.
