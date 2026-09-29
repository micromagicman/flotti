/**
 * The acceptance of the groups of #144 end to end (docs/groups.md, sub-issue 6):
 * a fleet of four pretend local agents in two groups. An agent of one group
 * does not list a member of the other and is refused writing to it with the
 * words for an agent that does not exist; inside its own group it writes to a
 * member and to the group, the members answer, and the person reads the
 * conversation in the tab of the group. A fleet of its own: the pieces are
 * covered in groups.spec.ts (#152) and dashboard.spec.ts (#153), this is the
 * whole in one run.
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
const REFUSED = (id: string) => `mcp: error: there is no agent "${id}" among the agents you can write to; list_agents names them`;
test('an agent lists the members of its own group only, and a member of the other group is refused with the words for an agent that does not exist (#144)', async ({ page }) => {
    await page.goto(url);
    const peers = await callTool(page, 'writer', 'list_agents');
    await expect(peers).toContainText(/"id": "editor"[\s\S]*?"groups": \[\s*"docs"\s*\]/);
    await expect(peers).toContainText(/"id": "writer"[\s\S]*?"you": true/);
    await expect(peers).not.toContainText('builder');
    await expect(peers).not.toContainText('reviewer');
    // The same words for a member of the other group and for an agent that is not in the fleet: nothing says builder exists.
    await expect(await callTool(page, 'writer', 'send_message', { to: 'builder', text: 'a word across the fence' })).toContainText(REFUSED('builder'));
    await expect(await callTool(page, 'writer', 'send_message', { to: 'ghost', text: 'anybody there?' })).toContainText(REFUSED('ghost'));
    // The person reads the real reason in the tab of the sender — once, for the agent that exists.
    await expect(feed(page, 'writer').locator('.log').filter({ hasText: 'is not in a group with' })).toHaveText(['flotti: "builder" is not in a group with "writer"']);
    await openAgent(page, 'builder');
    await expect(feed(page, 'builder')).not.toContainText('a word across the fence');
    // A task is a message too: the same door, the same words.
    await expect(await callTool(page, 'writer', 'delegate', { to: 'reviewer', text: 'review the draft' })).toContainText(REFUSED('reviewer').replace('mcp: error: ', ''));
});
test('inside its group an agent writes to a member and to the group, the members answer, and the person reads the conversation in the tab of the group (#144)', async ({ page }) => {
    await page.goto(url);
    await expect(await callTool(page, 'writer', 'send_message', { to: 'editor', text: 'a word between us' })).toContainText('mcp: "editor" has it. Its answer comes to you as a message from "editor".');
    await expect(feed(page, 'writer').locator('.message-peer').filter({ hasText: 'you said: [from writer] a word between us' })).toHaveCount(1);
    await expect(await callTool(page, 'writer', 'send_message', { group: 'docs', text: 'The draft is ready' }))
        .toContainText('mcp: Posted to group "docs": "editor" has it. What the members answer comes to you as messages from them.');
    // The answer of the member comes back to the group, and so to the sender's tab, marked with the group.
    await expect(feed(page, 'writer').locator('.message-peer').filter({ hasText: 'you said: [from writer in group docs] The draft is ready' })).toHaveCount(1);
    await section(page, 'Groups').click();
    await expect(tab(page, 'Group Docs')).toContainText('2 members · 2 messages');
    await expect(tab(page, 'Group Release')).toContainText('2 members · 0 messages');
    await tab(page, 'Group Docs').click();
    await expect(page.getByRole('heading', { name: 'Docs' })).toBeVisible();
    await expect(page.locator('.group-header .member')).toHaveText(['writer', 'editor']);
    const row = lane(page, 'Docs').locator('.message-row').filter({ hasText: 'writer → Docs' });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.message-peer')).toContainText('The draft is ready');
    await expect(row.locator('.took summary')).toHaveText('editor got it');
    await row.locator('.took summary').click();
    const list = row.getByRole('list', { name: 'How the members took it' });
    await expect(list.locator('.delivery-name')).toHaveText(['editor']);
    await expect(list.locator('.delivery-result')).toHaveText(['delivered']);
    const answer = lane(page, 'Docs').locator('.message-peer').filter({ hasText: 'you said: [from writer in group docs] The draft is ready' });
    await expect(answer).toHaveCount(1);
    await expect(answer.locator('.envelope-bar')).toContainText('editor → Docs · answer');
    await expect(answer.locator('.quote')).toContainText('The draft is ready');
    // The direct message between the two stayed in their conversation, not in the group.
    await expect(lane(page, 'Docs')).not.toContainText('a word between us');
    // The other group heard nothing.
    await tab(page, 'Group Release').click();
    await expect(lane(page, 'Release')).not.toContainText('The draft is ready');
});
