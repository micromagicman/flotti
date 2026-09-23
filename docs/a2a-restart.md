# A2A extension: restart on request

URI: `https://github.com/micromagicman/supavisor/blob/main/docs/a2a-restart.md`

A2A has no operation for "restart yourself", and supavisor does not own the process of a remote agent,
so it cannot restart it the way it restarts a local one. This extension is how a remote agent lets
supavisor ask it to. It is an ordinary A2A message: no new method, nothing the SDKs do not already
carry.

## The agent declares it

In its agent card:

```json
{
    "capabilities": {
        "extensions": [
            {"uri": "https://github.com/micromagicman/supavisor/blob/main/docs/a2a-restart.md", "required": false}
        ]
    }
}
```

An agent without the declaration is never sent the request. For such an agent the restart button of
the dashboard only starts a new conversation.

## supavisor asks

`SendMessage` (not the streaming one), with the extension named in the `A2A-Extensions` header:

```
A2A-Extensions: https://github.com/micromagicman/supavisor/blob/main/docs/a2a-restart.md
```

and the request in the message metadata, under the extension URI:

```json
{
    "message": {
        "messageId": "…",
        "role": "ROLE_USER",
        "parts": [{"text": "Restart requested by supavisor."}],
        "extensions": ["https://github.com/micromagicman/supavisor/blob/main/docs/a2a-restart.md"],
        "metadata": {
            "https://github.com/micromagicman/supavisor/blob/main/docs/a2a-restart.md": {"action": "restart"}
        }
    }
}
```

The message has no `contextId` and no `taskId`: it belongs to no conversation. The text part is there
for agents and logs that show messages to people; the metadata is what counts. The request comes from
a person who pressed the restart button of the dashboard — that is the confirmation.

## The agent answers

- **Accepted** — any answer but the two below: a message, or a task in any other state. The agent
  answers first and restarts after, so that the answer gets out.
- **Refused** — a task in the `rejected` or `failed` state; the text of its status message is the
  reason, and supavisor shows it.

## After the restart

The agent comes back at the same address with the same card. supavisor reads the card again until it
gets it, for up to a minute by default, and then counts the agent as connected. What was going on
before the restart — conversations, tasks — is not expected to survive it: supavisor starts a new
conversation.
