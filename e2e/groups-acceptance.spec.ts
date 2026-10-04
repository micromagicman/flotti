/**
 * The acceptance of the groups of #144 end to end (docs/groups.md, sub-issue 6),
 * as 0.7.0 has it (#171): a fleet of four pretend local agents in two groups.
 * An agent of one group does not list a member of the other and is refused a
 * task for it with the words for an agent that does not exist; `to` between
 * agents is gone on every tool; inside its own group an agent writes to the
 * group, mentioning a member, the members answer, and the person reads the
 * conversation in the tab of the group — there is no conversation of a pair.
 * A fleet of its own: the pieces are covered in groups.spec.ts (#152) and
 * dashboard.spec.ts (#153), this is the whole in one run.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'build', 'index.js');
const FAKE_ACP = join(ROOT, 'build-test', 'test', 'fake-acp-agent.js');
const workspace = mkdtempSync(join(tmpdir(), 'flotti-e2e-acceptance-'));
const fleet = join(workspace, 'fleet');
let flotti: ChildProcess | undefined;
let url = '';
/** A pretend local agent with the fleet tools; it answers «you said: …» to whatever it gets, and `mcp {…}` calls a tool. */
function localAgent(id: string): void {
    const directory = join(fleet, 'local', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'agent.json'), JSON.stringify({
        name: id, command: process.execPath, arguments: [FAKE_ACP], env: { FAKE_ACP: JSON.stringify({ record: join(directory, 'record.jsonl'), mcpHttp: true }) }
    }));
}
/** A group of the fleet: `groups/<id>/group.json`. */
function groupOf(id: string, name: string, members: readonly string[]): void {
    const directory = join(fleet, 'groups', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'group.json'), JSON.stringify({ name, members }));
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
    for (const id of ['builder', 'reviewer', 'writer', 'editor']) {
        localAgent(id);
    }
    // Two groups: builder and reviewer ship the release, writer and editor write the docs.
    groupOf('release', 'Release', ['builder', 'reviewer']);
    groupOf('docs', 'Docs', ['writer', 'editor']);
    url = await startFlotti();
});
test.afterAll(async () => {
    const exited = new Promise((resolve) => flotti?.once('exit', resolve));
    flotti?.kill('SIGTERM');
    await exited;
    rmSync(workspace, { recursive: true, force: true });
});
const section = (page: Page, name: string) => page.getByRole('tablist', { name: 'Sections of the sidebar' }).getByRole('tab', { name: new RegExp(`^${name}`) });
const tab = (page: Page, name: string) => page.locator('.sidebar').getByRole('tab', { name: new RegExp(`^${name}`) });
const feed = (page: Page, name: string) => page.getByRole('log', { name: `Output of ${name}` });
const lane = (page: Page, name: string) => page.getByRole('log', { name: `Group ${name}` });
/** Opens the tab of an agent, from any section. */
async function openAgent(page: Page, name: string): Promise<void> {
    if (await section(page, 'Agents').getAttribute('aria-selected') !== 'true') {
        await section(page, 'Agents').click();
    }
    await tab(page, name).click();
}
/** Has the agent call a tool of the fleet, and gives what the tool said — as the pretend agent reports it in its tab. */
async function callTool(page: Page, name: string, tool: string, args: Record<string, string> = {}): Promise<Locator> {
    await openAgent(page, name);
    const field = page.getByRole('textbox', { name: `Message to ${name}` });
    await field.fill(`mcp ${JSON.stringify({ name: tool, arguments: args })}`);
    await field.press('Enter');
    const said = feed(page, name).locator('.message-agent').filter({ hasText: 'mcp: ' }).last();
    await expect(said).toContainText('mcp: ');
    return said;
}
const REFUSED = (id: string) => `there is no agent "${id}" among the agents you can write to; list_agents names them`;
const TO_IS_GONE = 'mcp: error: "to" is gone: a message to another agent goes through a group — name the group in "group" and the agent with @<id> in the text';
test('an agent lists the members of its own group only; "to" is gone, and a task for a member of the other group is refused with the words for an agent that does not exist (#144, #171)', async ({ page }) => {
    await page.goto(url);
    const peers = await callTool(page, 'writer', 'list_agents');
    await expect(peers).toContainText(/"id": "editor"[\s\S]*?"groups": \[\s*"docs"\s*\]/);
    await expect(peers).toContainText(/"id": "writer"[\s\S]*?"you": true/);
    await expect(peers).not.toContainText('builder');
    await expect(peers).not.toContainText('reviewer');
    // A message by "to" is refused before anything is asked, to an agent of the other group and to a peer alike.
    await expect(await callTool(page, 'writer', 'send_message', { to: 'builder', text: 'a word across the fence' })).toContainText(TO_IS_GONE);
    await expect(await callTool(page, 'writer', 'send_message', { to: 'editor', text: 'a word between us' })).toContainText(TO_IS_GONE);
    await openAgent(page, 'builder');
    await expect(feed(page, 'builder')).not.toContainText('a word across the fence');
    await openAgent(page, 'editor');
    await expect(feed(page, 'editor')).not.toContainText('a word between us');
    // A task names its group and its doer; the same words for a member of the other group and for an agent that is not in the fleet.
    await expect(await callTool(page, 'writer', 'delegate', { group: 'docs', to: 'reviewer', text: 'review the draft' })).toContainText(REFUSED('reviewer'));
    await expect(await callTool(page, 'writer', 'delegate', { group: 'docs', to: 'ghost', text: 'anybody there?' })).toContainText(REFUSED('ghost'));
    // The person reads the real reason in the tab of the giver — once, for the agent that exists.
    await expect(feed(page, 'writer').locator('.log').filter({ hasText: 'is not in a group with' })).toHaveText(['flotti: "reviewer" is not in a group with "writer"']);
});
test('two agents in a group talk in the tab of the group only: an agent writes to the group mentioning a member, the member answers, and there is no conversation of the pair (#144, #171, #172)', async ({ page }) => {
    await page.goto(url);
    await expect(page.getByRole('tablist', { name: 'Sections of the sidebar' }).getByRole('tab')).toHaveText(['Agents', 'Groups']);
    await expect(await callTool(page, 'writer', 'send_message', { group: 'docs', text: '@editor The draft is ready' }))
        .toContainText('mcp: Posted to group "docs": "editor" has it. What the members answer comes to you as messages from them.');
    // The answer of the member comes back to the group, and is read there only (#172).
    await section(page, 'Groups').click();
    await expect(tab(page, 'Group Docs')).toContainText('2 members · 2 messages');
    await expect(tab(page, 'Group Release')).toContainText('2 members · 0 messages');
    await tab(page, 'Group Docs').click();
    await expect(page.getByRole('heading', { name: 'Docs' })).toBeVisible();
    await expect(page.locator('.group-header .member')).toHaveText(['writer', 'editor']);
    const row = lane(page, 'Docs').locator('.message-row').filter({ hasText: 'writer → Docs' });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.message-peer').locator('.mention')).toHaveText(['editor']);
    await expect(row.locator('.message-peer')).toContainText('The draft is ready');
    await expect(row.locator('.took summary')).toHaveText('editor got it');
    await row.locator('.took summary').click();
    const list = row.getByRole('list', { name: 'How the members took it' });
    await expect(list.locator('.delivery-name')).toHaveText(['editor']);
    await expect(list.locator('.delivery-result')).toHaveText(['delivered']);
    const answer = lane(page, 'Docs').locator('.message-peer').filter({ hasText: 'you said: [from writer in group docs, to you]' });
    await expect(answer).toHaveCount(1);
    await expect(answer.locator('.envelope-bar')).toContainText('editor → Docs · answer');
    await expect(answer.locator('.quote')).toContainText('The draft is ready');
    // The message by "to" went nowhere, and nothing else is in the lane.
    await expect(lane(page, 'Docs')).not.toContainText('a word between us');
    await expect(lane(page, 'Docs').locator('.message-row')).toHaveCount(2);
    // The other group heard nothing.
    await tab(page, 'Group Release').click();
    await expect(lane(page, 'Release')).not.toContainText('The draft is ready');
    // Neither the tab of the sender nor the tab of the member shows the exchange: only what the person said to each (#172).
    await openAgent(page, 'writer');
    await expect(feed(page, 'writer').getByText(/\[from (writer|editor) in group docs\]/)).toHaveCount(0);
    await openAgent(page, 'editor');
    await expect(feed(page, 'editor')).not.toContainText('The draft is ready');
    // No pair tab to read it in: a saved address of 0.6.x opens the first agent.
    await page.goto(`${url}#/${encodeURIComponent('_pair:editor:writer')}`);
    await expect(page.getByRole('tab', { name: /^Conversation of/ })).toHaveCount(0);
    await expect(page.getByRole('log', { name: /^Conversation of/ })).toHaveCount(0);
});
test('a task is given inside the group: posted there mentioning the doer, the card follows it, and the outcome is posted from the doer (#171)', async ({ page }) => {
    await page.goto(url);
    await expect(await callTool(page, 'builder', 'delegate', { group: 'release', to: 'reviewer', text: 'Review the release notes' }))
        .toContainText(/mcp: Task \S+ is with "reviewer" in group "release"/);
    await section(page, 'Groups').click();
    await tab(page, 'Group Release').click();
    const card = lane(page, 'Release').getByRole('group', { name: 'Task from builder to reviewer: completed' });
    await expect(card).toContainText('Review the release notes');
    const outcome = lane(page, 'Release').locator('.message-peer').filter({ hasText: 'you said: [from builder in group release]' });
    await expect(outcome.locator('.envelope-bar')).toContainText('reviewer → Release · task completed');
    await expect(outcome.locator('.quote')).toContainText('@reviewer Review the release notes');
});
