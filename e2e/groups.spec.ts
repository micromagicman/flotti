/**
 * The groups of the fleet on the dashboard (docs/groups.md, #152): a fleet
 * with agents but no group offers one click «Everyone»; the tab of a group
 * shows what was said in it and how each member took it; the last group
 * deleted from its tab leaves the section empty (#175). A fleet of its own,
 * since dashboard.spec.ts starts with a group.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'build', 'index.js');
const FAKE_ACP = join(ROOT, 'build-test', 'test', 'fake-acp-agent.js');
const workspace = mkdtempSync(join(tmpdir(), 'flotti-e2e-groups-'));
const fleet = join(workspace, 'fleet');
let flotti: ChildProcess | undefined;
let url = '';
/** A pretend local agent that answers «you said: …» to whatever it gets; asked to `stream`, it is busy until `gate` in its directory is there (#157). */
function localAgent(id: string): void {
    const directory = join(fleet, 'local', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'agent.json'), JSON.stringify({
        name: id, command: process.execPath, arguments: [FAKE_ACP], env: { FAKE_ACP: JSON.stringify({ record: join(directory, 'record.jsonl'), gate: join(directory, 'gate') }) }
    }));
}
function startFlotti(): Promise<string> {
    flotti = spawn(process.execPath, [CLI, 'run', '--fleet', fleet, '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: workspace, USERPROFILE: workspace, FLOTTI_TELEGRAM_API: 'http://127.0.0.1:1' }
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
test.beforeAll(async () => {
    localAgent('claude');
    localAgent('codex');
    url = await startFlotti();
});
test.afterAll(async () => {
    const exited = new Promise((resolve) => flotti?.once('exit', resolve));
    flotti?.kill('SIGTERM');
    await exited;
    rmSync(workspace, { recursive: true, force: true });
});
const section = (page: Page, name: string) => page.getByRole('tablist', { name: 'Sections of the sidebar' }).getByRole('tab', { name: new RegExp(`^${name}`) });
const agentTab = (page: Page, name: string) => page.locator('.sidebar').getByRole('tab', { name: new RegExp(`^${name}`) });
const groupTab = (page: Page) => page.locator('.sidebar').getByRole('tab', { name: /^Group Everyone/ });
const lane = (page: Page) => page.getByRole('log', { name: 'Group Everyone' });
async function openGroups(page: Page): Promise<void> {
    await page.goto(url);
    await section(page, 'Groups').click();
}
test('a fleet with agents but no group says so in the Groups section, and one click puts every agent in one group «Everyone» (#152)', async ({ page }) => {
    await openGroups(page);
    const offer = page.getByRole('note');
    await expect(offer).toContainText('Your agents don\'t see each other yet.');
    await expect(groupTab(page)).toHaveCount(0);
    await offer.getByRole('button', { name: 'Everyone' }).click();
    // The tab of the new group opens, and the section lists it in place of the offer.
    await expect(page.getByRole('region', { name: 'Group Everyone' })).toBeVisible();
    await expect(groupTab(page)).toHaveAttribute('aria-selected', 'true');
    await expect(groupTab(page)).toContainText('2 members · 0 messages');
    await expect(page.getByRole('note')).toHaveCount(0);
    expect(existsSync(join(fleet, 'groups', 'everyone', 'group.json'))).toBe(true);
    const response = await page.request.get(new URL('/api/groups', url).href);
    expect(await response.json()).toEqual([{ id: 'everyone', name: 'Everyone', members: ['claude', 'codex'] }]);
});
test('the tab of a group shows what was said in it — the person\'s message, the answers of the members — and how each member took it (#152)', async ({ page }) => {
    await openGroups(page);
    await groupTab(page).click();
    await expect(page.getByRole('heading', { name: 'Everyone' })).toBeVisible();
    await expect(page.locator('.group-header .member')).toHaveText(['claude', 'codex']);
    const field = page.getByRole('textbox', { name: 'Message to Everyone' });
    await field.fill('hello team');
    await field.press('Enter');
    const message = lane(page).locator('.message-row-user').filter({ hasText: 'hello team' });
    await expect(message).toHaveCount(1);
    await expect(message.locator('.took summary')).toHaveText('claude, codex got it');
    await message.locator('.took summary').click();
    const list = message.getByRole('list', { name: 'How the members took it' });
    await expect(list.locator('.delivery-name')).toHaveText(['claude', 'codex']);
    await expect(list.locator('.delivery-result')).toHaveText(['delivered', 'delivered']);
    // Each member answers in its turn; flotti posts the answer to the group, marked as an answer, with the message it answers quoted.
    const answer = lane(page).locator('.message-peer').filter({ hasText: 'you said: [in group everyone] hello team' });
    await expect(answer).toHaveCount(2);
    await expect(answer.locator('.envelope-bar').first()).toContainText('→ Everyone · answer');
    await expect(answer.locator('.quote').first()).toContainText('hello team');
    await expect(groupTab(page)).toContainText('3 messages');
});
test('a group message and a direct message are each read in one place: the tab of the agent has the person\'s message only, the tab of the group the group\'s, and a group turn lights no agent tab (#172)', async ({ page }) => {
    const feed = page.getByRole('log', { name: 'Output of codex' });
    await page.goto(url);
    await agentTab(page, 'codex').click();
    await expect(feed).toBeVisible();
    // The tab of codex has been seen; the group message and the turn it starts go to the tab of the group.
    await section(page, 'Groups').click();
    await groupTab(page).click();
    const toGroup = page.getByRole('textbox', { name: 'Message to Everyone' });
    await toGroup.fill('group only');
    await toGroup.press('Enter');
    await expect(lane(page).locator('.message-row-user').filter({ hasText: 'group only' })).toHaveCount(1);
    await expect(lane(page).locator('.message-peer').filter({ hasText: 'you said: [in group everyone] group only' })).toHaveCount(2);
    await section(page, 'Agents').click();
    await expect(agentTab(page, 'codex').locator('.unread'), 'a group turn is not new in the tab of the agent').toHaveCount(0);
    await agentTab(page, 'codex').click();
    const toCodex = page.getByRole('textbox', { name: 'Message to codex' });
    await toCodex.fill('direct only');
    await toCodex.press('Enter');
    await expect(feed.locator('.message-row-agent').filter({ hasText: 'you said: direct only' })).toHaveCount(1);
    await expect(feed.locator('.message-row-user'), 'the person\'s message to codex, and no group message').toHaveText([/direct only/]);
    await expect(feed.getByText(/group only|hello team/)).toHaveCount(0);
    await section(page, 'Groups').click();
    await groupTab(page).click();
    await expect(lane(page).locator('.message-row-user').filter({ hasText: 'group only' })).toHaveCount(1);
    await expect(lane(page).getByText('direct only')).toHaveCount(0);
    // A reloaded page reads the same histories the same way.
    await page.reload();
    await section(page, 'Agents').click();
    await agentTab(page, 'codex').click();
    await expect(feed.locator('.message-row-user')).toHaveText([/direct only/]);
});
test('a member busy when the message is posted is «in line» under it, and the fold, the history and a reloaded page say how it ended once it does (#162)', async ({ page }) => {
    const gate = join(fleet, 'local', 'claude', 'gate');
    rmSync(gate, { force: true });
    // claude works on `stream` until the gate is there: busy while the group gets its message.
    await page.goto(url);
    await section(page, 'Agents').click();
    await agentTab(page, 'claude').click();
    const toClaude = page.getByRole('textbox', { name: 'Message to claude' });
    await toClaude.fill('stream');
    await toClaude.press('Enter');
    await expect(agentTab(page, 'claude').locator('[data-status]')).toHaveAttribute('data-status', 'working');
    await openGroups(page);
    await groupTab(page).click();
    const field = page.getByRole('textbox', { name: 'Message to Everyone' });
    await field.fill('who is free');
    await field.press('Enter');
    const message = lane(page).locator('.message-row-user').filter({ hasText: 'who is free' });
    await expect(message.locator('.took summary')).toHaveText('codex got it · claude in line');
    writeFileSync(gate, '');
    await expect(message.locator('.took summary')).toHaveText('claude, codex got it');
    await message.locator('.took summary').click();
    await expect(message.getByRole('list', { name: 'How the members took it' }).locator('.delivery-result')).toHaveText(['delivered', 'delivered']);
    // The history has the outcome too: a page opened later shows it, not «in line».
    await page.reload();
    await section(page, 'Groups').click();
    await groupTab(page).click();
    await expect(lane(page).locator('.message-row-user').filter({ hasText: 'who is free' }).locator('.took summary')).toHaveText('claude, codex got it');
    rmSync(gate, { force: true });
});
test('a mention addresses one member: @codex answers and the others do not, the @ picker offers the members, and the row shows a chip (#174)', async ({ page }) => {
    await openGroups(page);
    await groupTab(page).click();
    const field = page.getByRole('textbox', { name: 'Message to Everyone' });
    // The @ picker: @ offers the members, the query filters them, Enter inserts `@codex `.
    await field.fill('@');
    const picker = page.getByRole('listbox', { name: 'Mention a member' });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('option')).toHaveCount(2);
    await field.pressSequentially('codex');
    await expect(picker.getByRole('option')).toHaveCount(1);
    await field.press('Enter');
    await expect(field).toHaveValue('@codex ');
    await field.fill('@codex please review');
    await field.press('Enter');
    // The row shows the mention as a chip with the member's name.
    const message = lane(page).locator('.message-row-user').filter({ hasText: 'please review' });
    await expect(message).toHaveCount(1);
    await expect(message.locator('.mention')).toHaveText(['codex']);
    // Only the mentioned member answers; the other member's turn is not posted.
    await expect(lane(page).locator('.message-peer').filter({ hasText: 'in group everyone, to you' })).toHaveCount(1);
    await expect(lane(page).locator('.message-peer').filter({ hasText: 'in group everyone, to codex' })).toHaveCount(0);
});
test('the last group deleted from its tab leaves the Groups section empty: the offer of «Everyone» and Add group, which is open (#175)', async ({ page }) => {
    await openGroups(page);
    await groupTab(page).click();
    await page.locator('.group-header').getByRole('button', { name: 'Edit' }).click();
    const form = page.getByRole('form', { name: 'Group everyone' });
    await form.getByRole('button', { name: 'Delete' }).click();
    await expect(form).toContainText('Move the group Everyone and its history to .trash in the fleet directory?');
    await form.getByRole('button', { name: 'Delete' }).click();
    await expect(groupTab(page)).toHaveCount(0);
    await expect(section(page, 'Groups')).toHaveAttribute('aria-selected', 'true');
    const offer = page.getByRole('note');
    await expect(offer).toContainText('Your agents don\'t see each other yet.');
    await expect(offer, 'the empty section does not point to Settings').not.toContainText('Settings');
    await expect(page.locator('.sidebar').getByRole('tab').last()).toHaveText(/^Add group/);
    await expect(page.locator('.sidebar').getByRole('tab', { name: /^Add group/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('form', { name: 'New group' })).toBeVisible();
    expect(existsSync(join(fleet, 'groups', 'everyone'))).toBe(false);
    // The one click stays one click.
    await offer.getByRole('button', { name: 'Everyone' }).click();
    await expect(page.getByRole('region', { name: 'Group Everyone' })).toBeVisible();
    expect(existsSync(join(fleet, 'groups', 'everyone', 'group.json'))).toBe(true);
});
