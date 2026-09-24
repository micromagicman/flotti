import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { TaskState } from '@a2a-js/sdk';
import { AgentEvent } from '@a2a-js/sdk/server';
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { A2AAgent, HARNESS_EXTENSION, INBOX_EXTENSION, RESTART_EXTENSION, cardLocation } from '../src/a2a-agent.js';
import type { A2AAgentOptions } from '../src/a2a-agent.js';
import type { AgentEvent as DashboardEvent, AgentStatus } from '../src/agent-events.js';
import type { RemoteAgent, RemoteAuth } from '../src/types.js';
import { FakeAgent, agentMessage, artifact, gate, said, statusUpdate, task } from './a2a-fake-server.js';
import type { FakeAgentOptions, Script } from './a2a-fake-server.js';
const running: FakeAgent[] = [];
const clients: A2AAgent[] = [];
afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.stop()));
    await Promise.all(running.splice(0).map(agent => agent.close()));
});
async function fake(options: FakeAgentOptions): Promise<FakeAgent> {
    const agent = await new FakeAgent(options).listen();
    running.push(agent);
    return agent;
}
function manifest(url: string, auth: RemoteAuth = { type: 'none' }): RemoteAgent {
    return {
        kind: 'remote',
        id: 'fake',
        name: 'Fake',
        directory: '/fleet/remote/fake',
        manifestPath: '/fleet/remote/fake/agent.json',
        protocol: 'a2a',
        url,
        auth
    };
}
/** A client of the fake agent that writes down every event it gets. */
function connect(agent: FakeAgent, options: A2AAgentOptions & { auth?: RemoteAuth } = {}) {
    const client = new A2AAgent(manifest(agent.url, options.auth), {
        reconnectDelayMs: 10,
        pollIntervalMs: 10,
        restartTimeoutMs: 2_000,
        ...options
    });
    clients.push(client);
    const events: DashboardEvent[] = [];
    client.subscribe(event => events.push(event));
    return { client, events };
}
/** Resolves once the client reports the status. */
function reaches(client: A2AAgent, status: AgentStatus): Promise<void> {
    return new Promise(resolve => {
        if (client.status === status) {
            resolve();
            return;
        }
        const stop = client.subscribe(event => {
            if (event.type === 'status' && event.status === status) {
                stop();
                resolve();
            }
        });
    });
}
function statuses(events: readonly DashboardEvent[]): string[] {
    return events.flatMap(event => event.type === 'status' ? [event.status] : []);
}
function turnEnds(events: readonly DashboardEvent[]): string[] {
    return events.flatMap(event => event.type === 'turn-end' ? [event.reason] : []);
}
function messages(events: readonly DashboardEvent[]) {
    return events.flatMap(event => event.type === 'message' ? [{ role: event.role, text: event.text, append: event.append }] : []);
}
/** Waits until the condition holds, checking every 10 ms. */
async function eventually(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > until) {
            throw new Error('the condition did not come true in time');
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
/** Answers every message with one completed task that says the message back. */
const echo: Script = async (context, bus) => {
    bus.publish(task(context, TaskState.TASK_STATE_WORKING));
    bus.publish(statusUpdate(context.taskId, context.contextId, TaskState.TASK_STATE_COMPLETED, agentMessage(`echo: ${said(context)}`, context)));
    bus.finished();
};
describe('A2AAgent: connecting', () => {
    it('reads the card and reports what it says', async () => {
        const agent = await fake({ script: echo, extensions: [RESTART_EXTENSION] });
        const { client, events } = connect(agent);
        await client.start();
        deepStrictEqual(statuses(events), ['starting', 'idle']);
        const info = client.info;
        ok(info !== undefined);
        strictEqual(info.name, 'Fake');
        strictEqual(info.version, '1.2.3');
        strictEqual(info.protocolVersion, '1.0');
        strictEqual(info.streaming, true);
        strictEqual(info.restart, true);
        strictEqual(info.signed, false);
        deepStrictEqual(info.skills, [{ id: 'echo', name: 'Echo', description: 'Says it back' }]);
    });
    it('talks to an A2A 0.3 agent too', async () => {
        const agent = await fake({ script: echo, legacy: true });
        const { client, events } = connect(agent);
        await client.start();
        strictEqual(client.info?.protocolVersion, '0.3');
        await client.send('hi');
        await reaches(client, 'idle');
        deepStrictEqual(agent.methods(), ['message/stream']);
        deepStrictEqual(messages(events).map(message => message.text), ['hi', 'echo: hi']);
    });
    it('finds the card under the path of the address', async () => {
        const agent = await fake({ script: echo, prefix: '/a2a' });
        const { client } = connect(agent);
        await client.start();
        strictEqual(agent.cardRequests, 1);
    });
    it('reports an agent that is not there', async () => {
        const agent = await fake({ script: echo });
        const url = agent.url;
        await agent.close();
        running.length = 0;
        const client = new A2AAgent(manifest(url));
        clients.push(client);
        await rejects(client.start());
        strictEqual(client.status, 'error');
    });
});
describe('A2AAgent: the harness the card names', () => {
    it('takes the harness the card names in the harness extension, as it is', async () => {
        for (const [params, harness] of [
            [{ harness: 'codex' }, 'codex'],
            [{ harness: 'home-made' }, 'home-made'],
            [{ harness: '' }, undefined],
            [{ harness: 7 }, undefined],
            [undefined, undefined]
        ] as const) {
            const agent = await fake({
                script: echo,
                extensions: [HARNESS_EXTENSION],
                ...(params === undefined ? {} : { extensionParams: { [HARNESS_EXTENSION]: params } })
            });
            const { client } = connect(agent);
            await client.start();
            strictEqual(client.harness, harness, JSON.stringify(params));
            strictEqual(client.info?.harness, harness);
        }
    });
    it('knows no harness when the card does not name one', async () => {
        const agent = await fake({ script: echo });
        const { client } = connect(agent);
        await client.start();
        strictEqual(client.harness, undefined);
        strictEqual(Object.keys(client.info ?? {}).includes('harness'), false);
    });
});
describe('A2AAgent: credentials', () => {
    it('sends the bearer token from the variable the manifest names, with every request', async () => {
        const agent = await fake({ script: echo });
        const { client } = connect(agent, {
            auth: { type: 'bearer', tokenEnv: 'FAKE_TOKEN' },
            env: { FAKE_TOKEN: 's3cret' }
        });
        await client.start();
        await client.send('hi');
        await reaches(client, 'idle');
        strictEqual(agent.received[0]?.headers['authorization'], 'Bearer s3cret');
        strictEqual(agent.received[0]?.headers['a2a-version'], '1.0');
    });
    it('sends an API key in the header the manifest names', async () => {
        const agent = await fake({ script: echo });
        const { client } = connect(agent, {
            auth: { type: 'api-key', header: 'X-Api-Key', valueEnv: 'FAKE_KEY' },
            env: { FAKE_KEY: 'k3y' }
        });
        await client.start();
        await client.send('hi');
        strictEqual(agent.received[0]?.headers['x-api-key'], 'k3y');
    });
    it('names the missing variable, and connects nowhere without it', async () => {
        const agent = await fake({ script: echo });
        const { client } = connect(agent, { auth: { type: 'bearer', tokenEnv: 'FAKE_TOKEN' }, env: {} });
        await rejects(client.start(), /FAKE_TOKEN .*not set/);
        strictEqual(client.status, 'error');
        strictEqual(agent.cardRequests, 0);
    });
});
describe('A2AAgent: caching the card', () => {
    it('checks a card it has with If-None-Match instead of downloading it again', async () => {
        const agent = await fake({ script: echo });
        const { client } = connect(agent);
        await client.start();
        await client.restart();
        strictEqual(agent.cardRequests, 1);
        await client.stop();
        await client.start();
        strictEqual(agent.cardRequests, 2);
        strictEqual(agent.cardNotModified, 1);
    });
    it('does not ask for a card that is still fresh', async () => {
        const agent = await fake({ script: echo, cardCacheControl: 'public, max-age=60' });
        const { client } = connect(agent);
        await client.start();
        await client.stop();
        await client.start();
        strictEqual(agent.cardRequests, 1);
    });
});
describe('A2AAgent: talking', () => {
    it('streams the answer: the message, the status, the artifact pieces', async () => {
        const agent = await fake({
            script: async (context, bus) => {
                bus.publish(task(context, TaskState.TASK_STATE_WORKING));
                bus.publish(artifact(context, 'a1', 'Hello', false));
                bus.publish(artifact(context, 'a1', ', world', true));
                bus.publish(statusUpdate(context.taskId, context.contextId, TaskState.TASK_STATE_COMPLETED));
                bus.finished();
            }
        });
        const { client, events } = connect(agent);
        await client.start();
        await client.send('hi');
        await reaches(client, 'idle');
        deepStrictEqual(messages(events), [
            { role: 'user', text: 'hi', append: false },
            { role: 'agent', text: 'Hello', append: false },
            { role: 'agent', text: ', world', append: true }
        ]);
        deepStrictEqual(statuses(events), ['starting', 'idle', 'working', 'idle']);
        await eventually(() => turnEnds(events).length === 1);
        deepStrictEqual(turnEnds(events), ['end_turn']);
        deepStrictEqual(events.map(event => event.seq), events.map((_, index) => index + 1));
        ok(events.every(event => event.agentId === 'fake'));
        deepStrictEqual(agent.methods(), ['SendStreamingMessage']);
    });
    it('keeps the conversation: the next message carries the context of the first', async () => {
        const agent = await fake({ script: echo });
        const { client } = connect(agent);
        await client.start();
        await client.send('one');
        await client.send('two');
        await reaches(client, 'idle');
        const first = agent.received[0]?.params['message'] as { contextId?: string };
        const second = agent.received[1]?.params['message'] as { contextId?: string };
        strictEqual(first.contextId, undefined);
        ok(second.contextId !== undefined && second.contextId !== '');
    });
});
describe('A2AAgent: a task waiting for input', () => {
    it('shows a task that waits for input as waiting, and answers that task with the next message', async () => {
        const agent = await fake({
            script: async (context, bus) => {
                if (context.task === undefined) {
                    bus.publish(task(context, TaskState.TASK_STATE_WORKING));
                    bus.publish(statusUpdate(context.taskId, context.contextId, TaskState.TASK_STATE_INPUT_REQUIRED, agentMessage('Which one?', context, 'ask')));
                } else {
                    bus.publish(AgentEvent.task(context.task));
                    bus.publish(statusUpdate(context.taskId, context.contextId, TaskState.TASK_STATE_COMPLETED, agentMessage(`took ${said(context)}`, context, 'done')));
                }
                bus.finished();
            }
        });
        const { client, events } = connect(agent);
        await client.start();
        await client.send('pick one');
        await reaches(client, 'waiting');
        ok(events.some(event => event.type === 'status' && event.status === 'waiting' && event.reason === 'input required'));
        await client.send('the second');
        await reaches(client, 'idle');
        await eventually(() => turnEnds(events).length === 2);
        deepStrictEqual(turnEnds(events), ['input_required', 'end_turn']);
        const firstTask = (agent.received[0]?.params['message'] as { taskId?: string }).taskId;
        const answer = agent.received[1]?.params['message'] as { taskId?: string };
        strictEqual(firstTask, undefined);
        ok(answer.taskId !== undefined && answer.taskId !== '');
        deepStrictEqual(messages(events).map(message => message.text), ['pick one', 'Which one?', 'the second', 'took the second']);
    });
});
describe('A2AAgent: a busy agent, an agent that cannot stream', () => {
    it('queues a message sent while the agent is busy', async () => {
        const hold = gate();
        const agent = await fake({
            script: async (context, bus) => {
                bus.publish(task(context, TaskState.TASK_STATE_WORKING));
                if (said(context) === 'first') {
                    await hold.promise;
                }
                bus.publish(statusUpdate(context.taskId, context.contextId, TaskState.TASK_STATE_COMPLETED, agentMessage(`done ${said(context)}`, context)));
                bus.finished();
            }
        });
        const { client, events } = connect(agent);
        await client.start();
        await client.send('first');
        const second = client.send('second');
        await new Promise(resolve => setTimeout(resolve, 50));
        strictEqual(agent.received.length, 1);
        hold.open();
        await second;
        await reaches(client, 'idle');
        deepStrictEqual(messages(events).map(message => message.text), ['first', 'done first', 'second', 'done second']);
    });
    it('polls an agent that cannot stream', async () => {
        const hold = gate();
        const agent = await fake({
            streaming: false,
            script: async (context, bus) => {
                bus.publish(task(context, TaskState.TASK_STATE_WORKING));
                await hold.promise;
                bus.publish(statusUpdate(context.taskId, context.contextId, TaskState.TASK_STATE_COMPLETED, agentMessage('late answer', context)));
                bus.finished();
            }
        });
        const { client, events } = connect(agent);
        await client.start();
        await client.send('hi');
        strictEqual(client.status, 'working');
        hold.open();
        await reaches(client, 'idle');
        strictEqual(agent.methods()[0], 'SendMessage');
        ok(agent.methods().slice(1).every(method => method === 'GetTask'));
        deepStrictEqual(messages(events).map(message => message.text), ['hi', 'late answer']);
    });
});
describe('A2AAgent: broken streams and failed tasks', () => {
    it('reconnects to the task when the stream breaks off, without sending the message again', async () => {
        const hold = gate();
        const agent = await fake({
            dropStream: (method, index) => method === 'SendStreamingMessage' && index === 1,
            script: async (context, bus) => {
                bus.publish(task(context, TaskState.TASK_STATE_WORKING));
                bus.publish(artifact(context, 'a1', 'part one', false));
                await hold.promise;
                bus.publish(statusUpdate(context.taskId, context.contextId, TaskState.TASK_STATE_COMPLETED, agentMessage('all done', context)));
                bus.finished();
            }
        });
        const { client, events } = connect(agent);
        await client.start();
        await client.send('hi');
        while (!agent.methods().includes('SubscribeToTask')) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        hold.open();
        await reaches(client, 'idle');
        strictEqual(agent.methods().filter(method => method === 'SendStreamingMessage').length, 1);
        ok(messages(events).some(message => message.text === 'part one'));
        ok(messages(events).some(message => message.text === 'all done'));
    });
    it('reports a failed task as an error, and recovers with the next message', async () => {
        const agent = await fake({
            script: async (context, bus) => {
                bus.publish(task(context, TaskState.TASK_STATE_WORKING));
                const state = said(context) === 'break' ? TaskState.TASK_STATE_FAILED : TaskState.TASK_STATE_COMPLETED;
                bus.publish(statusUpdate(context.taskId, context.contextId, state));
                bus.finished();
            }
        });
        const { client } = connect(agent);
        await client.start();
        await client.send('break');
        await reaches(client, 'error');
        await client.send('again');
        await reaches(client, 'idle');
    });
    it('refuses to send before it is connected', async () => {
        const client = new A2AAgent(manifest('http://127.0.0.1:1'));
        await rejects(client.send('hi'), /not connected/);
    });
});
describe('A2AAgent: cancel and stop', () => {
    it('cancels the task the agent is working on', async () => {
        const agent = await fake({
            script: async (context, bus) => {
                bus.publish(task(context, TaskState.TASK_STATE_WORKING));
                // Never finishes by itself: only a cancel ends it.
            }
        });
        const { client, events } = connect(agent);
        await client.start();
        await client.send('long job');
        await client.cancel();
        await reaches(client, 'idle');
        ok(agent.methods().includes('CancelTask'));
        ok(events.some(event => event.type === 'status' && event.reason === 'canceled'));
        await eventually(() => turnEnds(events).includes('cancelled'));
    });
    it('drops the queued messages when stopped', async () => {
        const agent = await fake({
            script: async (context, bus) => {
                bus.publish(task(context, TaskState.TASK_STATE_WORKING));
            }
        });
        const { client } = connect(agent);
        await client.start();
        await client.send('first');
        const queued = client.send('second');
        await client.stop();
        await rejects(queued, /stopped/);
        strictEqual(client.status, 'stopped');
        strictEqual(agent.received.length, 1);
    });
});
describe('A2AAgent: restart without the extension', () => {
    it('starts a new conversation when the agent cannot restart itself', async () => {
        const agent = await fake({ script: echo });
        const { client, events } = connect(agent);
        await client.start();
        await client.send('one');
        await reaches(client, 'idle');
        await client.restart();
        const last = events.at(-1);
        ok(last?.type === 'status');
        match(last.reason ?? '', /new conversation/);
        await client.send('two');
        await reaches(client, 'idle');
        const second = agent.received.at(-1)?.params['message'] as { contextId?: string };
        strictEqual(second.contextId, undefined);
        ok(!agent.methods().some(method => method === 'SendMessage'));
    });
});
describe('A2AAgent: restart with the extension', () => {
    it('asks an agent with the restart extension to restart, and reconnects', async () => {
        const restarts: RequestContext[] = [];
        const agent = await fake({
            extensions: [RESTART_EXTENSION],
            script: async (context, bus) => {
                if (context.userMessage.metadata?.[RESTART_EXTENSION] !== undefined) {
                    restarts.push(context);
                    bus.publish(AgentEvent.message(agentMessage('Restarting.', context)));
                    bus.finished();
                    return;
                }
                await echo(context, bus);
            }
        });
        const { client, events } = connect(agent);
        await client.start();
        await client.send('one');
        await reaches(client, 'idle');
        await client.restart();
        strictEqual(restarts.length, 1);
        deepStrictEqual(restarts[0]?.userMessage.metadata?.[RESTART_EXTENSION], { action: 'restart' });
        const request = agent.received.find(received => received.method === 'SendMessage');
        strictEqual(request?.headers['a2a-extensions'], RESTART_EXTENSION);
        strictEqual(agent.cardRequests, 2);
        deepStrictEqual(statuses(events).slice(-2), ['starting', 'idle']);
        ok(events.some(event => event.type === 'status' && event.reason === 'restarted'));
    });
    it('reports an agent that refuses to restart', async () => {
        const agent = await fake({
            extensions: [RESTART_EXTENSION],
            script: async (context, bus) => {
                bus.publish(task(context, TaskState.TASK_STATE_REJECTED));
                bus.finished();
            }
        });
        const { client } = connect(agent);
        await client.start();
        await rejects(client.restart(), /refused to restart/);
        strictEqual(client.status, 'error');
    });
});
/**
 * An agent with the inbox: it keeps the inbox task open, and the test makes it
 * say things of its own with `post`.
 */
async function inboxAgent(options: Partial<FakeAgentOptions> = {}) {
    const subscriptions: RequestContext[] = [];
    let inbox: { bus: ExecutionEventBus; context: RequestContext } | undefined;
    const agent = await fake({
        extensions: [INBOX_EXTENSION],
        ...options,
        script: async (context, bus) => {
            const params = context.userMessage.metadata?.[INBOX_EXTENSION] as { action?: string } | undefined;
            if (params?.action === 'subscribe') {
                subscriptions.push(context);
                inbox = { bus, context };
                bus.publish(task(context, TaskState.TASK_STATE_WORKING));
                // The inbox stays open for as long as the executor runs.
                await new Promise(() => undefined);
            }
            await echo(context, bus);
        }
    });
    const post = (text: string, messageId: string, metadata?: Record<string, unknown>) => {
        ok(inbox !== undefined, 'the inbox is not open');
        const message = { ...agentMessage(text, inbox.context, messageId), metadata };
        inbox.bus.publish(statusUpdate(inbox.context.taskId, inbox.context.contextId, TaskState.TASK_STATE_WORKING, message));
    };
    return { agent, subscriptions, post, isOpen: () => inbox !== undefined };
}
describe('A2AAgent: what the agent says of its own (the inbox extension)', () => {
    it('shows a message the agent sends of its own, before and after a turn', async () => {
        const { agent, subscriptions, post, isOpen } = await inboxAgent();
        const { client, events } = connect(agent);
        await client.start();
        await eventually(isOpen);
        deepStrictEqual(subscriptions[0]?.userMessage.metadata?.[INBOX_EXTENSION], { action: 'subscribe' });
        strictEqual(agent.received[0]?.headers['a2a-extensions'], INBOX_EXTENSION);
        post('MR is ready', 'own-1');
        await eventually(() => messages(events).length === 1);
        await client.send('hi');
        await eventually(() => turnEnds(events).length === 1);
        post('CI is green', 'own-2');
        await eventually(() => messages(events).length === 4);
        deepStrictEqual(messages(events).map(message => `${message.role}: ${message.text}`), [
            'agent: MR is ready',
            'user: hi',
            'agent: echo: hi',
            'agent: CI is green'
        ]);
        deepStrictEqual(turnEnds(events), ['end_turn']);
        strictEqual(client.status, 'idle');
    });
    it('shows the progress of the agent and the status it reports while busy on its own', async () => {
        const { agent, post, isOpen } = await inboxAgent();
        const { client, events } = connect(agent);
        await client.start();
        await eventually(isOpen);
        post('Running the tests', 'p1', { [INBOX_EXTENSION]: { kind: 'progress', busy: true } });
        await reaches(client, 'working');
        post('Tests are green', 'p2', { [INBOX_EXTENSION]: { kind: 'progress', busy: false } });
        await reaches(client, 'idle');
        deepStrictEqual(events.flatMap(event => event.type === 'progress' ? [event.text] : []), ['Running the tests', 'Tests are green']);
        deepStrictEqual(messages(events), []);
    });
});
describe('A2AAgent: messages between agents of the fleet', () => {
    it('says which agent a message of its own is for', async () => {
        const { agent, post, isOpen } = await inboxAgent();
        const { client, events } = connect(agent);
        await client.start();
        await eventually(isOpen);
        post('Please rerun the e2e job', 'to-1', { [INBOX_EXTENSION]: { to: 'builder' } });
        post('Done here', 'to-2', { [INBOX_EXTENSION]: { to: '' } });
        await eventually(() => messages(events).length === 2);
        deepStrictEqual(events.flatMap(event => event.type === 'message' ? [[event.role, event.text, event.to]] : []), [
            ['agent', 'Please rerun the e2e job', 'builder'],
            ['agent', 'Done here', undefined]
        ]);
    });
    it('tells the agent which agent a message is from, in the metadata', async () => {
        const { agent, isOpen } = await inboxAgent();
        const { client, events } = connect(agent);
        await client.start();
        await eventually(isOpen);
        await client.send('rerun the tests', { from: 'reviewer' });
        await eventually(() => turnEnds(events).length === 1);
        const sent = agent.received.at(-1)?.params['message'] as { parts?: unknown; metadata?: Record<string, unknown> };
        deepStrictEqual(sent.metadata?.[INBOX_EXTENSION], { from: 'reviewer' });
        deepStrictEqual(events.flatMap(event => event.type === 'message' ? [[event.role, event.text, event.from]] : []), [
            ['user', 'rerun the tests', 'reviewer'],
            ['agent', 'echo: rerun the tests', undefined]
        ]);
    });
    it('names the sender in the text as well to an agent without the inbox', async () => {
        const agent = await fake({ script: echo });
        const { client, events } = connect(agent);
        await client.start();
        await client.send('rerun the tests', { from: 'reviewer' });
        await eventually(() => turnEnds(events).length === 1);
        deepStrictEqual(events.flatMap(event => event.type === 'message' ? [[event.role, event.text, event.from]] : []), [
            ['user', 'rerun the tests', 'reviewer'],
            ['agent', 'echo: [from reviewer] rerun the tests', undefined]
        ]);
    });
});
describe('A2AAgent: keeping the inbox open', () => {
    it('goes back to the inbox after its stream broke off, without losing what was said', async () => {
        let drops = 0;
        const { agent, post, isOpen } = await inboxAgent({
            dropStream: (method, index) => method === 'SendStreamingMessage' && index === 1 && drops++ === 0
        });
        const { client, events } = connect(agent);
        await client.start();
        await eventually(isOpen);
        post('said while the stream broke', 'own-1');
        await eventually(() => agent.methods().includes('SubscribeToTask'));
        post('said after', 'own-2');
        await eventually(() => messages(events).length === 2);
        deepStrictEqual(messages(events).map(message => message.text), ['said while the stream broke', 'said after']);
        strictEqual(agent.methods().filter(method => method === 'SendStreamingMessage').length, 1);
    });
    it('closes the inbox when stopped and does not come back to it', async () => {
        const { agent, isOpen } = await inboxAgent();
        const { client } = connect(agent);
        await client.start();
        await eventually(isOpen);
        await client.stop();
        const asked = agent.received.length;
        await new Promise(resolve => setTimeout(resolve, 100));
        strictEqual(agent.received.length, asked);
    });
    it('does not open the inbox of an agent that cannot stream', async () => {
        const { agent } = await inboxAgent({ streaming: false });
        const { client, events } = connect(agent);
        await client.start();
        await new Promise(resolve => setTimeout(resolve, 50));
        deepStrictEqual(agent.methods(), []);
        ok(events.some(event => event.type === 'log' && /cannot stream/.test(event.text)));
    });
});
describe('A2AAgent: replies', () => {
    it('writes out the quoted message of a reply for the agent, and keeps the quote on the event', async () => {
        const agent = await fake({ script: echo });
        const { client, events } = connect(agent);
        await client.start();
        const replyTo = { agentId: 'remote', messageId: 'm1', text: 'deploy it' };
        await client.send('which host?', { replyTo });
        await eventually(() => turnEnds(events).length === 1);
        deepStrictEqual(events.flatMap(event => event.type === 'message' ? [[event.role, event.text, event.replyTo]] : []), [
            ['user', 'which host?', replyTo],
            ['agent', 'echo: In reply to a message from the person:\n> deploy it\n\nwhich host?', undefined]
        ]);
    });
});
describe('cardLocation', () => {
    it('looks for the card under the address', () => {
        deepStrictEqual(cardLocation('https://eva.example.org/a2a'), {
            base: 'https://eva.example.org/a2a/',
            path: '.well-known/agent-card.json'
        });
    });
    it('takes an address of a .json file for the card itself', () => {
        deepStrictEqual(cardLocation('https://eva.example.org/cards/eva.json'), {
            base: 'https://eva.example.org/cards/eva.json',
            path: ''
        });
    });
});
