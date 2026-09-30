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
- `to` — optional, with `task` and `group` only: the id of the member of the group that does the task
  (the name of its directory, as the roster of [the fleet extension](a2a-fleet.md) gives it) — see
  "Tasks" below. **Since 0.7.0 a message between agents goes through a group only** (the OpenSpec change
  [groups-only](../openspec/changes/groups-only/proposal.md), #171): `to` with `kind: message` and no
  `task` is refused — a line in this agent's tab, `could not deliver the message to "x": a message to
  another agent goes through a group; name it in "group"` — and the agent is not told. A message for one
  member of the group names it in the text, `@<id>` (#174, below).
- `group` — optional: the id of a group of the fleet the agent is in ([groups.md](groups.md)) the
  message, or the task, is posted to. flotti sends the text to every other
  member of the group, each on its own, as a message from this agent — see below — writes it to the
  history of the group with how each member took it — a member that was busy as `queued`, corrected to
  `taken` or `failed` once that delivery ends — and shows it in this agent's tab as posted to the
  group. What the members answer in the turn of that message is posted to the group as well, once, and
  reaches this agent as a message from each of them. A message with both `to` and `group` and no
  `task`, one that names a group the agent is not in, or one that does not exist, is a line in this
  agent's tab saying why; the agent itself is not told. `group` goes with `kind: message` only; with
  `task` it goes with `to`. Since 0.7.0 `group` is the one address of a message. A mention in the text — `@<id>`, the id of a member
  as the roster gives it, at the start or after a space, a bracket or a comma — addresses that member:
  every member still gets the message, and only the mentioned ones answer in the round (#174). A
  mention of an id that is not a member of the group is refused — a line in this agent's tab — and the
  message is not posted.
- `task` — optional, with `group` and `to`: the message gives that member of the group a task, and the
  outcome comes back — see "Tasks" below. An object; `deadline` in it is an optional ISO 8601 time the
  task is to be done by. The `messageId` of the message is the id of the task. A task has one doer: `task`
  with `group` and no `to` is a line in this agent's tab saying why, and goes nowhere.
- `cancel` — optional: the id of a task this agent gave, to take it back. The text of such a message is
  not shown.

Anything else in the metadata is ignored for now.

## Messages from other agents

A message of another agent of the fleet reaches an A2A agent through a group they share — since 0.7.0
the one way agents talk (#171) — as an ordinary message, with the sender and the group under the
extension URI in its metadata: `from` is the id of the sending agent, `group` the group to post to in
order to answer it:

```json
{
    "messageId": "…",
    "role": "ROLE_USER",
    "parts": [{"text": "The snapshot test fails, please rerun it after the fix."}],
    "extensions": ["https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md"],
    "metadata": {
        "https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md": {"from": "reviewer", "group": "release"}
    }
}
```

It goes in line with the messages of a person and belongs to the same conversation. The inbox request
is told from it by `"action": "subscribe"`, not by the extension URI alone. An agent that does not
declare this extension gets the sender and the group in the text as well, as `[from reviewer in group
release] …`; so does a local agent over ACP, which has no place for it otherwise. A message sent agent
to agent, with `from` alone and `[from reviewer] …` in the text, as 0.6.x sent it, is not sent any more.

A message a person posted to the group comes with the group alone, `{"group": "release"}`. What the
agent answers in the task of a group message is posted to the group by itself — its history, its tab, every other member — as a message from
this agent that quotes the one answered; that answer, posted by flotti, earns no answer back, so one
message to a group gets at most one round of answers. An agent without this extension, and a local one
over ACP, get the group in the text: `[from reviewer in group release] …`, and `[in group release] …`
for a message of a person. The dashboard shows the message in the receiver's tab marked with the group
(until 0.7.0: from then on it is read in the tab of the group only, #172).

From 0.7.0 a message that mentions members ([groups-only](../openspec/changes/groups-only/proposal.md), #174) carries them too, the same
array for every member — `{"from": "reviewer", "group": "release", "mentions": ["builder"]}` — and an
agent that finds its own id in `mentions` is the one asked: what it answers in the task of that message
is posted to the group; a member not in `mentions` gets the message for context, and what it answers is
not posted. Without `mentions` every member answers, as above. In the text the mark says who is asked:
`[from reviewer in group release, to you] …` for a mentioned member, `[from reviewer in group release,
to builder] …` for the others. An adapter written before ignores the field and answers as it did; flotti
posts the answer of a mentioned member only.

Each message needs a `messageId` of its own: flotti shows a message once, and a snapshot of the task —
after a reconnect — repeats the history.

## Tasks

A task goes to one member of a group the agent is in (#51; inside a group since 0.7.0, #171 — decision 1
of [the change groups-only](../openspec/changes/groups-only/proposal.md#decisions)). A message with
`task`, `group` and `to` gives the member `to` of the group `group` a task:

```json
{
    "messageId": "task-1",
    "role": "ROLE_AGENT",
    "parts": [{"text": "Collect the failing tests and list them"}],
    "metadata": {
        "https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md": {"group": "release", "to": "tester", "task": {"deadline": "2026-09-24T18:00:00Z"}}
    }
}
```

The task is posted to the group as a message from this agent that mentions the doer — `@tester Collect
the failing tests and list them` — with the task and its deadline, and the tab of the group shows the
card of the task as it stands. The other members are not handed it: a task has one doer. The task
reaches the doer as a message from this one, with `group` and `task` — `id` and, when given, `deadline`
— beside `from`, and the text says that what it answers in that turn is the result. How the turn ends is
how the task ends: a completed task is `completed`, with what the agent answered; a cancelled one
`canceled`; a failed or rejected one `failed`. A turn that pauses for input goes on with the answer. The
outcome is posted to the group as a message from the doer that answers the task, with how it ended, and
comes back to this agent by itself, as a message from the doer that quotes the task, with `group` and
`task` — `id` and `state` — under the extension URI:

```json
"metadata": {
    "https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md": {"from": "tester", "group": "release", "task": {"id": "task-1", "state": "completed"}}
}
```

A task that cannot be given — no group named, a group this agent is not in, a doer that is not a member
of it or not in the fleet, the doer is stopped — comes back `failed` at once, with why in the text; a
doer the agent cannot see is refused with the same words as one that does not exist, and the real
reason is a line in this agent's tab. A task not done by its deadline fails too, and the doer is told to
stop. To take a task back, send a message with `{"cancel": "task-1"}`: the task leaves the line of the
doer, or its turn is cancelled, and the outcome — `canceled` — is posted to the group; no outcome comes
back to this agent for it. The tabs of both agents show the task and where it stands.

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
