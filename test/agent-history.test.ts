import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { AgentEvent } from '../src/agent-events.js';
import { HISTORY_FILE } from '../src/agent-history.js';
import { Supervisor } from '../src/supervisor.js';
import type { SupervisorOptions } from '../src/supervisor.js';
import { fakeFleet } from './fake-fleet-agent.js';
import type { Fleet } from '../src/types.js';
const workspace = mkdtempSync(join(tmpdir(), 'flotti-history-'));
after(() => rmSync(workspace, { recursive: true, force: true }));
let made = 0;
/** A fleet of fake agents whose directories are real, so their history has somewhere to go. */
function fleetOnDisk(...ids: string[]): { fleet: Fleet; directory: (id: string) => string; groupDirectory: string } {
    const root = join(workspace, `fleet-${++made}`);
    const { fleet } = fakeFleet(...ids);
    const agents = fleet.agents.map((agent) => {
        const directory = join(root, 'local', agent.id);
        mkdirSync(directory, { recursive: true });
        return { ...agent, directory, manifestPath: join(directory, 'agent.json') };
    });
    const groupDirectory = join(root, 'groups', 'everyone');
    mkdirSync(groupDirectory, { recursive: true });
    const groups = fleet.groups.map((group) => ({ ...group, directory: groupDirectory, filePath: join(groupDirectory, 'group.json') }));
    return { fleet: { ...fleet, location: { path: root, source: 'argument' }, agents, groups }, directory: (id) => join(root, 'local', id), groupDirectory };
}
/** One run of flotti over the fleet: fresh fakes each time, as after a restart. */
function run(fleet: Fleet, options: SupervisorOptions = {}) {
    const { fakes, createAgent } = fakeFleet(...fleet.agents.map((agent) => agent.id));
    const warnings: string[] = [];
    const supervisor = new Supervisor(fleet, {
        createAgent,
        queuedAfterMs: 50,
        persistHistory: true,
        warn: (text) => warnings.push(text),
        ...options
    });
    return { supervisor, fakes, warnings };
}
function texts(events: readonly AgentEvent[]): string[] {
    return events.flatMap((event) => (event.type === 'message' || event.type === 'log' ? [event.text] : []));
}
function onDisk(directory: string): AgentEvent[] {
    return readFileSync(join(directory, HISTORY_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as AgentEvent);
}
test('the conversation of an agent is there again after flotti is started anew', async () => {
    const { fleet } = fleetOnDisk('a');
    const first = run(fleet);
    await first.supervisor.start();
    await first.supervisor.send('a', 'hello');
    await first.supervisor.stop();
    const before = first.supervisor.history('a');
    const second = run(fleet);
    const restored = second.supervisor.history('a');
    deepStrictEqual(restored.slice(0, before.length), before, 'the events of the last run, numbers and all');
    const marker = restored.at(-1);
    strictEqual(marker?.type, 'log');
    ok(marker.type === 'log' && marker.source === 'flotti' && /started again/.test(marker.text));
    await second.supervisor.start();
    await second.supervisor.send('a', 'again');
    const seqs = second.supervisor.history('a').map((event) => event.seq);
    deepStrictEqual(seqs, seqs.map((_, index) => index + 1), 'numbers go on from where they stopped, with no gap and no repeat');
    deepStrictEqual(texts(second.supervisor.history('a')).filter((text) => !/started again/.test(text)), [
        'hello', 'you said: hello', 'again', 'you said: again'
    ]);
    deepStrictEqual(second.warnings, []);
});
test('a page that saw the last run gets only what came after it', async () => {
    const { fleet } = fleetOnDisk('a');
    const first = run(fleet);
    await first.supervisor.start();
    await first.supervisor.send('a', 'hello');
    await first.supervisor.stop();
    const seen = first.supervisor.history('a').at(-1)?.seq ?? 0;
    const second = run(fleet);
    await second.supervisor.start();
    const missed = second.supervisor.history('a', seen);
    ok(missed.length > 0);
    ok(missed.every((event) => event.seq > seen));
    strictEqual(missed[0]?.type, 'log', 'the first thing it missed is the line about the restart');
});
test('the file is bounded: the oldest events go first, and the newest are kept', async () => {
    const { fleet, directory } = fleetOnDisk('a');
    const first = run(fleet, { historyLimit: 4 });
    await first.supervisor.start();
    for (const word of ['one', 'two', 'three', 'four', 'five']) {
        await first.supervisor.send('a', word);
    }
    await first.supervisor.stop();
    const lines = onDisk(directory('a'));
    ok(lines.length < 8, `the file is rewritten before it holds twice the limit, and holds ${lines.length}`);
    const second = run(fleet, { historyLimit: 4 });
    const restored = second.supervisor.history('a');
    strictEqual(restored.length, 4, 'as many as the limit');
    deepStrictEqual(texts(restored), ['you said: five', 'flotti was started again; everything above is from before.']);
});
test('a torn or broken line costs that line only', async () => {
    const { fleet, directory } = fleetOnDisk('a');
    const first = run(fleet);
    await first.supervisor.start();
    await first.supervisor.send('a', 'hello');
    await first.supervisor.stop();
    appendFileSync(join(directory('a'), HISTORY_FILE), 'not json\n{"seq":1,"type":"log","time":"x"}\n{"seq":99,"ty');
    const second = run(fleet);
    deepStrictEqual(texts(second.supervisor.history('a')), [
        'hello', 'you said: hello', 'flotti was started again; everything above is from before.'
    ]);
    deepStrictEqual(second.warnings, []);
});
test('a changed agent goes on with its history, with no line about a restart', async () => {
    const { fleet } = fleetOnDisk('a');
    const { supervisor } = run(fleet);
    await supervisor.start();
    await supervisor.send('a', 'hello');
    const agent = supervisor.agent('a');
    await supervisor.replace({ ...agent, name: 'Renamed' });
    const history = supervisor.history('a');
    ok(!texts(history).some((text) => /started again/.test(text)));
    ok(texts(history).includes('you said: hello'));
    await supervisor.stop();
});
test('a history that cannot be read is reported once and does not stop the agent', async () => {
    const { fleet, directory } = fleetOnDisk('a');
    mkdirSync(join(directory('a'), HISTORY_FILE));
    const { supervisor, warnings } = run(fleet);
    await supervisor.start();
    await supervisor.send('a', 'hello');
    strictEqual(warnings.length, 1);
    ok(warnings[0]?.includes(HISTORY_FILE));
    deepStrictEqual(texts(supervisor.history('a')), ['hello', 'you said: hello']);
    await supervisor.stop();
});
test('without persistHistory nothing is written', async () => {
    const { fleet, directory } = fleetOnDisk('a');
    const { supervisor } = run(fleet, { persistHistory: false });
    await supervisor.start();
    await supervisor.send('a', 'hello');
    await supervisor.stop();
    ok(!existsSync(join(directory('a'), HISTORY_FILE)));
    const second = run(fleet);
    deepStrictEqual(second.supervisor.history('a'), []);
});
test('a message that waited in line when flotti stopped is said to be dropped, not waiting for ever', async () => {
    const { fleet } = fleetOnDisk('a');
    const first = run(fleet);
    await first.supervisor.start();
    const busy = first.fakes.get('a');
    ok(busy !== undefined);
    busy.busy = true;
    await first.supervisor.send('a', 'in line', { messageId: 'q-1' });
    await first.supervisor.stop();
    const second = run(fleet);
    const history = second.supervisor.history('a');
    const dropped = history.at(-1);
    ok(dropped?.type === 'unqueued', `the last event is ${dropped?.type}`);
    deepStrictEqual([dropped.messageId, dropped.outcome, dropped.reason], ['q-1', 'dropped', 'flotti restarted']);
    strictEqual(history.at(-2)?.type, 'log', 'right after the line about the restart');
    const seqs = history.map((event) => event.seq);
    deepStrictEqual(seqs, seqs.map((_, index) => index + 1));
    await second.supervisor.start();
    await second.supervisor.send('a', 'again');
    const after = second.supervisor.history('a').map((event) => event.seq);
    deepStrictEqual(after, after.map((_, index) => index + 1), 'numbers go on with no gap and no repeat');
});
/** Waits for the condition, a little at a time; fails once two seconds are up. */
async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('the condition did not come true in time');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
test('the messages of a group are there again after flotti is started anew, and are numbered on (docs/groups.md)', async () => {
    const { fleet, groupDirectory } = fleetOnDisk('a', 'b');
    const first = run(fleet);
    await first.supervisor.start();
    await first.supervisor.sendToGroup('everyone', 'hello');
    await until(() => first.supervisor.groupHistory('everyone').length === 3);
    await first.supervisor.stop();
    const before = first.supervisor.groupHistory('everyone');
    deepStrictEqual(before.map((message) => [message.seq, message.from, message.text]), [[1, undefined, 'hello'], [2, 'a', 'you said: hello'], [3, 'b', 'you said: hello']]);
    const second = run(fleet);
    deepStrictEqual(second.supervisor.groupHistory('everyone'), before, 'the messages of the last run, numbers and all');
    await second.supervisor.start();
    const again = await second.supervisor.sendToGroup('everyone', 'again');
    strictEqual(again.seq, 4, 'numbers go on from where they stopped');
    await until(() => second.supervisor.groupHistory('everyone').length === 6);
    const onDisk = readFileSync(join(groupDirectory, HISTORY_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { seq: number; groupId?: string });
    deepStrictEqual(onDisk.map((line) => line.seq), [1, 2, 3, 4, 5, 6]);
    strictEqual(onDisk[0]?.groupId, 'everyone');
    deepStrictEqual(second.warnings, []);
    await second.supervisor.stop();
});
test('how a member in line took a group message is in the file once known, and there again after a restart (#162)', async () => {
    const { fleet, groupDirectory } = fleetOnDisk('a', 'b');
    const first = run(fleet);
    await first.supervisor.start();
    const b = first.fakes.get('b');
    if (b === undefined) {
        throw new Error('no fake for b');
    }
    b.busy = true;
    const posted = await first.supervisor.sendToGroup('everyone', 'hello');
    deepStrictEqual(posted.deliveries, [{ agentId: 'a', result: 'taken' }, { agentId: 'b', result: 'queued' }]);
    // a answers; its answer is posted as the second line, in line for b as well.
    await until(() => first.supervisor.groupHistory('everyone').length === 2);
    b.release();
    await until(() => first.supervisor.groupHistory('everyone').length === 3 && first.supervisor.groupHistory('everyone').every((message) => message.deliveries.every((delivery) => delivery.result === 'taken')));
    await first.supervisor.stop();
    const before = first.supervisor.groupHistory('everyone');
    deepStrictEqual(before[0]?.deliveries, [{ agentId: 'a', result: 'taken' }, { agentId: 'b', result: 'taken' }]);
    const onDisk = readFileSync(join(groupDirectory, HISTORY_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { seq: number; deliveries: { result: string }[] });
    deepStrictEqual(onDisk.filter((line) => line.seq === 1).map((line) => line.deliveries.map((delivery) => delivery.result)), [['taken', 'queued'], ['taken', 'taken']], 'the line is written again with the outcome, after the first');
    const second = run(fleet);
    deepStrictEqual(second.supervisor.groupHistory('everyone'), before, 'the later line of a number is the one that counts');
    deepStrictEqual(second.warnings, []);
});
test('without persistHistory the messages of a group stay in memory', async () => {
    const { fleet, groupDirectory } = fleetOnDisk('a');
    const { supervisor } = run(fleet, { persistHistory: false });
    await supervisor.start();
    await supervisor.sendToGroup('everyone', 'hello');
    strictEqual(supervisor.groupHistory('everyone').length >= 1, true);
    strictEqual(existsSync(join(groupDirectory, HISTORY_FILE)), false);
    await supervisor.stop();
});
test('the history file of a member keeps every event of a group turn, each with the group: the page hides them, the file loses none (0.7.0, #172)', async () => {
    const { fleet, directory } = fleetOnDisk('a', 'b');
    const { supervisor } = run(fleet);
    await supervisor.start();
    await supervisor.sendToGroup('everyone', 'hello');
    await until(() => supervisor.groupHistory('everyone').length === 3);
    await supervisor.send('a', 'just to you');
    await supervisor.stop();
    const turns = onDisk(directory('a')).filter((event) => event.type !== 'status');
    deepStrictEqual(turns.map((event) => [event.type === 'message' ? event.text : event.type, event.group]), [
        ['hello', 'everyone'],
        ['you said: hello', 'everyone'],
        ['turn-end', 'everyone'],
        ['you said: hello', 'everyone'],
        ['you said: you said: hello', 'everyone'],
        ['turn-end', 'everyone'],
        ['just to you', undefined],
        ['you said: just to you', undefined],
        ['turn-end', undefined]
    ]);
});
