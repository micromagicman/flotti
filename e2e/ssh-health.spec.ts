/**
 * The health of an SSH connection end to end: a real `flotti run` whose `ssh`
 * is a pretend one (test/fake-ssh.ts) put first in its PATH, a remote agent
 * published on the pretend host, and the tunnel killed while the page watches.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { TaskState } from '@a2a-js/sdk';
import { FakeAgent, agentMessage, said, statusUpdate, task } from '../build-test/test/a2a-fake-server.js';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'build', 'index.js');
const FAKE_SSH = join(ROOT, 'build-test', 'test', 'fake-ssh.js');
const workspace = mkdtempSync(join(tmpdir(), 'flotti-e2e-ssh-'));
const fleet = join(workspace, 'fleet');
const pids = join(workspace, 'pids');
let flotti: ChildProcess | undefined;
let remote: InstanceType<typeof FakeAgent> | undefined;
let url = '';
/** Everything `flotti run` printed: its log. */
let logged = '';
/** `ssh` for flotti: the pretend one, with a home of its own for the pretend host. */
function pretendSsh(): string {
    const home = join(workspace, 'host');
    const bin = join(workspace, 'bin');
    mkdirSync(bin, { recursive: true });
    const config = join(workspace, 'ssh.json');
    writeFileSync(config, JSON.stringify({ home, pids, forwarded: join(workspace, 'forwarded') }));
    const ssh = join(bin, 'ssh');
    writeFileSync(ssh, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SSH}" "${config}" "$@"\n`);
    chmodSync(ssh, 0o755);
    return bin;
}
/** An agent on the pretend host that answers every message, published for flotti with a token. */
async function publishedAgent(): Promise<void> {
    remote = await new FakeAgent({
        streaming: true,
        script: async (context, bus) => {
            bus.publish(task(context, TaskState.TASK_STATE_WORKING));
            bus.publish(statusUpdate(context.taskId, context.contextId, TaskState.TASK_STATE_COMPLETED, agentMessage(`echo: ${said(context)}`, context)));
            bus.finished();
        }
    }).listen();
    const published = join(workspace, 'host', '.flotti', 'a2a');
    mkdirSync(published, { recursive: true });
    writeFileSync(join(published, 'relay.json'), JSON.stringify({ name: 'relay', url: `${remote.url}/`, token: 'e2e-published-token' }));
    const directory = join(fleet, 'remote', 'relay');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'agent.json'), JSON.stringify({ name: 'relay', ssh: 'ops@example.org' }));
}
function environment(bin: string): NodeJS.ProcessEnv {
    return { ...process.env, HOME: workspace, USERPROFILE: workspace, PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` };
}
function startFlotti(bin: string): Promise<string> {
    flotti = spawn(process.execPath, [CLI, 'run', '--fleet', fleet, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], env: environment(bin) });
    let output = '';
    return new Promise((resolve, reject) => {
        const read = (chunk: Buffer): void => {
            output += chunk.toString();
            logged = output;
            const found = /Dashboard: (http:\/\/\S+)/.exec(output);
            if (found?.[1] !== undefined) {
                resolve(found[1]);
            }
        };
        flotti?.stdout?.on('data', read);
        flotti?.stderr?.on('data', read);
        flotti?.once('exit', (code) => reject(new Error(`flotti run exited with ${code}: ${output}`)));
    });
}
/** What `flotti status` prints for the fleet. */
function status(): Promise<string> {
    const child = spawn(process.execPath, [CLI, 'status', '--fleet', fleet], { stdio: ['ignore', 'pipe', 'pipe'], env: environment(join(workspace, 'bin')) });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    return new Promise((resolve) => child.once('close', () => resolve(output)));
}
/** Kills the tunnel that is open now: flotti opens another one by itself. */
function killTunnel(): void {
    const last = readFileSync(pids, 'utf8').split('\n').filter(Boolean).at(-1);
    process.kill(Number(last));
}
test.beforeAll(async () => {
    const bin = pretendSsh();
    await publishedAgent();
    url = await startFlotti(bin);
});
test.afterAll(async () => {
    const exited = new Promise((resolve) => flotti?.once('exit', resolve));
    flotti?.kill('SIGTERM');
    await exited;
    await remote?.close();
    rmSync(workspace, { recursive: true, force: true });
});
const tab = (page: Page) => page.getByRole('tab', { name: /^relay/ });
/** The details of relay, where the health went from the header (#102). */
const details = (page: Page) => page.getByRole('complementary', { name: 'Details of relay' });
const health = (page: Page) => details(page).getByRole('group', { name: 'SSH connection' });
const fact = (page: Page, name: string) => health(page).locator(`[data-fact="${name}"]`);
/** The trouble with the connection, under the header, seen without opening the details. */
const alarm = (page: Page) => page.locator('.health-strip');
async function openRelay(page: Page): Promise<void> {
    await page.goto(url);
    await tab(page).click();
    await page.getByRole('button', { name: 'Details of relay' }).click();
}
test('the details of an agent over SSH show the health of its connection', async ({ page }) => {
    await openRelay(page);
    await expect(page.locator('.agent-header')).not.toContainText('latency');
    await expect(fact(page, 'latency')).toHaveText(/^latency \d+ ms$/);
    await expect(fact(page, 'reconnects')).toHaveText('reconnects 0 · 0 in the last hour');
    await expect(fact(page, 'tunnel up')).toHaveText(/^tunnel up \d+ s$/);
    await expect(health(page)).toHaveAttribute('data-poor', 'false');
    await expect(alarm(page)).toHaveCount(0);
    const field = page.getByRole('textbox', { name: 'Message to relay' });
    await field.fill('ping');
    await field.press('Enter');
    await expect(page.getByRole('log', { name: 'Output of relay' })).toContainText('echo: ping');
    await expect(fact(page, 'last activity')).toHaveText(/^last activity \d+ s ago$/);
});
test('reconnects count live, and frequent ones stand out as a poor connection', async ({ page }) => {
    await openRelay(page);
    await expect(fact(page, 'reconnects')).toHaveText(/^reconnects 0 /);
    for (const count of [1, 2, 3]) {
        killTunnel();
        await expect(fact(page, 'reconnects')).toHaveText(new RegExp(`^reconnects ${count} · ${count} in the last hour · last \\d+ s ago$`));
    }
    await expect(health(page)).toHaveAttribute('data-poor', 'true');
    await expect(health(page)).toContainText('Poor connection: 3 reconnects in the last hour');
    await expect(alarm(page)).toContainText('Poor connection: 3 reconnects in the last hour');
    await page.keyboard.press('Escape');
    await expect(details(page)).toHaveCount(0);
    await alarm(page).getByRole('button', { name: 'Details' }).click();
    await expect(health(page)).toHaveAttribute('data-poor', 'true');
    await expect(tab(page).locator('.tab-poor')).toHaveText('poor connection');
    await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
    const row = page.getByRole('listitem', { name: 'relay' });
    await expect(row.getByRole('group', { name: 'SSH connection' })).toHaveAttribute('data-poor', 'true');
});
test('flotti status shows the latency and the reconnects, and no secret', async () => {
    const output = await status();
    expect(output).toMatch(/ID\s+TYPE\s+HARNESS\s+STATUS\s+LATENCY\s+RECONNECTS\s+UP/);
    expect(output).toMatch(/relay\s+remote\s+-\s+idle\s+\d+ ms\s+3 \(3 in 1 h\)\s+\d+ s\s+POOR: 3 reconnects in the last hour/);
    expect(output).not.toContain('e2e-published-token');
    expect(logged).not.toContain('e2e-published-token');
    expect(readFileSync(join(fleet, 'remote', 'relay', '.flotti-history.jsonl'), 'utf8')).not.toContain('e2e-published-token');
});
test('a tunnel that is down and does not come back is a lost connection, under the header and on the tab', async ({ page }) => {
    const config = join(workspace, 'ssh.json');
    const works = readFileSync(config, 'utf8');
    await page.goto(url);
    await tab(page).click();
    writeFileSync(config, JSON.stringify({ ...JSON.parse(works) as object, refuse: 'ssh: connect to host example.org port 22: Connection refused' }));
    try {
        killTunnel();
        await expect(alarm(page)).toContainText('No connection: the tunnel is down');
        await expect(tab(page).locator('.tab-poor')).toHaveText('no connection');
    } finally {
        writeFileSync(config, works);
    }
    await expect(alarm(page)).not.toContainText('No connection', { timeout: 30_000 });
});
