/**
 * The service worker of the dashboard, the part of Web Push that lives in the
 * browser: a push shows a notification while the dashboard is out of sight,
 * and a withdrawal takes it back. The push is handed to the worker by the
 * browser itself (DevTools protocol), so no push service is involved.
 *
 * A file of its own: the headless shell has no notifications at all, the new
 * headless mode of Chromium has, and a browser channel is set per file.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
const CLI = join(fileURLToPath(new URL('..', import.meta.url)), 'build', 'index.js');
const workspace = mkdtempSync(join(tmpdir(), 'flotti-e2e-push-'));
let flotti: ChildProcess | undefined;
let url = '';
test.use({ channel: 'chromium' });
test.beforeAll(async () => {
    const fleet = join(workspace, 'fleet');
    mkdirSync(fleet);
    flotti = spawn(process.execPath, [CLI, 'run', '--fleet', fleet, '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: workspace, USERPROFILE: workspace, FLOTTI_TELEGRAM_API: 'http://127.0.0.1:1' }
    });
    let output = '';
    url = await new Promise((resolve, reject) => {
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
});
test.afterAll(async () => {
    const exited = new Promise((resolve) => flotti?.once('exit', resolve));
    flotti?.kill('SIGTERM');
    await exited;
    rmSync(workspace, { recursive: true, force: true });
});
/** Registers the worker of the dashboard and returns the way to push to it. */
async function worker(page: Page, context: BrowserContext): Promise<(data: object) => Promise<unknown>> {
    await page.evaluate(() => navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready));
    const cdp = await context.newCDPSession(page);
    const registered = new Promise<string>((resolve) => cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
        const ours = registrations.find((one) => one.scopeURL === new URL('/', url).href && !one.isDeleted);
        if (ours !== undefined) {
            resolve(ours.registrationId);
        }
    }));
    await cdp.send('ServiceWorker.enable');
    const registrationId = await registered;
    return (data) => cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(url).origin, registrationId, data: JSON.stringify(data) });
}
const shown = (page: Page) => page.evaluate(() => navigator.serviceWorker.ready
    .then((ready) => ready.getNotifications())
    .then((all) => all.map((one) => [one.tag, one.title, one.body])));
test('a push shows a notification while the dashboard is out of sight, and a withdrawal takes it back', async ({ page, context }) => {
    await context.grantPermissions(['notifications'], { origin: new URL(url).origin });
    await page.goto(url);
    const push = await worker(page, context);
    const notice = { type: 'show', tag: 'flotti-waiting-reviewer', title: 'reviewer is waiting for you', body: 'Asks for permission: Run npm test', url: `${url}#/reviewer` };
    await push(notice);
    await page.waitForTimeout(300);
    expect(await shown(page)).toEqual([]);
    await (await context.newPage()).bringToFront();
    await push(notice);
    await expect.poll(() => shown(page)).toEqual([['flotti-waiting-reviewer', 'reviewer is waiting for you', 'Asks for permission: Run npm test']]);
    await push({ type: 'withdraw', tag: 'flotti-waiting-reviewer' });
    await expect.poll(() => shown(page)).toEqual([]);
});
test('the settings page offers Web Push on this browser', async ({ page }) => {
    await page.goto(`${url}#/_settings`);
    const section = page.getByRole('form', { name: 'Notifications' });
    await expect(section).toContainText('No browser subscribed yet.');
    await expect(section.getByRole('button', { name: 'Notify this browser' })).toBeEnabled();
});
