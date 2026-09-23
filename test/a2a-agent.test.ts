import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { TaskState } from '@a2a-js/sdk';
import { AgentEvent } from '@a2a-js/sdk/server';
import type { RequestContext } from '@a2a-js/sdk/server';
import { A2AAgent, RESTART_EXTENSION, cardLocation } from '../src/a2a-agent.js';
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
function messages(events: readonly DashboardEvent[]) {
    return events.flatMap(event => event.type === 'message' ? [{ role: event.role, text: event.text, append: event.append }] : []);
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
        const firstTask = (agent.received[0]?.params['message'] as { taskId?: string }).taskId;
        const answer = agent.received[1]?.params['message'] as { taskId?: string };
        strictEqual(firstTask, undefined);
        ok(answer.taskId !== undefined && answer.taskId !== '');
        deepStrictEqual(messages(events).map(message => message.text), ['pick one', 'Which one?', 'the second', 'took the second']);
    });
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
describe('A2AAgent: cancel, restart, stop', () => {
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
    });
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
