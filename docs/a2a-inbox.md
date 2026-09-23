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
  `progress` is a line about what the agent is doing, shown as such and not as a message.
- `busy` — optional: `true` when the agent is busy on its own, `false` when it is done. The tab shows
  the agent as working in between. A message from a person has the last word while it is being worked on.
- `to` — optional: the id of another agent of the fleet (the name of its directory) the message is for.
  flotti sends the text on to that agent as a message from this one — see below — and shows it in this
  agent's tab as sent there. A message that cannot be delivered — no such agent, the agent is stopped —
  is a line in this agent's tab saying why; the agent itself is not told. `to` goes with `kind: message`
  only.

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

It goes in line with the messages of a person and belongs to the same conversation. The inbox request
is told from it by `"action": "subscribe"`, not by the extension URI alone. An agent that does
not declare this extension gets the sender in the text as well, as `[from reviewer] …`; so does a local
agent over ACP, which has no place for it otherwise. The dashboard shows the message in the receiver's
tab on the person's side, marked with the sender.

Each message needs a `messageId` of its own: flotti shows a message once, and a snapshot of the task —
after a reconnect — repeats the history.

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
