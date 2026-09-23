/**
 * Open the dashboard, switch between agents, write to one and to all, restart
 * with the button — against a real `flotti run` whose fleet is two pretend
 * local agents (the ACP agent of the unit tests, as child processes) and one
 * pretend remote agent (a real A2A server with a scripted agent).
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
function localAgent(fleet: string, id: string, adapter?: string): void {
    const directory = join(fleet, 'local', id);
    mkdirSync(directory, { recursive: true });
    const record = join(directory, 'record.jsonl');
    writeFileSync(join(directory, 'agent.json'), JSON.stringify({
        name: id,
        ...(adapter === undefined ? {} : { adapter }),
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
    // A home of its own: the settings page saves the fleet directory in ~/.flotti/settings.json.
    flotti = spawn(process.execPath, [CLI, 'run', '--fleet', fleet, '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: workspace, USERPROFILE: workspace }
    });
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
    localAgent(fleet, 'claude', 'claude-code');
    localAgent(fleet, 'codex', 'codex');
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
    await expect(page.getByRole('tab')).toHaveText([/All agents/, /claude/, /codex/, /eva/, /Settings/]);
    for (const name of ['claude', 'codex', 'eva']) {
        await expect(tab(page, name).locator('[data-status]')).toHaveAttribute('data-status', 'idle');
    }
});
test('the header of an agent names its harness, and says when it is not known', async ({ page }) => {
    await page.goto(url);
    for (const [name, harness] of [['claude', 'claude'], ['codex', 'codex'], ['eva', 'harness unknown']] as const) {
        await tab(page, name).click();
        await expect(page.locator('.agent-header [data-harness]')).toHaveText(harness);
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
/**
 * A pretend Notification, and a page that is out of sight: the headless
 * browser neither shows notifications nor loses focus by itself.
 */
function pretendNotifications(permission: NotificationPermission): void {
    type Shown = { title: string; body: string | undefined; closed: boolean };
    const shown: Shown[] = [];
    let current = permission;
    class PretendNotification {
        static get permission(): NotificationPermission {
            return current;
        }
        static requestPermission(): Promise<NotificationPermission> {
            current = 'granted';
            return Promise.resolve(current);
        }
        onclick: (() => void) | null = null;
        private readonly record: Shown;
        constructor(title: string, options?: NotificationOptions) {
            this.record = { title, body: options?.body, closed: false };
            shown.push(this.record);
        }
        close(): void {
            this.record.closed = true;
        }
    }
    Object.assign(window, { Notification: PretendNotification, shownNotifications: shown });
    document.hasFocus = () => false;
}
const notifications = (page: Page) => page.evaluate(() => (window as unknown as { shownNotifications: unknown[] }).shownNotifications);
test('a waiting agent stands out, counts in the title and notifies while the page is out of sight', async ({ page }) => {
    await page.addInitScript(pretendNotifications, 'granted');
    await page.goto(url);
    await expect(page).toHaveTitle('flotti');
    await say(page, 'codex', 'permission');
    await expect(tab(page, 'codex')).toHaveClass(/tab-waiting/);
    await expect(page).toHaveTitle('(1) flotti');
    await expect.poll(() => notifications(page)).toEqual([expect.objectContaining({ title: 'codex is waiting for you', closed: false })]);
    await feed(page, 'codex').getByRole('button', { name: 'Allow' }).click();
    await expect(feed(page, 'codex')).toContainText('permission: yes');
    await expect(tab(page, 'codex')).not.toHaveClass(/tab-waiting/);
    await expect(page).toHaveTitle('flotti');
    await expect.poll(() => notifications(page)).toEqual([expect.objectContaining({ closed: true })]);
});
test('asks for permission to notify only when the person clicks for it', async ({ page }) => {
    await page.addInitScript(pretendNotifications, 'default');
    await page.goto(url);
    await page.getByRole('button', { name: 'Notify me' }).click();
    await expect(page.getByRole('button', { name: 'Notify me' })).toHaveCount(0);
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
const settingsRow = (page: Page, id: string) => page.getByRole('list', { name: 'Agents' }).locator(`[data-agent="${id}"]`);
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
test('adds a local agent in the settings, with no file edited by hand, and it answers in its tab', async ({ page }) => {
    await page.goto(url);
    await tab(page, 'Settings').click();
    await page.getByRole('button', { name: 'Add local agent' }).click();
    const form = page.getByRole('form', { name: 'New local agent' });
    await field(page, 'Id').fill('helper');
    await field(page, 'Name').fill('helper');
    await field(page, 'Adapter').selectOption({ label: 'Plain ACP' });
    await field(page, 'Command').fill(process.execPath);
    await field(page, 'Arguments').fill(FAKE_ACP);
    const record = join(workspace, 'fleet', 'local', 'helper', 'record.jsonl');
    await field(page, 'Environment').fill(`FAKE_ACP=${JSON.stringify({ record })}`);
    await field(page, 'System prompt').fill('Help the others.');
    await form.getByRole('button', { name: 'Add agent' }).click();
    await expect(settingsRow(page, 'helper').locator('[data-status]')).toHaveAttribute('data-status', 'idle');
    const manifest = JSON.parse(readFileSync(join(workspace, 'fleet', 'local', 'helper', 'agent.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toEqual({ name: 'helper', command: process.execPath, arguments: [FAKE_ACP], env: { FAKE_ACP: JSON.stringify({ record }) } });
    expect(readFileSync(join(workspace, 'fleet', 'local', 'helper', 'system-prompt.md'), 'utf8')).toBe('Help the others.\n');
    await say(page, 'helper', 'hello helper');
    await expect(feed(page, 'helper')).toContainText('you said: hello helper');
});
test('refuses an agent flotti run would refuse, and says why', async ({ page }) => {
    await page.goto(`${url}#/_settings`);
    await page.getByRole('button', { name: 'Add remote agent' }).click();
    await field(page, 'Id').fill('broken');
    await field(page, 'URL').fill('ftp://nowhere');
    await page.getByRole('button', { name: 'Add agent' }).click();
    await expect(page.getByRole('alert')).toContainText('url must be an http: or https: address');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(settingsRow(page, 'broken')).toHaveCount(0);
});
test('changes an agent in the settings, and it runs on with the change', async ({ page }) => {
    await page.goto(`${url}#/_settings`);
    const before = starts('helper');
    await settingsRow(page, 'helper').getByRole('button', { name: 'Edit' }).click();
    await expect(field(page, 'System prompt')).toHaveValue('Help the others.\n');
    await field(page, 'Name').fill('Helper Two');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(tab(page, 'Helper Two')).toBeVisible();
    await expect.poll(() => starts('helper')).toBe(before + 1);
    await expect(settingsRow(page, 'helper').locator('[data-status]')).toHaveAttribute('data-status', 'idle');
    await say(page, 'Helper Two', 'still you?');
    await expect(feed(page, 'Helper Two')).toContainText('you said: still you?');
    await expect(feed(page, 'Helper Two')).toContainText('you said: hello helper');
});
test('stops and starts an agent from the settings', async ({ page }) => {
    await page.goto(`${url}#/_settings`);
    const row = settingsRow(page, 'helper');
    await row.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(row.locator('[data-status]')).toHaveAttribute('data-status', 'stopped');
    const before = starts('helper');
    await row.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(row.locator('[data-status]')).toHaveAttribute('data-status', 'idle');
    expect(starts('helper')).toBe(before + 1);
});
test('deletes an agent: it stops, and its directory goes to .trash', async ({ page }) => {
    await page.goto(`${url}#/_settings`);
    const row = settingsRow(page, 'helper');
    await row.getByRole('button', { name: 'Delete' }).click();
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(row).toHaveCount(0);
    await expect(tab(page, 'Helper Two')).toHaveCount(0);
    expect(existsSync(join(workspace, 'fleet', 'local', 'helper'))).toBe(false);
    expect(readdirSync(join(workspace, 'fleet', '.trash')).some((name) => name.startsWith('local-helper-'))).toBe(true);
});
test('switches the fleet directory, and saves it for the next run', async ({ page }) => {
    const next = join(workspace, 'fleet-next');
    localAgent(next, 'newcomer');
    await page.goto(`${url}#/_settings`);
    await field(page, 'Fleet directory path').fill(next);
    await page.getByRole('button', { name: 'Switch' }).click();
    await expect(page.getByRole('tab')).toHaveText([/All agents/, /newcomer/, /Settings/]);
    await expect(settingsRow(page, 'newcomer').locator('[data-status]')).toHaveAttribute('data-status', 'idle');
    await expect(page.getByRole('form', { name: 'Fleet directory' })).toContainText(`${next} — saved in`);
    const saved = JSON.parse(readFileSync(join(workspace, '.flotti', 'settings.json'), 'utf8')) as { fleet: string };
    expect(saved.fleet).toBe(next);
    expect(existsSync(join(next, '.flotti-run.json'))).toBe(true);
    expect(existsSync(join(workspace, 'fleet', '.flotti-run.json'))).toBe(false);
});
