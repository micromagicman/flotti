import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert/strict';
import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AgentEvent } from '../src/agent-events.js';
import { Harness, eventually, isAlive } from './local-agent-helpers.js';
/** Events without the fields that change from run to run. */
function shape(events: readonly AgentEvent[]): unknown[] {
    return events.map((event) => {
        const body: Record<string, unknown> = { ...event };
        delete body['agentId'];
        delete body['seq'];
        delete body['time'];
        if (event.type === 'tool-call') {
            body['raw'] = undefined;
        }
        if (event.type === 'message' && event.role === 'user') {
            body['messageId'] = undefined;
        }
        return body;
    });
}
describe('LocalAgentProcess: a conversation', { timeout: 20_000 }, () => {
    it('starts the agent, sends a message and streams the answer as events', async () => {
        const harness = new Harness();
        await harness.agent.start();
        strictEqual(harness.agent.state, 'running');
        strictEqual(harness.agent.status, 'idle');
        ok(harness.agent.sessionId?.startsWith('session-'));
        const from = harness.lastSeq;
        strictEqual(await harness.talk('hello'), 'end_turn');
        deepStrictEqual(shape(harness.events.filter((event) => event.seq > from)), [
            { type: 'message', role: 'user', messageId: undefined, text: 'hello', append: false },
            { type: 'status', status: 'working' },
            { type: 'tool-call', toolCallId: 'call-1', title: 'Think', status: 'in_progress', raw: undefined },
            { type: 'tool-call', toolCallId: 'call-1', status: 'completed', raw: undefined },
            { type: 'raw', protocol: 'acp', payload: { sessionUpdate: 'plan', entries: [] } },
            { type: 'message', role: 'agent', text: 'you said: hello', messageId: 'm1', append: false },
            { type: 'turn-end', reason: 'end_turn' },
            { type: 'status', status: 'idle' }
        ]);
        const seqs = harness.events.map((event) => event.seq);
        deepStrictEqual(seqs, seqs.map((_, index) => index + 1));
    });
    it('turns the agent stderr into log events and keeps it with the ACP trace in logs/', async () => {
        const harness = new Harness();
        await harness.agent.start();
        await harness.next((event) => event.type === 'log' && event.text === 'fake agent: ready');
        await harness.agent.stop();
        match(readFileSync(join(harness.directory, 'logs', 'stderr.log'), 'utf8'), /fake agent: ready/);
        const trace = readFileSync(join(harness.directory, 'logs', 'acp.jsonl'), 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as { direction: string; message: { method?: string } });
        deepStrictEqual(trace[0]?.direction, 'out');
        deepStrictEqual(trace[0]?.message.method, 'initialize');
        ok(trace.some((line) => line.direction === 'in'));
    });
});
describe('LocalAgentProcess: the queue', { timeout: 20_000 }, () => {
    it('queues a message sent while the agent is busy', async () => {
        const harness = new Harness();
        await harness.agent.start();
        const answers = await Promise.all([harness.talk('one'), harness.talk('two')]);
        deepStrictEqual(answers, ['end_turn', 'end_turn']);
        deepStrictEqual(harness.recorded('session/prompt').map((entry) => entry['text']), ['one', 'two']);
    });
    it('queues a message sent before the agent is ready', async () => {
        const harness = new Harness();
        const started = harness.agent.start();
        const answer = harness.talk('early');
        await started;
        strictEqual(await answer, 'end_turn');
    });
    it('refuses a message to a stopped agent', async () => {
        const harness = new Harness();
        await rejects(harness.agent.send('hello'), /is stopped; start it first/);
    });
    it('drops the queued messages when stopped', async () => {
        const harness = new Harness();
        await harness.agent.start();
        await harness.agent.send('wait');
        const queued = harness.agent.send('second');
        await harness.agent.stop();
        await rejects(queued, /stopped/);
        strictEqual(harness.agent.status, 'stopped');
        deepStrictEqual(harness.recorded('session/prompt').map((entry) => entry['text']), ['wait']);
    });
});
describe('LocalAgentProcess: permissions and cancelling', { timeout: 20_000 }, () => {
    it('holds a permission request until a person answers it', async () => {
        const harness = new Harness();
        await harness.agent.start();
        const answer = harness.talk('permission');
        const request = await harness.next((event) => event.type === 'permission');
        ok(request.type === 'permission');
        strictEqual(request.title, 'Delete everything');
        deepStrictEqual(request.options.map((option) => option.optionId), ['yes', 'no']);
        strictEqual(harness.agent.status, 'waiting');
        ok(harness.agent.answerPermission(request.requestId, 'yes'));
        strictEqual(await answer, 'end_turn');
        await harness.next((event) => event.type === 'message' && event.text === 'permission: yes');
        strictEqual(harness.agent.answerPermission(request.requestId, 'yes'), false);
    });
});
describe('LocalAgentProcess: cancelling', { timeout: 20_000 }, () => {
    it('cancels the message in work and answers open permission requests with cancelled', async () => {
        const harness = new Harness();
        await harness.agent.start();
        const answer = harness.talk('permission');
        await harness.next((event) => event.type === 'permission');
        await harness.agent.cancel();
        strictEqual(await answer, 'cancelled');
        await harness.next((event) => event.type === 'message' && event.text === 'permission: cancelled');
    });
    it('cancels a message the agent works on', async () => {
        const harness = new Harness();
        await harness.agent.start();
        const answer = harness.talk('wait');
        await harness.next((event) => event.type === 'status' && event.status === 'working');
        await harness.agent.cancel();
        strictEqual(await answer, 'cancelled');
        strictEqual(harness.recorded('session/cancel').length, 1);
        strictEqual(harness.agent.state, 'running');
    });
    it('kills and restarts an agent that ignores the cancel', async () => {
        const harness = new Harness({ fake: { resume: true }, options: { cancelTimeoutMs: 200 } });
        await harness.agent.start();
        const session = harness.agent.sessionId;
        const answer = harness.talk('deaf');
        await harness.next((event) => event.type === 'status' && event.status === 'working');
        const from = harness.lastSeq;
        await harness.agent.cancel();
        strictEqual(await answer, 'error');
        const restarting = await harness.status('starting', from);
        ok(restarting.type === 'status');
        match(restarting.reason ?? '', /did not end the cancelled message within 200 ms/);
        await harness.status('idle', from);
        strictEqual(harness.agent.sessionId, session);
        deepStrictEqual(harness.recorded('session/resume').map((entry) =>
            (entry['params'] as { sessionId: string }).sessionId), [session]);
    });
});
describe('LocalAgentProcess: lifecycle', { timeout: 20_000 }, () => {
    it('restarts an agent that crashed and resumes its session', async () => {
        const harness = new Harness({ fake: { resume: true } });
        await harness.agent.start();
        const session = harness.agent.sessionId;
        const from = harness.lastSeq;
        strictEqual(await harness.talk('crash'), 'error');
        const backoff = await harness.status('starting', from);
        ok(backoff.type === 'status');
        match(backoff.reason ?? '', /exited with code 3; restarting in 10 ms/);
        await harness.status('idle', from);
        strictEqual(harness.agent.sessionId, session);
        strictEqual(harness.recorded('started').length, 2);
        strictEqual(harness.recorded('session/resume').length, 1);
        strictEqual(await harness.talk('again'), 'end_turn');
    });
    it('falls back to session/load and does not repeat the replayed history', async () => {
        const harness = new Harness({ fake: { load: true } });
        await harness.agent.start();
        const session = harness.agent.sessionId;
        await harness.agent.restart();
        strictEqual(harness.agent.sessionId, session);
        strictEqual(harness.recorded('session/load').length, 1);
        ok(!harness.events.some((event) => event.type === 'message' && event.text.includes('replayed')));
    });
    it('starts a new session, and says the context is lost, when the agent can neither resume nor load', async () => {
        const harness = new Harness();
        await harness.agent.start();
        const session = harness.agent.sessionId;
        await harness.agent.restart();
        ok(harness.agent.sessionId !== session);
        await harness.next((event) => event.type === 'log' && /the context is lost/.test(event.text));
    });
});
describe('LocalAgentProcess: restart policy', { timeout: 20_000 }, () => {
    it('leaves an agent with the policy "never" exited', async () => {
        const harness = new Harness({ manifest: { restart: 'never' } });
        await harness.agent.start();
        const from = harness.lastSeq;
        strictEqual(await harness.talk('crash'), 'error');
        await harness.status('stopped', from);
        strictEqual(harness.agent.state, 'exited');
        strictEqual(harness.recorded('started').length, 1);
    });
    it('retries a failing start with a growing delay and succeeds', async () => {
        const harness = new Harness({ fake: { crashStarts: 2 } });
        await harness.agent.start();
        const delays = harness.events
            .filter((event) => event.type === 'status' && event.status === 'starting' && /restarting/.test(event.reason ?? ''))
            .map((event) => event.type === 'status' ? /in (\d+) ms/.exec(event.reason ?? '')?.[1] : undefined);
        deepStrictEqual(delays, ['10', '20']);
        strictEqual(harness.agent.state, 'running');
    });
    it('gives up after the allowed retries and says why', async () => {
        const harness = new Harness({ fake: { crashStarts: 10 } });
        await rejects(harness.agent.start(), /is fatal: exited with code 2; gave up after 2 restarts in a row/);
        strictEqual(harness.agent.state, 'fatal');
        strictEqual(harness.agent.status, 'error');
        strictEqual(readFileSync(join(harness.directory, 'counter'), 'utf8'), '3');
    });
    it('can be started again after it gave up', async () => {
        const harness = new Harness({ fake: { crashStarts: 3 } });
        await rejects(harness.agent.start());
        await harness.agent.start();
        strictEqual(harness.agent.state, 'running');
    });
});
describe('LocalAgentProcess: stopping', { timeout: 20_000 }, () => {
    it('kills and restarts an agent that stopped answering heartbeats', async () => {
        const harness = new Harness({ manifest: { heartbeatTimeoutSec: 1 }, fake: { resume: true } });
        await harness.agent.start();
        const from = harness.lastSeq;
        strictEqual(await harness.talk('freeze'), 'error');
        const restarting = await harness.status('starting', from);
        ok(restarting.type === 'status');
        match(restarting.reason ?? '', /no heartbeat for 1 s/);
        await harness.status('idle', from);
        strictEqual(harness.recorded('started').length, 2);
    });
    it('stops the whole process group: what the agent started goes too', async () => {
        const harness = new Harness();
        await harness.agent.start();
        await harness.talk('spawn');
        const [grandchild] = harness.recorded('grandchild');
        const [agent] = harness.recorded('started');
        const pids = [agent?.['pid'], grandchild?.['pid']] as number[];
        ok(pids.every(isAlive));
        await harness.agent.stop();
        strictEqual(harness.agent.state, 'stopped');
        strictEqual(harness.agent.status, 'stopped');
        await eventually(() => !pids.some(isAlive));
    });
    it('stops an agent in the middle of a message: cancels it first, then ends the process', async () => {
        const harness = new Harness();
        await harness.agent.start();
        const answer = harness.talk('wait');
        await harness.next((event) => event.type === 'status' && event.status === 'working');
        await harness.agent.stop();
        strictEqual(await answer, 'cancelled');
        strictEqual(harness.recorded('session/cancel').length, 1);
    });
});
describe('LocalAgentProcess: failures a retry cannot fix', { timeout: 20_000 }, () => {
    it('goes fatal at once for a command that does not exist', async () => {
        const harness = new Harness({ manifest: { command: 'flotti-no-such-command' } });
        await rejects(harness.agent.start(), /command not found: flotti-no-such-command/);
        strictEqual(harness.agent.state, 'fatal');
    });
    it('goes fatal at once when the agent wants a login', async () => {
        const harness = new Harness({ fake: { authRequired: true } });
        await rejects(harness.agent.start(), /the agent wants a login first/);
        strictEqual(harness.recorded('started').length, 1);
    });
});
describe('LocalAgentProcess: what the agent gets from its directory', { timeout: 20_000 }, () => {
    it('asks for the manifest model through the session model option', async () => {
        const harness = new Harness({ manifest: { model: 'large' }, fake: { models: ['small', 'large'] } });
        await harness.agent.start();
        deepStrictEqual(harness.recorded('session/set_config_option').map((entry) => entry['params']), [
            { sessionId: harness.agent.sessionId, configId: 'model', value: 'large' }
        ]);
    });
    it('goes fatal at once for a model the agent refuses', async () => {
        const harness = new Harness({ manifest: { model: 'huge' }, fake: { models: ['small'] } });
        await rejects(harness.agent.start(), /the agent refused model "huge"/);
        strictEqual(harness.recorded('started').length, 1);
    });
    it('says so when the agent offers no model option', async () => {
        const harness = new Harness({ manifest: { model: 'large' } });
        await harness.agent.start();
        await harness.next((event) => event.type === 'log' && /model "large" is not applied/.test(event.text));
    });
});
describe('LocalAgentProcess: what Claude Code gets, and where the agent runs', { timeout: 20_000 }, () => {
    it('runs the agent in its workdir and opens the session there', async () => {
        const harness = new Harness();
        await harness.agent.start();
        const [started] = harness.recorded('started');
        strictEqual(realpathSync(String(started?.['cwd'])), realpathSync(harness.directory));
        const [session] = harness.recorded('session/new');
        strictEqual((session?.['params'] as { cwd: string }).cwd, harness.directory);
    });
    it('hands Claude Code the system prompt, the skills and the agent directory', async () => {
        const harness = new Harness({
            manifest: { adapter: 'claude-code' },
            fake: { additionalDirectories: true },
            systemPrompt: 'Be brief.'
        });
        await harness.agent.start();
        const [session] = harness.recorded('session/new');
        deepStrictEqual(session?.['params'], {
            cwd: harness.directory,
            mcpServers: [],
            additionalDirectories: [harness.directory],
            _meta: {
                systemPrompt: { append: 'Be brief.' },
                claudeCode: { options: { plugins: [{ type: 'local', path: harness.directory }] } }
            }
        });
    });
    it('sends no extra directories to an agent that does not support them', async () => {
        const harness = new Harness({ manifest: { adapter: 'claude-code' } });
        await harness.agent.start();
        const [session] = harness.recorded('session/new');
        strictEqual((session?.['params'] as Record<string, unknown>)['additionalDirectories'], undefined);
    });
});
describe('LocalAgentProcess: what Codex and adapterless agents get', { timeout: 20_000 }, () => {
    it('hands Codex the system prompt in CODEX_CONFIG and links its skills where Codex looks', async () => {
        const harness = new Harness({
            manifest: { adapter: 'codex', env: { CODEX_CONFIG: '{"model_reasoning_effort":"high"}' } },
            fake: { additionalDirectories: true },
            systemPrompt: 'Be brief.'
        });
        await harness.agent.start();
        const [started] = harness.recorded('started');
        deepStrictEqual(JSON.parse(String(started?.['codexConfig'])), {
            developer_instructions: 'Be brief.',
            model_reasoning_effort: 'high'
        });
        strictEqual(readlinkSync(join(harness.directory, '.agents', 'skills')), join(harness.directory, 'skills'));
        const [session] = harness.recorded('session/new');
        deepStrictEqual((session?.['params'] as Record<string, unknown>)['additionalDirectories'], [harness.directory]);
    });
    it('says the system prompt is not passed to an agent without an adapter', async () => {
        const harness = new Harness({ systemPrompt: 'Be brief.' });
        await harness.agent.start();
        await harness.next((event) => event.type === 'log' && /system-prompt.md is not passed on/.test(event.text));
    });
});
