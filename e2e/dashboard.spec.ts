/**
 * Open the dashboard, switch between agents, write to one and to all, restart
 * with the button — against a real `flotti run` whose fleet is two pretend
 * local agents (the ACP agent of the unit tests, as child processes) and one
 * pretend remote agent (a real A2A server with a scripted agent).
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { TaskState } from '@a2a-js/sdk';
// The compiled helpers of the unit tests: `npm run test:e2e` builds them first.
import { FakeAgent, agentMessage, said, statusUpdate, task } from '../build-test/test/a2a-fake-server.js';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'build', 'index.js');
const FAKE_ACP = join(ROOT, 'build-test', 'test', 'fake-acp-agent.js');
const workspace = mkdtempSync(join(tmpdir(), 'flotti-e2e-'));
let flotti: ChildProcess | undefined;
let remote: InstanceType<typeof FakeAgent> | undefined;
let url = '';
function localAgent(fleet: string, id: string): void {
    const directory = join(fleet, 'local', id);
    mkdirSync(directory, { recursive: true });
    const record = join(directory, 'record.jsonl');
    writeFileSync(join(directory, 'agent.json'), JSON.stringify({
        name: id,
        command: process.execPath,
        arguments: [FAKE_ACP],
        env: { FAKE_ACP: JSON.stringify({ record }) }
    }));
}
async function remoteAgent(fleet: string, id: string): Promise<void> {
    remote = await new FakeAgent({
        streaming: true,
        script: async (context, bus) => {
            bus.publish(task(context, TaskState.TASK_STATE_WORKING));
            bus.publish(statusUpdate(context.taskId, context.contextId, TaskState.TASK_STATE_COMPLETED, agentMessage(`echo: ${said(context)}`, context)));
            bus.finished();
        }
    }).listen();
    const directory = join(fleet, 'remote', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'agent.json'), JSON.stringify({ name: id, url: remote.url }));
}
function startFlotti(fleet: string): Promise<string> {
    flotti = spawn(process.execPath, [CLI, 'run', '--fleet', fleet, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    return new Promise((resolve, reject) => {
        const read = (chunk: Buffer): void => {
            output += chunk.toString();
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
function starts(id: string): number {
    const record = join(workspace, 'fleet', 'local', id, 'record.jsonl');
    return existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter((line) => line.includes('"started"')).length : 0;
}
test.beforeAll(async () => {
    const fleet = join(workspace, 'fleet');
    localAgent(fleet, 'claude');
    localAgent(fleet, 'codex');
    await remoteAgent(fleet, 'eva');
    url = await startFlotti(fleet);
});
test.afterAll(async () => {
    const exited = new Promise((resolve) => flotti?.once('exit', resolve));
    flotti?.kill('SIGTERM');
    await exited;
    await remote?.close();
    rmSync(workspace, { recursive: true, force: true });
});
const tab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) });
const feed = (page: Page, name: string) => page.getByRole('log', { name: `Output of ${name}` });
async function say(page: Page, name: string, text: string): Promise<void> {
    await tab(page, name).click();
    const field = page.getByRole('textbox', { name: `Message to ${name}` });
    await field.fill(text);
    await field.press('Enter');
}
test('every agent has a tab with its status', async ({ page }) => {
    await page.goto(url);
    await expect(page.getByRole('tab')).toHaveText([/All agents/, /claude/, /codex/, /eva/]);
    for (const name of ['claude', 'codex', 'eva']) {
        await expect(tab(page, name).locator('[data-status]')).toHaveAttribute('data-status', 'idle');
    }
});
test('writes to one agent, and the answer stays in its tab', async ({ page }) => {
    await page.goto(url);
    await say(page, 'claude', 'hello claude');
    await expect(feed(page, 'claude')).toContainText('you said: hello claude');
    await say(page, 'eva', 'hello eva');
    await expect(feed(page, 'eva')).toContainText('echo: hello eva');
    await expect(feed(page, 'eva')).not.toContainText('hello claude');
    await tab(page, 'codex').click();
    await expect(feed(page, 'codex')).not.toContainText('you said');
    await tab(page, 'claude').click();
    await expect(feed(page, 'claude')).toContainText('you said: hello claude');
});
test('a broadcast reaches every agent picked, and each answers in its own tab', async ({ page }) => {
    await page.goto(url);
    await tab(page, 'All agents').click();
    await page.getByRole('checkbox', { name: 'codex' }).uncheck();
    const field = page.getByRole('textbox', { name: 'Message to all agents' });
    await field.fill('ping');
    await page.getByRole('button', { name: 'Send to 2 agents' }).click();
    const deliveries = page.getByRole('list', { name: 'Delivery' }).getByRole('listitem');
    await expect(deliveries).toHaveText([/claude\s*delivered/, /eva\s*delivered/]);
    await tab(page, 'claude').click();
    await expect(feed(page, 'claude')).toContainText('you said: ping');
    await tab(page, 'eva').click();
    await expect(feed(page, 'eva')).toContainText('echo: ping');
    await tab(page, 'codex').click();
    await expect(feed(page, 'codex')).not.toContainText('ping');
});
test('answers a permission request from the tab', async ({ page }) => {
    await page.goto(url);
    await say(page, 'codex', 'permission');
    await expect(tab(page, 'codex').locator('[data-status]')).toHaveAttribute('data-status', 'waiting');
    await feed(page, 'codex').getByRole('button', { name: 'Allow' }).click();
    await expect(feed(page, 'codex')).toContainText('permission: yes');
});
test('the restart button restarts a local agent and starts over with a remote one', async ({ page }) => {
    await page.goto(url);
    const before = starts('claude');
    await tab(page, 'claude').click();
    await page.getByRole('button', { name: 'Restart' }).click();
    await expect.poll(() => starts('claude')).toBe(before + 1);
    await expect(tab(page, 'claude').locator('[data-status]')).toHaveAttribute('data-status', 'idle');
    await say(page, 'claude', 'still there?');
    await expect(feed(page, 'claude')).toContainText('you said: still there?');
    await tab(page, 'eva').click();
    await page.getByRole('button', { name: 'Restart' }).click();
    await expect(feed(page, 'eva')).toContainText('new conversation');
});
test('a page opened later gets the history', async ({ page }) => {
    await page.goto(`${url}#/claude`);
    await expect(feed(page, 'claude')).toContainText('you said: hello claude');
    await expect(feed(page, 'claude')).toContainText('you said: ping');
});
