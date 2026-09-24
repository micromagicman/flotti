import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Harness, eventually } from './local-agent-helpers.js';
/** The prompts the pretend agent got: the text, and whether it went to the session named. */
function prompts(harness: Harness, session: string | undefined): [unknown, boolean][] {
    return harness.recorded('session/prompt').map((entry) => [entry['text'], entry['sessionId'] === session]);
}
describe('LocalAgentProcess: clearing the context', { timeout: 20_000 }, () => {
    it('opens a new session in the running process: the next message goes without the old conversation', async () => {
        const harness = new Harness({ fake: { resume: true } });
        await harness.agent.start();
        const session = harness.agent.sessionId;
        strictEqual(await harness.talk('before'), 'end_turn');
        await harness.agent.clearContext();
        notStrictEqual(harness.agent.sessionId, session);
        ok(harness.agent.sessionId !== undefined);
        strictEqual(await harness.talk('after'), 'end_turn');
        deepStrictEqual(prompts(harness, session), [['before', true], ['after', false]]);
        strictEqual(harness.recorded('started').length, 1, 'the process is not restarted');
        strictEqual(harness.recorded('session/new').length, 2);
        ok(harness.events.some((event) => event.type === 'message' && event.text === 'you said: after'));
    });
    it('cancels the message in work, and the message in line goes to the new session', async () => {
        const harness = new Harness();
        await harness.agent.start();
        const session = harness.agent.sessionId;
        const waiting = harness.talk('wait');
        await harness.next((event) => event.type === 'status' && event.status === 'working');
        const queued = harness.agent.send('next');
        await harness.agent.clearContext();
        strictEqual(await waiting, 'cancelled');
        await queued;
        await eventually(() => harness.recorded('session/prompt').length === 2);
        deepStrictEqual(prompts(harness, session), [['wait', true], ['next', false]]);
        strictEqual(harness.recorded('session/cancel').length, 1);
    });
    it('a restart after it picks up the new session, not the old one', async () => {
        const harness = new Harness({ fake: { resume: true } });
        await harness.agent.start();
        await harness.agent.clearContext();
        const cleared = harness.agent.sessionId;
        await harness.agent.restart();
        strictEqual(harness.agent.sessionId, cleared);
        deepStrictEqual(harness.recorded('session/resume').map((entry) =>
            (entry['params'] as { sessionId: string }).sessionId), [cleared]);
    });
});
