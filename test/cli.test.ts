import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { RUN_FILE } from '../src/run.js';
import { FAKE_AGENT, eventually, isAlive } from './local-agent-helpers.js';
const CLI = fileURLToPath(new URL('../src/index.js', import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), 'flotti-cli-'));
const children: ChildProcess[] = [];
after(() => {
    children.forEach((child) => child.kill('SIGKILL'));
    rmSync(workspace, { recursive: true, force: true });
});
/** A fleet with one local agent: the pretend ACP agent, recording what it is asked. */
function fleetWithAgent(name: string): { fleet: string; record: string } {
    const fleet = join(workspace, name);
    const directory = join(fleet, 'local', 'echo');
    mkdirSync(directory, { recursive: true });
    const record = join(directory, 'record.jsonl');
    writeFileSync(join(directory, 'agent.json'), JSON.stringify({
        command: process.execPath,
        arguments: [FAKE_AGENT],
        env: { FAKE_ACP: JSON.stringify({ record }) }
    }));
    return { fleet, record };
}
/** Starts `flotti run` and resolves with the dashboard address once it prints it. */
function run(fleet: string): Promise<{ child: ChildProcess; url: string; output: () => string }> {
    const child = spawn(process.execPath, [CLI, 'run', '--fleet', fleet, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    return new Promise((resolve, reject) => {
        const read = (chunk: Buffer): void => {
            output += chunk.toString();
            const found = /Dashboard: (http:\/\/\S+)/.exec(output);
            if (found?.[1] !== undefined) {
                resolve({ child, url: found[1], output: () => output });
            }
        };
        child.stdout?.on('data', read);
        child.stderr?.on('data', read);
        child.once('exit', (code) => reject(new Error(`flotti run exited with ${code}: ${output}`)));
    });
}
/**
 * Runs flotti to the end. Not with spawnSync: `flotti stop` waits for the
 * running flotti to be gone, and a child of a parent blocked in spawnSync
 * stays a zombie — alive as far as `kill(pid, 0)` can tell.
 */
function cli(...args: string[]): Promise<{ status: number | null; output: string }> {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    return new Promise((resolve) => child.once('close', (status) => resolve({ status, output })));
}
/** Asks again and again until the answer passes the test; fails after ten seconds. */
async function poll<T>(get: () => Promise<T>, test: (value: T) => boolean): Promise<T> {
    const until = Date.now() + 10_000;
    for (;;) {
        const value = await get();
        if (test(value) || Date.now() > until) {
            return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
function started(record: string): number[] {
    if (!existsSync(record)) {
        return [];
    }
    return readFileSync(record, 'utf8').trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string; pid: number })
        .flatMap((entry) => (entry.event === 'started' ? [entry.pid] : []));
}
test('run starts the fleet and the dashboard; stop stops both', async () => {
    const { fleet, record } = fleetWithAgent('fleet-run');
    const { child, url } = await run(fleet);
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    ok(existsSync(join(fleet, RUN_FILE)), 'run leaves the run file for stop');
    await eventually(() => started(record).length === 1, 10_000);
    const agents = await poll(async () =>
        await (await fetch(new URL('/api/agents', url))).json() as { id: string; status: string }[],
    (list) => list[0]?.status === 'idle');
    deepStrictEqual(agents.map((agent) => [agent.id, agent.status]), [['echo', 'idle']]);
    const second = await cli('run', '--fleet', fleet, '--port', '0');
    strictEqual(second.status, 1);
    match(second.output, /flotti already runs this fleet/);
    const stop = await cli('stop', '--fleet', fleet);
    strictEqual(stop.status, 0, stop.output);
    strictEqual(await exited, 0);
    const [pid] = started(record);
    await eventually(() => pid !== undefined && !isAlive(pid), 5000);
    ok(!existsSync(join(fleet, RUN_FILE)), 'the run file goes with flotti');
});
test('stop with nothing running says so', async () => {
    const fleet = join(workspace, 'fleet-idle');
    mkdirSync(fleet, { recursive: true });
    const stop = await cli('stop', '--fleet', fleet);
    strictEqual(stop.status, 0);
    match(stop.output, /flotti is not running/);
});
test('commands other than run and stop are refused', async () => {
    const unknown = await cli('agents');
    strictEqual(unknown.status, 1);
    match(unknown.output, /Unknown command "agents"/);
    const help = await cli();
    strictEqual(help.status, 0);
    match(help.output, /flotti run/);
    match((await cli('run', '--fleet', join(workspace, 'fleet-idle'), '--port', 'eighty')).output, /"eighty" is not a port/);
});
