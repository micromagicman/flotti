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
import type { Locator, Page } from '@playwright/test';
import { TaskState } from '@a2a-js/sdk';
// The compiled helpers of the unit tests: `npm run test:e2e` builds them first.
import { FakeAgent, agentMessage, said, statusUpdate, task } from '../build-test/test/a2a-fake-server.js';
import { INBOX_EXTENSION } from '../build-test/src/a2a-agent.js';
import { FakeTelegram } from '../build-test/test/fake-telegram.js';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'build', 'index.js');
const FAKE_ACP = join(ROOT, 'build-test', 'test', 'fake-acp-agent.js');
const workspace = mkdtempSync(join(tmpdir(), 'flotti-e2e-'));
let flotti: ChildProcess | undefined;
let remote: InstanceType<typeof FakeAgent> | undefined;
/** A pretend Telegram Bot API: flotti is pointed at it, no real bot or chat is used. */
let telegram: FakeTelegram | undefined;
let url = '';
/** @param fake What the pretend agent does besides recording; `mcpHttp` makes it take the fleet tools, and memory with them. */
function localAgent(fleet: string, id: string, adapter?: string, fake: Record<string, unknown> = {}): void {
    const directory = join(fleet, 'local', id);
    mkdirSync(directory, { recursive: true });
    const record = join(directory, 'record.jsonl');
    writeFileSync(join(directory, 'agent.json'), JSON.stringify({
        name: id,
        ...(adapter === undefined ? {} : { adapter }),
        command: process.execPath,
        arguments: [FAKE_ACP],
        env: { FAKE_ACP: JSON.stringify({ record, ...fake }) }
    }));
}
/**
 * What the remote agent says of its own when asked to `write later`: a line of
 * progress and then a message, through the inbox — after the turn is over.
 * Asked to `write to claude`, it sends a message to that agent the same way;
 * asked to `give claude a task`, it gives that agent a task.
 */
async function remoteAgent(fleet: string, id: string): Promise<void> {
    let inbox: ((text: string, kind: string, to?: string, extra?: Record<string, unknown>) => void) | undefined;
    /** A request of an administrator of the fleet, through the inbox as well. */
    let admin: ((action: string, agent: string) => void) | undefined;
    remote = await new FakeAgent({
        streaming: true,
        extensions: [INBOX_EXTENSION],
        script: async (context, bus) => {
            bus.publish(task(context, TaskState.TASK_STATE_WORKING));
            if ((context.userMessage.metadata?.[INBOX_EXTENSION] as { action?: string } | undefined)?.action === 'subscribe') {
                let count = 0;
                inbox = (text, kind, to, extra) => bus.publish(statusUpdate(context.taskId, context.contextId, TaskState.TASK_STATE_WORKING, {
                    ...agentMessage(text, context, `own-${++count}`),
                    metadata: { [INBOX_EXTENSION]: { kind, ...(to === undefined ? {} : { to }), ...extra } }
                }));
                admin = (action, agent) => bus.publish(statusUpdate(context.taskId, context.contextId, TaskState.TASK_STATE_WORKING, {
                    ...agentMessage('', context, `own-${++count}`),
                    metadata: { [INBOX_EXTENSION]: { kind: 'admin', action, agent } }
                }));
                await new Promise(() => undefined);
            }
            bus.publish(statusUpdate(context.taskId, context.contextId, TaskState.TASK_STATE_COMPLETED, agentMessage(`echo: ${said(context)}`, context)));
            bus.finished();
            if (said(context) === 'write later') {
                setTimeout(() => {
                    inbox?.('Checking the pipeline', 'progress');
                    inbox?.('The merge request is ready', 'message');
                }, 100);
            }
            if (said(context) === 'write to claude') {
                setTimeout(() => inbox?.('Please rerun the e2e job', 'message', 'claude'), 100);
            }
            if (said(context) === 'give claude a task') {
                setTimeout(() => inbox?.('Collect the failing tests', 'message', 'claude', { task: {} }), 100);
            }
            if (said(context) === 'clear codex') {
                setTimeout(() => admin?.('clear-context', 'codex'), 100);
            }
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
        env: { ...process.env, HOME: workspace, USERPROFILE: workspace, FLOTTI_TELEGRAM_API: telegram?.url ?? 'http://127.0.0.1:1' }
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
/** Notes in the memory bank of an agent, as it would write them. */
function memoryNotes(fleet: string, id: string): void {
    const memory = join(fleet, 'local', id, 'memory');
    mkdirSync(join(memory, 'process'), { recursive: true });
    writeFileSync(join(memory, 'index.md'), '# Home\nStart at [[Release process]]; see also [[missing note]].\n\n<b>not bold</b>\n');
    writeFileSync(join(memory, 'process', 'release.md'), '# Release process\n- [x] build\n- [ ] tag it\n\nBack [[Home|home]].\n');
}
test.beforeAll(async () => {
    const fleet = join(workspace, 'fleet');
    localAgent(fleet, 'claude', 'claude-code', { mcpHttp: true });
    memoryNotes(fleet, 'claude');
    localAgent(fleet, 'codex', 'codex', { mcpHttp: true });
    await remoteAgent(fleet, 'relay');
    telegram = await FakeTelegram.start();
    url = await startFlotti(fleet);
});
test.afterAll(async () => {
    const exited = new Promise((resolve) => flotti?.once('exit', resolve));
    flotti?.kill('SIGTERM');
    await exited;
    await remote?.close();
    await telegram?.close();
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
    await expect(page.getByRole('tab')).toHaveText([/All agents/, /claude/, /codex/, /relay/, /Settings/]);
    for (const name of ['claude', 'codex', 'relay']) {
        await expect(tab(page, name).locator('[data-status]')).toHaveAttribute('data-status', 'idle');
    }
});
test('the page carries the flotti logo in its header and the icon in its tab', async ({ page, request }) => {
    await page.goto(url);
    await expect(page.getByRole('banner').getByRole('img', { name: 'flotti' })).toBeVisible();
    const icons = await page.locator('link[rel="icon"], link[rel="apple-touch-icon"]').evaluateAll(
        (links) => links.map((link) => (link as HTMLLinkElement).href)
    );
    expect(icons.length).toBe(3);
    for (const icon of icons) {
        const response = await request.get(icon);
        expect(response.status(), icon).toBe(200);
        expect(response.headers()['content-type'], icon).toMatch(/^image\//);
    }
});
test('the header of an agent names its harness, and says when it is not known', async ({ page }) => {
    await page.goto(url);
    for (const [name, harness] of [['claude', 'claude'], ['codex', 'codex'], ['relay', 'harness unknown']] as const) {
        await tab(page, name).click();
        await expect(page.locator('.agent-header [data-harness]')).toHaveText(harness);
    }
});
test('writes to one agent, and the answer stays in its tab', async ({ page }) => {
    await page.goto(url);
    await say(page, 'claude', 'hello claude');
    await expect(feed(page, 'claude')).toContainText('you said: hello claude');
    await say(page, 'relay', 'hello relay');
    await expect(feed(page, 'relay')).toContainText('echo: hello relay');
    await expect(feed(page, 'relay')).not.toContainText('hello claude');
    await tab(page, 'codex').click();
    await expect(feed(page, 'codex')).not.toContainText('you said');
    await tab(page, 'claude').click();
    await expect(feed(page, 'claude')).toContainText('you said: hello claude');
});
test('what an agent says of its own shows in its tab, local and remote alike', async ({ page }) => {
    await page.goto(url);
    await say(page, 'claude', 'later');
    await expect(feed(page, 'claude')).toContainText('CI is green');
    await expect(feed(page, 'claude')).toContainText('Check CI');
    await say(page, 'relay', 'write later');
    await expect(feed(page, 'relay')).toContainText('echo: write later');
    await expect(feed(page, 'relay').locator('.progress')).toHaveText('Checking the pipeline');
    await expect(feed(page, 'relay').locator('.message-agent').last()).toContainText('The merge request is ready');
});
test('an agent writes to another: both tabs show who wrote to whom, apart from what a person typed', async ({ page }) => {
    await page.goto(url);
    await say(page, 'relay', 'write to claude');
    const sent = feed(page, 'relay').locator('.message-sent');
    await expect(sent.locator('.envelope-bar')).toContainText('relay → claude');
    await expect(sent).toContainText('Please rerun the e2e job');
    await tab(page, 'claude').click();
    const received = feed(page, 'claude').locator('.message-peer');
    await expect(received.locator('.envelope-bar')).toContainText('relay → claude');
    await expect(received).toContainText('Please rerun the e2e job');
    await expect(feed(page, 'claude')).toContainText('you said: [from relay] Please rerun the e2e job');
});
const lane = (page: Page) => page.getByRole('log', { name: 'Conversation of relay and claude' });
const pairTab = (page: Page) => page.getByRole('tab', { name: /^Conversation of relay and claude/ });
test('the conversation of two agents has a tab of its own: one lane, read-only, with the way to write to either', async ({ page }) => {
    await page.goto(url);
    await pairTab(page).click();
    // The message of relay, and the answer claude sends back to it (#45): it says the same words.
    const [message, answer] = [lane(page).locator('.lane-row').nth(0), lane(page).locator('.lane-row').nth(1)];
    await expect(message.locator('.envelope-bar')).toContainText('relay → claude');
    await expect(message).toContainText('Please rerun the e2e job');
    await expect(message).toHaveClass(/lane-first/);
    await expect(answer.locator('.envelope-bar')).toContainText('claude → relay');
    await expect(answer).toContainText('you said: [from relay] Please rerun the e2e job');
    await expect(answer).toHaveClass(/lane-second/);
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await page.getByRole('button', { name: 'Write to claude' }).click();
    await expect(page.getByRole('textbox', { name: 'Message to claude' })).toBeVisible();
});
/** The colour an element is painted with: the fill of a mark, the bar of an envelope. */
const fill = (element: ReturnType<Page['locator']>) => element.evaluate((node) => getComputedStyle(node).backgroundColor);
async function relayColors(page: Page): Promise<string[]> {
    await tab(page, 'relay').click();
    const colors = [
        await fill(tab(page, 'relay').locator('.agent-mark')),
        await fill(page.locator('.agent-header .agent-mark')),
        await fill(feed(page, 'relay').locator('.message-sent .envelope-bar').first())
    ];
    await pairTab(page).click();
    colors.push(await fill(lane(page).locator('.lane-first .envelope-bar').first()), await fill(page.locator('.lane-title .agent-mark').first()));
    return colors;
}
test('an agent has one colour in the sidebar, in the header of its tab, on its envelopes and in a conversation, in both themes', async ({ page }) => {
    for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        await page.goto(url);
        const colors = await relayColors(page);
        expect(new Set(colors).size, `${colorScheme}: ${colors.join(', ')}`).toBe(1);
    }
});
test('on a narrow screen the conversations are one tab away, in the list of them all', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(url);
    await expect(pairTab(page)).toBeHidden();
    await page.getByRole('tab', { name: /^Conversations/ }).click();
    await page.getByRole('list').getByRole('button', { name: /relay ↔ claude/ }).click();
    await expect(lane(page)).toContainText('Please rerun the e2e job');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
const viewButton = (page: Page, name: 'Chat' | 'Memory') => page.getByRole('group', { name: 'View' }).getByRole('button', { name, exact: true });
test('the Memory view of a local agent shows its notes: a tree, a note rendered, [[links]] both ways, search', async ({ page }) => {
    await page.goto(url);
    await tab(page, 'claude').click();
    await viewButton(page, 'Memory').click();
    const notes = page.getByRole('navigation', { name: 'Notes' });
    await expect(notes.getByRole('button')).toHaveText([/Home/, /Release process/]);
    await expect(notes.locator('summary')).toHaveText('process');
    const card = page.locator('.note-card');
    await expect(card.getByRole('heading', { level: 2 })).toHaveText('Home');
    await expect(card.locator('.wikilink-broken')).toHaveText('missing note');
    await expect(card.locator('.md')).toContainText('<b>not bold</b>');
    await card.locator('.md').getByRole('button', { name: 'Release process' }).click();
    await expect(card.getByRole('heading', { level: 2 })).toHaveText('Release process');
    await expect(card.getByRole('checkbox')).toHaveCount(2);
    await expect(card.locator('.backlinks').getByRole('button')).toHaveText(['Home']);
    await page.getByRole('searchbox', { name: 'Search notes' }).fill('see also');
    await expect(notes.getByRole('button')).toHaveText([/Home/]);
    await viewButton(page, 'Chat').click();
    await expect(feed(page, 'claude')).toBeVisible();
    await expect(viewButton(page, 'Chat')).toHaveAttribute('aria-pressed', 'true');
});
test('the Memory view says why a remote agent has no notes to show', async ({ page }) => {
    await page.goto(url);
    await tab(page, 'relay').click();
    await viewButton(page, 'Memory').click();
    await expect(page.locator('.memory-state')).toContainText('A remote agent keeps its memory on its own machine');
});
test('on a narrow screen the Memory view is the list, then a note with the way back', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(url);
    await tab(page, 'claude').click();
    await viewButton(page, 'Memory').click();
    const notes = page.getByRole('navigation', { name: 'Notes' });
    await expect(page.locator('.note-card')).toBeHidden();
    await notes.getByRole('button', { name: /Release process/ }).click();
    await expect(notes).toBeHidden();
    await expect(page.locator('.note-card').getByRole('heading', { level: 2 })).toHaveText('Release process');
    await page.getByRole('button', { name: '← All notes' }).click();
    await expect(notes).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test('an agent gives another a task: both tabs show who gave it to whom and how it ended, and the outcome comes back', async ({ page }) => {
    await page.goto(url);
    await say(page, 'relay', 'give claude a task');
    const card = feed(page, 'relay').getByRole('group', { name: 'Task from relay to claude: completed' });
    await expect(card.locator('.delegation-bar')).toContainText('task · relay → claude');
    await expect(card).toContainText('Collect the failing tests');
    await expect(card.locator('.delegation-result')).toContainText('you said: [from relay] Task');
    const outcome = feed(page, 'relay').locator('.message-peer').filter({ hasText: 'you said: [from relay] Task' }).last();
    await expect(outcome.locator('.envelope-bar')).toContainText('claude → relay');
    await expect(outcome.locator('.quote')).toContainText('Collect the failing tests');
    await tab(page, 'claude').click();
    await expect(feed(page, 'claude').getByRole('group', { name: 'Task from relay to claude: completed' })).toBeVisible();
    await expect(feed(page, 'claude')).toContainText(/you said: \[from relay\] Task \S+, given to you\./);
});
/** The row of the last message of the tab that says `text`, with its Reply and Forward. */
const messageRow = (page: Page, name: string, text: string, side: 'user' | 'agent' = 'agent') =>
    feed(page, name).locator(`.message-row-${side}`).filter({ hasText: text }).last();
test('a reply quotes the message it answers, the agent reads the quote, and the quote leads back to it', async ({ page }) => {
    await page.goto(url);
    await say(page, 'codex', 'first words');
    // The answer by its place in the feed: the answer to the reply will say "you said: first words" too.
    const seq = await messageRow(page, 'codex', 'you said: first words').getAttribute('data-seq');
    const answer = feed(page, 'codex').locator(`[data-seq="${seq}"]`);
    await answer.hover();
    await answer.getByRole('button', { name: 'Reply' }).click();
    const field = page.getByRole('textbox', { name: 'Reply to codex' });
    await expect(field).toBeFocused();
    await field.fill('and more');
    await field.press('Enter');
    const reply = messageRow(page, 'codex', 'and more', 'user');
    const quote = reply.locator('.quote');
    await expect(quote).toContainText('> codex');
    await expect(quote).toContainText('you said: first words');
    await expect(feed(page, 'codex')).toContainText(/you said: In reply to a message from you:\s*> you said: first words\s*and more/);
    await expect(page.getByRole('textbox', { name: 'Message to codex' })).toBeVisible();
    await quote.getByRole('button', { name: 'Reply to codex: jump to the message' }).click();
    await expect(answer).toHaveClass(/message-found/);
});
test('a message forwarded to another agent says who wrote it, in the tab of the receiver', async ({ page }) => {
    await page.goto(url);
    await say(page, 'codex', 'forward me');
    const answer = messageRow(page, 'codex', 'you said: forward me');
    await answer.hover();
    await answer.getByRole('button', { name: 'Forward' }).click();
    await answer.getByRole('group', { name: 'Forward to' }).getByRole('button', { name: 'claude' }).click();
    await expect(answer.getByRole('status')).toHaveText('Forwarded to claude');
    await tab(page, 'claude').click();
    const forwarded = messageRow(page, 'claude', 'forwarded · codex', 'user');
    await expect(forwarded.locator('.fwd')).toContainText('you said: forward me');
    await expect(feed(page, 'claude')).toContainText(/you said: Forwarded from agent "codex":\s*you said: forward me/);
});
/** Clicks a link of the chat and waits for the tab it opens; the address it opened, with the tab closed again. */
async function openLink(page: Page, link: Locator): Promise<string> {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const [opened] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    await opened.waitForLoadState();
    const address = opened.url();
    await opened.close();
    return address;
}
test('links in messages open in a new tab, and markup in a message stays text', async ({ page }) => {
    await page.goto(url);
    const address = new URL('/?from=chat', url).href;
    await say(page, 'codex', `look at ${address}. Or [the guide](${address}) <img src=x onerror="window.markupRan=1">`);
    const asked = messageRow(page, 'codex', 'look at', 'user');
    const answer = messageRow(page, 'codex', 'you said: look at');
    await expect(asked.getByRole('link', { name: address, exact: true })).toBeVisible();
    expect(await openLink(page, answer.getByRole('link', { name: address, exact: true }))).toBe(address);
    expect(await openLink(page, asked.getByRole('link', { name: 'the guide' }))).toBe(address);
    await expect(answer.locator('.text')).toContainText('<img src=x onerror="window.markupRan=1">');
    await expect(answer.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { markupRan?: number }).markupRan)).toBeUndefined();
});
test('a link opens from the quote of a reply and from a forwarded message', async ({ page }) => {
    await page.goto(url);
    const address = new URL('/?from=quote', url).href;
    await say(page, 'codex', `quote ${address}`);
    // By its place in the feed: the answer to the reply quotes the same words.
    const seq = await messageRow(page, 'codex', `you said: quote ${address}`).getAttribute('data-seq');
    const answer = feed(page, 'codex').locator(`[data-seq="${seq}"]`);
    await answer.hover();
    await answer.getByRole('button', { name: 'Reply' }).click();
    await page.getByRole('textbox', { name: 'Reply to codex' }).fill('seen it');
    await page.getByRole('textbox', { name: 'Reply to codex' }).press('Enter');
    const reply = messageRow(page, 'codex', 'seen it', 'user');
    expect(await openLink(page, reply.locator('.quote').getByRole('link', { name: address }))).toBe(address);
    await answer.hover();
    await answer.getByRole('button', { name: 'Forward' }).click();
    await answer.getByRole('group', { name: 'Forward to' }).getByRole('button', { name: 'claude' }).click();
    await expect(answer.getByRole('status')).toHaveText('Forwarded to claude');
    await tab(page, 'claude').click();
    const forwarded = messageRow(page, 'claude', `you said: quote ${address}`, 'user');
    expect(await openLink(page, forwarded.locator('.fwd').getByRole('link', { name: address }))).toBe(address);
});
test('a broadcast reaches every agent picked, and each answers in its own tab', async ({ page }) => {
    await page.goto(url);
    await tab(page, 'All agents').click();
    await page.getByRole('checkbox', { name: 'codex' }).uncheck();
    const field = page.getByRole('textbox', { name: 'Message to all agents' });
    await expect(page.locator('.composer-count')).toHaveText('2 agents selected');
    await field.fill('ping');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const deliveries = page.getByRole('list', { name: 'Delivery' }).getByRole('listitem');
    await expect(deliveries).toHaveText([/claude\s*delivered/, /relay\s*delivered/]);
    await tab(page, 'claude').click();
    await expect(feed(page, 'claude')).toContainText('you said: ping');
    await tab(page, 'relay').click();
    await expect(feed(page, 'relay')).toContainText('echo: ping');
    await tab(page, 'codex').click();
    await expect(feed(page, 'codex')).not.toContainText('ping');
});
/** The composer of the tab of `name`: the card with the field, the chip of the status, the keys and Send. */
const composer = (page: Page, name: string) => page.locator('.composer').filter({ has: page.getByRole('textbox', { name: `Message to ${name}` }) });
test('the composer: Enter sends, Shift+Enter makes a new line, the field grows with the text and then scrolls', async ({ page }) => {
    await page.goto(url);
    await tab(page, 'claude').click();
    const card = composer(page, 'claude');
    const field = card.getByRole('textbox');
    await expect(card.locator('[data-status]')).toHaveAttribute('data-status', 'idle');
    await expect(card).toContainText('Enter to send');
    await expect(card).toContainText('Shift+Enter new line');
    await expect(field).toHaveAccessibleDescription(/Enter to send/);
    const send = card.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeDisabled();
    const low = (await field.boundingBox())?.height ?? 0;
    await field.fill('first line');
    await field.press('Shift+Enter');
    await field.pressSequentially('second line');
    await expect(field).toHaveValue('first line\nsecond line');
    for (let line = 3; line <= 6; line++) {
        await field.press('Shift+Enter');
        await field.pressSequentially(`line ${line}`);
    }
    const grown = (await field.boundingBox())?.height ?? 0;
    expect(grown).toBeGreaterThan(low + 40);
    await field.fill(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n'));
    const tall = (await field.boundingBox())?.height ?? 0;
    expect(tall).toBeLessThan(320);
    expect(await field.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await field.fill('first line');
    await field.press('Shift+Enter');
    await field.pressSequentially('second line');
    await field.press('Enter');
    await expect(field).toHaveValue('');
    await expect(feed(page, 'claude')).toContainText(/you said: first line\s*second line/);
    expect(Math.abs(((await field.boundingBox())?.height ?? 0) - low)).toBeLessThan(2);
});
test('the composer shows the status of the agent and its line, on a narrow screen as well', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(url);
    await say(page, 'codex', 'wait');
    const card = composer(page, 'codex');
    await expect(card.locator('[data-status]')).toHaveAttribute('data-status', 'working');
    await sayInLine(page, 'codex', 'queued from a phone');
    await expect(card.locator('[data-status]')).toContainText(/working\s*· 1 in line/);
    await expect(card).toContainText('Enter to send');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(feed(page, 'codex')).toContainText('you said: queued from a phone');
    await expect(card.locator('[data-status]')).toHaveAttribute('data-status', 'idle');
    await expect(card.locator('[data-status]')).not.toContainText('in line');
});
type Edges = { readonly left: number; readonly right: number };
async function edges(locator: Locator): Promise<Edges> {
    const box = await locator.boundingBox();
    if (box === null) {
        throw new Error('not on the page');
    }
    return { left: box.x, right: box.x + box.width };
}
/** Where the content of the feed runs, and how wide its scrollbar is: the composer sits under it, not beside it. */
function feedEdges(log: Locator): Promise<Edges & { readonly scrollbar: number }> {
    return log.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const left = box.left + element.clientLeft + parseFloat(style.paddingLeft);
        const right = box.left + element.clientLeft + element.clientWidth - parseFloat(style.paddingRight);
        return { left, right, scrollbar: element.offsetWidth - element.clientWidth - 2 * element.clientLeft };
    });
}
test('on a wide screen the composer and the line waiting in it span the feed, in both themes (#95)', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.goto(url);
    for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        await say(page, 'claude', 'wait');
        await expect(tab(page, 'claude').locator('[data-status]')).toHaveAttribute('data-status', 'working');
        await sayInLine(page, 'claude', `queued on a wide screen, ${colorScheme}`);
        const log = feed(page, 'claude');
        const content = await feedEdges(log);
        expect(content.right - content.left, 'the feed is wider than a column of messages').toBeGreaterThan(1200);
        const card = await edges(composer(page, 'claude').locator('.composer-card'));
        expect(Math.abs(card.left - content.left), `${colorScheme}: left of the composer`).toBeLessThanOrEqual(1);
        expect(Math.abs(card.right - content.right), `${colorScheme}: right of the composer`).toBeLessThanOrEqual(content.scrollbar + 1);
        const line = nextUp(page, 'claude');
        const block = await edges(line);
        expect(Math.abs(block.left - content.left), `${colorScheme}: left of the line`).toBeLessThanOrEqual(1);
        expect(Math.abs(block.right - content.right), `${colorScheme}: right of the line`).toBeLessThanOrEqual(1);
        const queued = await edges(line.locator('.message-queued'));
        const mine = await edges(log.locator('.message-user').filter({ hasText: 'wait' }).last());
        expect(Math.abs(queued.right - mine.right), `${colorScheme}: a queued message stands where the person's messages do`).toBeLessThanOrEqual(1);
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(line).toHaveCount(0);
    }
    await tab(page, 'All agents').click();
    const targets = await edges(page.locator('.targets'));
    const broadcast = await edges(page.locator('.broadcast .composer-card'));
    expect(Math.abs(broadcast.left - targets.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(broadcast.right - targets.right)).toBeLessThanOrEqual(1);
});
/** Sends a message the agent is too busy to take: the field clears once the dashboard says it waits in line. */
async function sayInLine(page: Page, name: string, text: string): Promise<void> {
    await say(page, name, text);
    await expect(page.getByRole('textbox', { name: `Message to ${name}` })).toHaveValue('');
}
/** The block of messages waiting in line at the end of the feed of `name`. */
const nextUp = (page: Page, name: string) => feed(page, name).getByRole('group', { name: 'Next up' });
test('a message to a busy agent waits in line in the feed, can be taken back, and joins the feed once taken', async ({ page }) => {
    await page.goto(url);
    await say(page, 'claude', 'wait');
    await expect(tab(page, 'claude').locator('[data-status]')).toHaveAttribute('data-status', 'working');
    await sayInLine(page, 'claude', 'second in line');
    await sayInLine(page, 'claude', 'third in line');
    const line = nextUp(page, 'claude');
    await expect(line).toContainText('Next up · 2 in line');
    await expect(line.locator('.message-queued .envelope-bar')).toHaveText([/In line · 1st/, /In line · 2nd/]);
    await expect(line.locator('.message-queued')).toHaveText([/second in line/, /third in line/]);
    await expect(tab(page, 'claude')).toContainText(/working\s*· 2 in line/);
    await line.getByRole('button', { name: 'Cancel queued message 2' }).click();
    await expect(line.locator('.message-queued')).toHaveText([/second in line/]);
    await expect(tab(page, 'claude')).toContainText('1 in line');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(feed(page, 'claude')).toContainText('you said: second in line');
    await expect(line).toHaveCount(0);
    await expect(feed(page, 'claude').locator('.message-user').filter({ hasText: 'second in line' })).toHaveCount(1);
    await expect(feed(page, 'claude')).not.toContainText('third in line');
    await expect(tab(page, 'claude')).not.toContainText('in line');
});
test('a broadcast to busy agents waits in line in the tab of each', async ({ page }) => {
    await page.goto(url);
    await say(page, 'claude', 'wait');
    await say(page, 'codex', 'wait');
    await expect(tab(page, 'codex').locator('[data-status]')).toHaveAttribute('data-status', 'working');
    await tab(page, 'All agents').click();
    await page.getByRole('checkbox', { name: 'relay' }).uncheck();
    await page.getByRole('textbox', { name: 'Message to all agents' }).fill('when you can');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    for (const name of ['claude', 'codex']) {
        await expect(tab(page, name)).toContainText('1 in line');
        await tab(page, name).click();
        await expect(nextUp(page, name)).toContainText('when you can');
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(feed(page, name)).toContainText('you said: when you can');
        await expect(nextUp(page, name)).toHaveCount(0);
    }
});
test('a stop drops what waits in line: the message says it was not delivered, and goes again with one click', async ({ page }) => {
    await page.goto(url);
    await say(page, 'codex', 'wait');
    await expect(tab(page, 'codex').locator('[data-status]')).toHaveAttribute('data-status', 'working');
    await sayInLine(page, 'codex', 'do not lose me');
    await expect(nextUp(page, 'codex')).toContainText('do not lose me');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    const dropped = feed(page, 'codex').locator('.message-dropped').filter({ hasText: 'do not lose me' });
    await expect(dropped).toHaveCount(1);
    await expect(nextUp(page, 'codex')).toHaveCount(0);
    const row = feed(page, 'codex').locator('[data-undelivered]').last();
    await expect(row.locator('.dropped-line')).toContainText('Not delivered: ');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(tab(page, 'codex').locator('[data-status]')).toHaveAttribute('data-status', 'idle');
    await row.getByRole('button', { name: 'Send again' }).click();
    await expect(feed(page, 'codex')).toContainText('you said: do not lose me');
    await expect(row.locator('.dropped-line')).toContainText('sent again');
    await expect(row.getByRole('button', { name: 'Send again' })).toHaveCount(0);
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
    await tab(page, 'relay').click();
    await page.getByRole('button', { name: 'Restart' }).click();
    await expect(feed(page, 'relay')).toContainText('new conversation');
});
test('a page opened later gets the history', async ({ page }) => {
    await page.goto(`${url}#/claude`);
    await expect(feed(page, 'claude')).toContainText('you said: hello claude');
    await expect(feed(page, 'claude')).toContainText('you said: ping');
});
test('the language is picked in the settings: the page speaks it at once, and after a reload', async ({ page }) => {
    await page.goto(`${url}#/_settings`);
    await page.getByRole('combobox', { name: 'Language of the dashboard' }).selectOption('ru');
    await expect(page.getByRole('heading', { name: 'Настройки флота' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Все агенты/ })).toBeVisible();
    await expect(tab(page, 'claude').locator('[data-status]')).toHaveText(/^(запускается|свободен|работает|ждёт вас|ошибка|остановлен)/);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ru');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Настройки флота' })).toBeVisible();
    await tab(page, 'claude').click();
    await expect(page.getByRole('log', { name: 'Вывод claude' })).toContainText('you said: hello claude');
    await expect(page.getByRole('textbox', { name: 'Сообщение для claude' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Вид' }).getByRole('button', { name: 'Память' })).toBeVisible();
    await page.getByRole('tab', { name: /^Настройки/ }).click();
    await page.getByRole('combobox', { name: 'Язык дашборда' }).selectOption('en');
    await expect(page.getByRole('heading', { name: 'Fleet settings' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
});
test.describe('in a browser set to Russian', () => {
    test.use({ locale: 'ru-RU' });
    test('the dashboard opens in Russian until another language is picked', async ({ page }) => {
        await page.goto(`${url}#/all`);
        await expect(page.getByRole('tab', { name: /^Все агенты/ })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Сообщение всем агентам' })).toBeVisible();
        await expect(page.getByRole('combobox', { name: 'Язык дашборда' })).toHaveCount(0);
    });
});
const settingsRow = (page: Page, id: string) => page.getByRole('list', { name: 'Agents' }).locator(`[data-agent="${id}"]`);
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
test('Telegram set up in the settings: a wait is one message, the answer deletes it, the token never comes back', async ({ page }) => {
    const bot = telegram as FakeTelegram;
    bot.calls.length = 0;
    await page.goto(`${url}#/_settings`);
    const section = page.getByRole('form', { name: 'Notifications' });
    await section.getByLabel('Bot token').fill(bot.token);
    await section.getByLabel('Chat id').fill('4242');
    await section.getByRole('checkbox', { name: 'Telegram' }).check();
    await section.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    await expect(section.getByLabel('Bot token')).toHaveValue('');
    await expect(section.getByLabel('Bot token')).toHaveAttribute('placeholder', 'saved');
    const shown = await page.evaluate(() => fetch('/api/notifications').then((response) => response.text()));
    expect(shown).not.toContain(bot.token);
    await section.getByRole('button', { name: 'Send a test' }).click();
    await expect(section.getByRole('status').filter({ hasText: 'telegram: sent' })).toBeVisible();
    await say(page, 'codex', 'permission');
    await expect.poll(() => bot.of('sendMessage').map((call) => String(call.body['text']).split('\n')[0])).toContain('codex is waiting for you');
    const waiting = bot.of('sendMessage').filter((call) => String(call.body['text']).startsWith('codex is waiting'));
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.body['chat_id']).toBe('4242');
    expect(String(waiting[0]?.body['text'])).toContain(`${url}#/codex`);
    await feed(page, 'codex').getByRole('button', { name: 'Allow' }).click();
    await expect.poll(() => bot.of('deleteMessage').length).toBe(1);
    await page.goto(`${url}#/_settings`);
    await section.getByRole('checkbox', { name: 'Telegram' }).uncheck();
    await section.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
});
test('makes an agent an administrator in the settings; its action waits for a person and shows in both tabs', async ({ page }) => {
    await page.goto(`${url}#/_settings`);
    await settingsRow(page, 'relay').getByRole('button', { name: 'Edit' }).click();
    await expect(field(page, 'Administrator')).not.toBeChecked();
    await field(page, 'Administrator').check();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(settingsRow(page, 'relay')).toContainText('relay · remote · A2A · admin');
    const manifest = () => JSON.parse(readFileSync(join(workspace, 'fleet', 'remote', 'relay', 'agent.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest()['admin']).toBe(true);
    const confirm = page.getByRole('group', { name: 'Administrators' }).getByRole('checkbox');
    await expect(confirm).not.toBeChecked();
    await confirm.check();
    await expect(confirm).toBeChecked();
    const settings = () => JSON.parse(readFileSync(join(workspace, '.flotti', 'settings.json'), 'utf8')) as Record<string, unknown>;
    await expect.poll(() => settings()['confirmAdminActions']).toBe(true);
    await say(page, 'relay', 'clear codex');
    await expect(page.locator('.admin-badge')).toHaveText('admin');
    const request = feed(page, 'relay').locator('.admin-request');
    await expect(request).toContainText('relay asks to clear the context of codex');
    await request.getByRole('button', { name: 'Allow' }).click();
    await expect(feed(page, 'relay')).toContainText('relay cleared the context of codex');
    await tab(page, 'codex').click();
    await expect(feed(page, 'codex').getByRole('separator', { name: /Context cleared: relay cleared the context of codex/ })).toBeVisible();
    await page.goto(`${url}#/_settings`);
    await confirm.uncheck();
    await expect(confirm).not.toBeChecked();
    await settingsRow(page, 'relay').getByRole('button', { name: 'Edit' }).click();
    await field(page, 'Administrator').uncheck();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(settingsRow(page, 'relay')).not.toContainText('admin');
    expect('admin' in manifest()).toBe(false);
});
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
test('the header of an agent says whether it has memory, as flotti delivered it', async ({ page }) => {
    await page.goto(url);
    // The memory bank of codex stops being usable: something that is not a folder takes its place, and a restart hands memory over again.
    await tab(page, 'codex').click();
    await expect(page.locator('.agent-header [data-memory]')).toHaveAttribute('data-memory', 'on');
    const bank = join(workspace, 'fleet', 'local', 'codex', 'memory');
    rmSync(bank, { recursive: true, force: true });
    writeFileSync(bank, 'not a folder');
    await page.locator('.agent-header').getByRole('button', { name: 'Restart' }).click();
    const cases = [
        ['claude', 'on', 'memory on · policy v1'],
        ['codex', 'unavailable', 'memory unavailable'],
        ['relay', 'unsupported', 'memory unsupported']
    ] as const;
    for (const [name, state, text] of cases) {
        await tab(page, name).click();
        const badge = page.locator('.agent-header [data-memory]');
        await expect(badge).toHaveAttribute('data-memory', state);
        await expect(badge).toHaveText(text);
    }
    await tab(page, 'codex').click();
    await expect(page.locator('.agent-header [data-memory]')).toHaveAttribute('title', /is not a folder/);
    await viewButton(page, 'Memory').click();
    await expect(page.locator('.memory-state')).toContainText('is not a folder');
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
