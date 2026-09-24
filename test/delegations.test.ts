import { deepStrictEqual, match, ok, strictEqual, throws } from 'node:assert/strict';
import { after, test } from 'node:test';
import type { AgentEvent, Delegation } from '../src/agent-events.js';
import { FleetMcpServer } from '../src/fleet-mcp.js';
import { Supervisor, UnknownDelegationError } from '../src/supervisor.js';
import { fakeFleet } from './fake-fleet-agent.js';
import type { FakeFleetAgent } from './fake-fleet-agent.js';
function supervised(...ids: string[]) {
    const { fleet, fakes, createAgent } = fakeFleet(...ids);
    const supervisor = new Supervisor(fleet, { createAgent, queuedAfterMs: 50 });
    return { supervisor, fake: (id: string): FakeFleetAgent => fakes.get(id) ?? assertNever(id) };
}
function assertNever(id: string): never {
    throw new Error(`no fake ${id}`);
}
/** The task as each state of it showed in the tab of the agent, in order. */
function cards(supervisor: Supervisor, agentId: string): Omit<Delegation, 'delegationId' | 'text'>[] {
    return supervisor.history(agentId).flatMap((event) => event.type === 'delegation'
        ? [{
            from: event.from,
            to: event.to,
            state: event.state,
            ...(event.result === undefined ? {} : { result: event.result }),
            ...(event.deadline === undefined ? {} : { deadline: event.deadline })
        }]
        : []);
}
function received(supervisor: Supervisor, agentId: string): (AgentEvent & { type: 'message' })[] {
    return supervisor.history(agentId).flatMap((event) => event.type === 'message' && event.role === 'user' ? [event] : []);
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > until) {
            throw new Error('the condition did not come true in time');
        }
        await pause(10);
    }
}
test('a task completes: the outcome goes back to the agent that gave it, and both tabs show it', async () => {
    const { supervisor, fake } = supervised('a', 'b');
    await supervisor.start();
    const { delegation, queued } = await supervisor.delegate('a', 'b', 'rerun the e2e job');
    strictEqual(queued, false);
    const id = delegation.delegationId;
    await eventually(() => fake('a').calls.length > 1);
    deepStrictEqual(fake('b').options, [{ from: 'a', messageId: fake('b').options[0]?.messageId, delegation: { id } }]);
    deepStrictEqual(fake('a').calls, ['start', 'send you said: rerun the e2e job from b'], 'the outcome only, not the answer of #45 as well');
    const outcome = fake('a').options[0];
    deepStrictEqual(outcome?.delegation, { id, state: 'completed' });
    deepStrictEqual(outcome.replyTo?.text, 'rerun the e2e job');
    for (const agentId of ['a', 'b']) {
        deepStrictEqual(cards(supervisor, agentId), [
            { from: 'a', to: 'b', state: 'working' },
            { from: 'a', to: 'b', state: 'completed', result: 'you said: rerun the e2e job' }
        ], `the tab of ${agentId}`);
    }
    deepStrictEqual(fake('b').calls, ['start', 'send rerun the e2e job from a'], 'the outcome gets no answer back');
});
test('a task to an agent that is not there, is stopped, or is the giver fails at once, saying why', async () => {
    const { supervisor, fake } = supervised('a', 'b');
    await supervisor.start();
    await supervisor.stopAgent('b');
    const nobody = await supervisor.delegate('a', 'nobody', 'hi');
    deepStrictEqual([nobody.delegation.state, nobody.delegation.result], ['failed', 'there is no agent "nobody" in the fleet']);
    const stopped = await supervisor.delegate('a', 'b', 'hi');
    deepStrictEqual([stopped.delegation.state, stopped.delegation.result], ['failed', '"b" is stopped']);
    const self = await supervisor.delegate('a', 'a', 'hi');
    deepStrictEqual(self.delegation.result, 'an agent does not give tasks to itself');
    fake('b').broken = true;
    await supervisor.startAgent('b').catch(() => undefined);
    const broken = await supervisor.delegate('a', 'b', 'hi');
    deepStrictEqual([broken.delegation.state, broken.delegation.result], ['failed', '"b" did not get it: b is broken']);
    await pause(10);
    deepStrictEqual(fake('a').calls, ['start'], 'the caller has the failure already: no message besides');
    deepStrictEqual(cards(supervisor, 'a').map((card) => card.state), ['failed', 'failed', 'failed', 'working', 'failed'], 'the last one was on its way');
});
test('taking back a task the agent works on stops the agent; the giver gets no outcome for it', async () => {
    const { supervisor, fake } = supervised('a', 'b');
    await supervisor.start();
    fake('b').slow = true;
    const { delegation } = await supervisor.delegate('a', 'b', 'refactor the parser');
    const { delegation: taken, canceled } = supervisor.cancelDelegation('a', delegation.delegationId);
    ok(canceled);
    deepStrictEqual([taken.state, taken.result], ['canceled', 'taken back by "a"']);
    await pause(10);
    ok(fake('b').calls.includes('cancel'), 'the agent is told to stop');
    deepStrictEqual(fake('a').calls, ['start']);
    deepStrictEqual(cards(supervisor, 'b').map((card) => card.state), ['working', 'canceled']);
    deepStrictEqual(supervisor.cancelDelegation('a', delegation.delegationId).canceled, false, 'a task over stays as it ended');
});
test('taking back a task still in line takes it out of the line: it never reaches the agent', async () => {
    const { supervisor, fake } = supervised('a', 'b');
    await supervisor.start();
    fake('b').busy = true;
    const { delegation, queued } = await supervisor.delegate('a', 'b', 'later');
    ok(queued);
    supervisor.cancelDelegation('a', delegation.delegationId);
    fake('b').release();
    await pause(10);
    ok(fake('b').calls.some((call) => call.startsWith('withdraw ')));
    deepStrictEqual(received(supervisor, 'b'), []);
    ok(!fake('b').calls.includes('cancel'));
    deepStrictEqual(fake('a').calls, ['start']);
});
test('only the agent that gave a task takes it back', async () => {
    const { supervisor } = supervised('a', 'b', 'c');
    await supervisor.start();
    const { delegation } = await supervisor.delegate('a', 'b', 'x');
    throws(() => supervisor.cancelDelegation('c', delegation.delegationId), UnknownDelegationError);
    throws(() => supervisor.cancelDelegation('a', 'no-such-task'), /"a" gave no task "no-such-task"/);
});
test('a task not done by its deadline fails, and the agent is told to stop', async () => {
    const { supervisor, fake } = supervised('a', 'b');
    await supervisor.start();
    fake('b').slow = true;
    const deadline = new Date(Date.now() + 100).toISOString();
    await supervisor.delegate('a', 'b', 'quick one', deadline);
    await eventually(() => fake('a').calls.length > 1);
    ok(fake('b').calls.includes('cancel'));
    deepStrictEqual(cards(supervisor, 'a').at(-1), { from: 'a', to: 'b', state: 'failed', result: 'its deadline passed', deadline });
    deepStrictEqual(fake('a').options[0]?.delegation?.state, 'failed');
    strictEqual(fake('a').calls[1], 'send its deadline passed from b');
    const past = await supervisor.delegate('a', 'b', 'too late', new Date(Date.now() - 1000).toISOString());
    deepStrictEqual(past.delegation.result, 'its deadline has passed already');
});
test('a turn that ends otherwise fails the task, with the reason and what the agent said', async () => {
    const { supervisor, fake } = supervised('a', 'b');
    await supervisor.start();
    fake('b').slow = true;
    await supervisor.delegate('a', 'b', 'delete production');
    fake('b').finish('I will not do that', 'refusal');
    await eventually(() => fake('a').calls.length > 1);
    deepStrictEqual(cards(supervisor, 'a').at(-1)?.result, 'the agent refused it\n\nI will not do that');
    deepStrictEqual(fake('a').options[0]?.delegation?.state, 'failed');
});
test('a turn that pauses for a person goes on with the answer, and the task ends with it', async () => {
    const { supervisor, fake } = supervised('a', 'b');
    await supervisor.start();
    fake('b').slow = true;
    await supervisor.delegate('a', 'b', 'deploy');
    fake('b').finish('which environment?', 'input_required');
    await pause(10);
    deepStrictEqual(cards(supervisor, 'a').map((card) => card.state), ['working']);
    await supervisor.send('b', 'staging');
    fake('b').finish('deployed to staging');
    await eventually(() => fake('a').calls.length > 1);
    deepStrictEqual(cards(supervisor, 'a').at(-1)?.result, 'which environment?\n\ndeployed to staging');
});
test('an agent gives a task and takes it back through its events, as the A2A inbox says them', async () => {
    const { supervisor, fake } = supervised('a', 'b');
    await supervisor.start();
    fake('b').slow = true;
    fake('a').emit({ type: 'message', role: 'agent', messageId: 't-1', text: 'build it', append: false, to: 'b', delegation: { id: 't-1' } });
    await eventually(() => received(supervisor, 'b').length === 1);
    deepStrictEqual(received(supervisor, 'b')[0]?.delegation, { id: 't-1' });
    fake('a').emit({ type: 'cancel-delegation', delegationId: 't-1' });
    await pause(10);
    ok(fake('b').calls.includes('cancel'));
    deepStrictEqual(cards(supervisor, 'a').at(-1)?.state, 'canceled');
    fake('a').emit({ type: 'message', role: 'agent', messageId: 't-2', text: 'x', append: false, to: 'nobody', delegation: { id: 't-2' } });
    await eventually(() => fake('a').calls.length > 1);
    deepStrictEqual(fake('a').options[0]?.delegation, { id: 't-2', state: 'failed' }, 'the inbox has no answer: the failure comes as a message');
    fake('a').emit({ type: 'cancel-delegation', delegationId: 'unknown' });
    const lines = supervisor.history('a').flatMap((event) => event.type === 'log' ? [event.text] : []);
    deepStrictEqual(lines, ['could not take back task unknown: "a" gave no task "unknown"']);
});
test('an agent that leaves the fleet fails the tasks it got', async () => {
    const { supervisor, fake } = supervised('a', 'b');
    await supervisor.start();
    fake('b').slow = true;
    await supervisor.delegate('a', 'b', 'x');
    await supervisor.remove('b');
    await eventually(() => fake('a').calls.length > 1);
    deepStrictEqual(cards(supervisor, 'a').at(-1)?.result, '"b" left the fleet');
});
const servers: FleetMcpServer[] = [];
after(async () => {
    await Promise.all(servers.map((server) => server.close()));
});
async function callTool(server: FleetMcpServer, caller: string, name: string, args: object): Promise<{ text: string; isError: boolean }> {
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.access(caller).token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    });
    const body = await response.json() as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: body.result.content[0]?.text ?? '', isError: body.result.isError === true };
}
test('the tools give a task, return its id, and take it back', async () => {
    const { supervisor, fake } = supervised('a', 'b');
    const server = await FleetMcpServer.start();
    servers.push(server);
    server.serve(supervisor);
    await supervisor.start();
    fake('b').slow = true;
    const given = await callTool(server, 'a', 'delegate', { to: 'b', text: 'write the notes', deadline_minutes: 30 });
    strictEqual(given.isError, false);
    const id = /^Task (\S+) is with "b"\. It is due by /.exec(given.text)?.[1];
    ok(id !== undefined, given.text);
    ok(cards(supervisor, 'b')[0]?.deadline !== undefined);
    const canceled = await callTool(server, 'a', 'cancel_delegation', { id });
    deepStrictEqual(canceled, { text: `Task ${id} is canceled; "b" was told to stop.`, isError: false });
    match((await callTool(server, 'b', 'cancel_delegation', { id })).text, /"b" gave no task/);
    const failed = await callTool(server, 'a', 'delegate', { to: 'nobody', text: 'x' });
    ok(failed.isError);
    match(failed.text, /^Task \S+ failed at once: there is no agent "nobody" in the fleet$/);
    match((await callTool(server, 'a', 'delegate', { to: 'b', text: 'x', deadline_minutes: -1 })).text, /deadline_minutes must be/);
    await supervisor.stop();
});
