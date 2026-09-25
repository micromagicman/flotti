import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { AgentSummary } from '../src/dashboard-protocol.js';
import { FleetMcpServer } from '../src/fleet-mcp.js';
import type { FleetDirectory } from '../src/fleet-mcp.js';
import { readMemoryBank } from '../src/memory-bank.js';
import type { LocalAgent } from '../src/types.js';
const workspace = mkdtempSync(join(tmpdir(), 'flotti-memory-'));
const servers: FleetMcpServer[] = [];
after(async () => {
    await Promise.all(servers.map((server) => server.close()));
    rmSync(workspace, { recursive: true, force: true });
});
let made = 0;
/** The tools of a fleet of two: `keeper` has a memory bank, `visitor` (on another host, say) has none. */
async function tools(): Promise<{ server: FleetMcpServer; bank: string; keeper: string; visitor: string }> {
    const bank = join(workspace, `bank-${++made}`, 'memory');
    const server = await FleetMcpServer.start();
    servers.push(server);
    const fleet: FleetDirectory = {
        agents: (): AgentSummary[] => ['keeper', 'visitor'].map((id) => ({ id, name: id, kind: 'local', status: 'idle' })),
        send: () => Promise.reject(new Error('no messages here')),
        delegate: () => Promise.reject(new Error('no tasks here')),
        cancelDelegation: () => {
            throw new Error('no tasks here');
        },
        memoryBank: (agentId) => agentId === 'keeper' ? bank : undefined
    };
    server.serve(fleet);
    return { server, bank, keeper: server.access('keeper').token, visitor: server.access('visitor').token };
}
async function rpc(server: FleetMcpServer, token: string, method: string, params: object = {}): Promise<Record<string, unknown>> {
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    const body = await response.json() as { result: Record<string, unknown> };
    return body.result;
}
async function call(server: FleetMcpServer, token: string, name: string, args: object): Promise<{ text: string; isError: boolean }> {
    const result = await rpc(server, token, 'tools/call', { name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content[0]?.text ?? '', isError: result.isError === true };
}
/** A tool call that must work: its answer, parsed. */
async function done(server: FleetMcpServer, token: string, name: string, args: object): Promise<Record<string, unknown>> {
    const { text, isError } = await call(server, token, name, args);
    strictEqual(isError, false, `${name} failed: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
}
/** The files of the bank, hidden ones too: a write leaves no temporary file behind. */
function files(bank: string): string[] {
    return existsSync(bank) ? readdirSync(bank, { recursive: true }).map(String).sort() : [];
}
describe('memory tools (#101): the agent\'s own memory bank', () => {
    it('are listed to an agent with a memory bank only', async () => {
        const { server, keeper, visitor } = await tools();
        const names = async (token: string) => ((await rpc(server, token, 'tools/list'))['tools'] as { name: string }[]).map((tool) => tool.name);
        const memory = ['memory_search', 'memory_read', 'memory_write', 'memory_delete'];
        deepStrictEqual((await names(keeper)).filter((name) => name.startsWith('memory_')), memory);
        deepStrictEqual((await names(visitor)).filter((name) => name.startsWith('memory_')), []);
        const refused = await call(server, visitor, 'memory_write', { title: 'x', description: 'x', body: 'x' });
        strictEqual(refused.isError, true);
        match(refused.text, /not supported/);
    });
    it('write puts the note on disk before the receipt, as a markdown file with front matter', async () => {
        const { server, bank, keeper } = await tools();
        const receipt = await done(server, keeper, 'memory_write', {
            title: 'Release day', description: 'When flotti is released', body: 'Releases go out on Thursdays.'
        });
        deepStrictEqual(Object.keys(receipt).sort(), ['at', 'id', 'revision', 'scope']);
        strictEqual(receipt['id'], 'release-day');
        strictEqual(receipt['scope'], 'agent');
        const text = readFileSync(join(bank, 'release-day.md'), 'utf8');
        match(text, /^---\ntitle: "Release day"\ndescription: "When flotti is released"\nupdated: \S+\n---\n\nReleases go out on Thursdays\.\n$/);
        deepStrictEqual(files(bank), ['release-day.md'], 'no temporary file is left');
        const note = await done(server, keeper, 'memory_read', { id: 'release-day' });
        strictEqual(note['revision'], receipt['revision']);
        strictEqual(note['body'], 'Releases go out on Thursdays.\n');
        const shown = await readMemoryBank({ kind: 'local', memoryDirectory: bank } as LocalAgent);
        ok(shown.available && shown.notes[0]?.title === 'Release day', 'the dashboard reads the title of the front matter');
    });
    it('a write with a stale revision is a conflict, and the note stays as it was', async () => {
        const { server, bank, keeper } = await tools();
        const first = await done(server, keeper, 'memory_write', { title: 'Editor', description: 'Editor of choice', body: 'vim' });
        const second = await done(server, keeper, 'memory_write', {
            id: 'editor', title: 'Editor', description: 'Editor of choice', body: 'emacs', expected_revision: first['revision']
        });
        const stale = await call(server, keeper, 'memory_write', {
            id: 'editor', title: 'Editor', description: 'Editor of choice', body: 'nano', expected_revision: first['revision']
        });
        strictEqual(stale.isError, true);
        match(stale.text, /^Not done \(conflict\)/);
        const blind = await call(server, keeper, 'memory_write', { id: 'editor', title: 'Editor', description: '', body: 'ed' });
        strictEqual(blind.isError, true, 'a note that exists is not written over without its revision');
        match(blind.text, /conflict/);
        const note = await done(server, keeper, 'memory_read', { id: 'editor' });
        strictEqual(note['revision'], second['revision']);
        match(readFileSync(join(bank, 'editor.md'), 'utf8'), /emacs/);
    });
});
describe('memory tools (#101): revisions and deleting', () => {
    it('an edit of the file outside the tools changes the revision: a write from before it is a conflict', async () => {
        const { server, bank, keeper } = await tools();
        const written = await done(server, keeper, 'memory_write', { title: 'Port', description: 'Dev port', body: '8080' });
        writeFileSync(join(bank, 'port.md'), readFileSync(join(bank, 'port.md'), 'utf8').replace('8080', '9090'));
        const late = await call(server, keeper, 'memory_write', {
            id: 'port', title: 'Port', description: 'Dev port', body: '7070', expected_revision: written['revision']
        });
        strictEqual(late.isError, true);
        const hits = await done(server, keeper, 'memory_search', { query: '9090' }) as unknown as { id: string; snippet: string }[];
        deepStrictEqual(hits.map((hit) => hit.id), ['port']);
        match(hits[0]?.snippet ?? '', /9090/);
    });
    it('delete removes the note; a stale revision or a missing note deletes nothing', async () => {
        const { server, bank, keeper } = await tools();
        const written = await done(server, keeper, 'memory_write', { title: 'Temp', description: 'x', body: 'one' });
        await done(server, keeper, 'memory_write', {
            id: 'temp', title: 'Temp', description: 'x', body: 'two', expected_revision: written['revision']
        });
        const stale = await call(server, keeper, 'memory_delete', { id: 'temp', expected_revision: written['revision'] });
        strictEqual(stale.isError, true);
        ok(existsSync(join(bank, 'temp.md')));
        deepStrictEqual(await done(server, keeper, 'memory_delete', { id: 'temp' }), { id: 'temp', deleted: true });
        strictEqual(existsSync(join(bank, 'temp.md')), false);
        const again = await call(server, keeper, 'memory_delete', { id: 'temp' });
        strictEqual(again.isError, true);
        match(again.text, /not-found/);
        deepStrictEqual(await done(server, keeper, 'memory_search', { query: 'Temp' }), []);
    });
});
describe('memory tools (#101): what they refuse', () => {
    it('refuses paths that lead out of the bank', async () => {
        const { server, bank, keeper } = await tools();
        const outside = join(workspace, `outside-${made}`);
        mkdirSync(outside, { recursive: true });
        mkdirSync(bank, { recursive: true });
        symlinkSync(outside, join(bank, 'escape'), 'junction');
        for (const id of ['../stolen', 'a/../../stolen', '.hidden', 'notes/.git/x', '/etc/passwd', 'a\\..\\b', 'escape/stolen']) {
            const result = await call(server, keeper, 'memory_write', { id, title: 'x', description: 'x', body: 'x' });
            strictEqual(result.isError, true, `${id} is refused`);
            const read = await call(server, keeper, 'memory_read', { id });
            strictEqual(read.isError, true, `${id} is not read`);
        }
        deepStrictEqual(readdirSync(outside), [], 'nothing was written outside');
        strictEqual(existsSync(join(workspace, 'stolen.md')), false);
        const nested = await done(server, keeper, 'memory_write', { id: 'projects/flotti', title: 'flotti', description: 'x', body: 'x' });
        strictEqual(nested['id'], 'projects/flotti');
        ok(existsSync(join(bank, 'projects', 'flotti.md')));
    });
    it('any scope but the agent\'s own is an explicit error, and nothing is written', async () => {
        const { server, bank, keeper } = await tools();
        for (const name of ['memory_write', 'memory_search', 'memory_read', 'memory_delete']) {
            const result = await call(server, keeper, name, { id: 'x', query: 'x', title: 'x', description: 'x', body: 'x', scope: 'fleet' });
            strictEqual(result.isError, true);
            match(result.text, /scope "fleet" is not supported yet/);
        }
        deepStrictEqual(files(bank), []);
        await done(server, keeper, 'memory_write', { title: 'Mine', description: 'x', body: 'x', scope: 'agent' });
    });
    it('a bank that cannot be written answers that nothing was saved', async () => {
        const { server, bank, keeper } = await tools();
        mkdirSync(join(bank, '..'), { recursive: true });
        writeFileSync(bank, 'a file where the bank should be');
        const result = await call(server, keeper, 'memory_write', { title: 'Lost', description: 'x', body: 'x' });
        strictEqual(result.isError, true);
        match(result.text, /^Not done \(unavailable\)/);
        const shown = await readMemoryBank({ kind: 'local', memoryDirectory: bank } as LocalAgent);
        strictEqual(shown.available, false, 'the dashboard does not show an unavailable bank as an empty one');
    });
    it('a new note never takes the id of one that is there', async () => {
        const { server, keeper } = await tools();
        const first = await done(server, keeper, 'memory_write', { title: 'Same', description: 'x', body: 'one' });
        const second = await done(server, keeper, 'memory_write', { title: 'Same', description: 'x', body: 'two' });
        deepStrictEqual([first['id'], second['id']], ['same', 'same-2']);
    });
});
