import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { MemoryBank } from '../src/dashboard-protocol.js';
import { MAX_NOTE_BYTES, MemoryError, readMemoryBank, readMemoryNote } from '../src/memory-bank.js';
import { linkedFrom, linksOf, noteResolver } from '../src/memory-links.js';
import type { LocalAgent, RemoteAgent } from '../src/types.js';
const workspace = mkdtempSync(join(tmpdir(), 'flotti-memory-'));
after(() => rmSync(workspace, { recursive: true, force: true }));
/** Symbolic links need a privilege on Windows that CI does not have. */
const links = process.platform === 'win32' ? { skip: 'symbolic links need a privilege on Windows' } : {};
function write(path: string, text: string): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
}
function localAgent(memoryDirectory: string, ssh?: string): LocalAgent {
    return {
        kind: 'local',
        id: 'claude',
        name: 'claude',
        directory: join(memoryDirectory, '..'),
        manifestPath: join(memoryDirectory, '..', 'agent.json'),
        command: 'claude',
        arguments: [],
        workdir: join(memoryDirectory, '..'),
        env: {},
        restart: 'on-failure',
        heartbeatTimeoutSec: 60,
        skillsDirectory: join(memoryDirectory, '..', 'skills'),
        memoryDirectory,
        ...(ssh === undefined ? {} : { ssh })
    };
}
/** A memory bank with notes in folders, and things around them the dashboard must not read. */
function bank(): { memory: string; outside: string } {
    const root = mkdtempSync(join(workspace, 'agent-'));
    const memory = join(root, 'memory');
    write(join(memory, 'index.md'), '# Home\nStart at [[Release process]] and [[missing note]].\n');
    write(join(memory, 'process', 'release.md'), '---\ntags: [release]\n---\n# Release process\nWalk the [[deploy-checklist|checklist]].\n');
    write(join(memory, 'process', 'deploy-checklist.md'), '- [x] build\n- [ ] rollback\n');
    write(join(memory, 'notes.txt'), 'not markdown');
    write(join(memory, '.obsidian', 'workspace.md'), '# hidden');
    const outside = join(root, 'secret.md');
    write(outside, '# Secret\nkept out');
    return { memory, outside };
}
function paths(answer: MemoryBank): string[] {
    return answer.available ? answer.notes.map((note) => note.path) : [];
}
describe('the memory bank of an agent', () => {
    it('lists the .md notes in their folders, with titles and links, and leaves hidden and other files out', async () => {
        const { memory } = bank();
        const answer = await readMemoryBank(localAgent(memory));
        ok(answer.available);
        deepStrictEqual(answer.notes.map(({ path, title, links: named }) => [path, title, named]), [
            ['index.md', 'Home', ['Release process', 'missing note']],
            ['process/deploy-checklist.md', 'deploy-checklist', []],
            ['process/release.md', 'Release process', ['deploy-checklist']]
        ]);
        strictEqual(answer.directory, memory);
        strictEqual(answer.truncated, undefined);
    });
    it('keeps the notes with the words searched for, in the title, the path or the text', async () => {
        const { memory } = bank();
        deepStrictEqual(paths(await readMemoryBank(localAgent(memory), 'ROLLBACK')), ['process/deploy-checklist.md']);
        deepStrictEqual(paths(await readMemoryBank(localAgent(memory), 'process/')), ['process/deploy-checklist.md', 'process/release.md']);
        deepStrictEqual(paths(await readMemoryBank(localAgent(memory), 'nowhere')), []);
    });
    it('has no notes before the agent writes any', async () => {
        const answer = await readMemoryBank(localAgent(join(workspace, 'no-such', 'memory')));
        deepStrictEqual(answer.available && answer.notes, []);
    });
    it('is not on this machine for a remote agent, nor for a local one started over SSH', async () => {
        const remote: RemoteAgent = { kind: 'remote', id: 'relay', name: 'relay', directory: '/fleet/remote/relay', manifestPath: '/fleet/remote/relay/agent.json', protocol: 'a2a', url: 'http://127.0.0.1:1/', auth: { type: 'none' } };
        const far = await readMemoryBank(remote);
        ok(!far.available && far.reason.includes('remote agent'));
        const overSsh = await readMemoryBank(localAgent(bank().memory, 'dev@build.example.org'));
        ok(!overSsh.available && overSsh.reason.includes('dev@build.example.org'));
        await rejects(readMemoryNote(localAgent(bank().memory, 'dev@build.example.org'), 'index.md'), (error: MemoryError) => error.status === 404);
    });
});
describe('a note of the memory bank', () => {
    it('comes with its text and the absolute path of its file', async () => {
        const { memory } = bank();
        const note = await readMemoryNote(localAgent(memory), 'process/release.md');
        deepStrictEqual([note.path, note.file], ['process/release.md', join(memory, 'process', 'release.md')]);
        ok(note.text.startsWith('---\ntags'));
    });
    it('refuses any path that is not one of a note inside the bank', async () => {
        const { memory } = bank();
        for (const path of ['../secret.md', 'process/../../secret.md', '/etc/passwd.md', '.obsidian/workspace.md', 'notes.txt', 'process', '', 'C:/x.md', 'a//b.md']) {
            await rejects(readMemoryNote(localAgent(memory), path), (error: MemoryError) => error.status === 400, path);
        }
        await rejects(readMemoryNote(localAgent(memory), 'none.md'), (error: MemoryError) => error.status === 404);
    });
    it('does not follow a symbolic link out of the bank, and follows one that stays in it', links, async () => {
        const { memory, outside } = bank();
        symlinkSync(outside, join(memory, 'leak.md'));
        symlinkSync(join(memory, '..'), join(memory, 'up'));
        symlinkSync(join(memory, 'index.md'), join(memory, 'home.md'));
        deepStrictEqual(paths(await readMemoryBank(localAgent(memory))), ['home.md', 'index.md', 'process/deploy-checklist.md', 'process/release.md']);
        await rejects(readMemoryNote(localAgent(memory), 'leak.md'), (error: MemoryError) => error.status === 404);
        await rejects(readMemoryNote(localAgent(memory), 'up/secret.md'), (error: MemoryError) => error.status === 404);
        strictEqual((await readMemoryNote(localAgent(memory), 'home.md')).text.split('\n')[0], '# Home');
    });
    it('lists a note too large to show, and does not read it', async () => {
        const { memory } = bank();
        write(join(memory, 'huge.md'), `# Huge\n${'x'.repeat(MAX_NOTE_BYTES)}`);
        const answer = await readMemoryBank(localAgent(memory));
        const huge = answer.available ? answer.notes.find((note) => note.path === 'huge.md') : undefined;
        deepStrictEqual([huge?.title, huge?.tooLarge, huge?.links], ['huge', true, []]);
        await rejects(readMemoryNote(localAgent(memory), 'huge.md'), (error: MemoryError) => error.status === 413);
    });
});
describe('[[links]] of the notes', () => {
    it('are read with their labels, headings and embeds taken off, each once', () => {
        deepStrictEqual(linksOf('[[A]] [[B|label]] [[C#Part]] ![[D]] [[A]] [[ ]] [[x/E.md]]'), ['A', 'B', 'C', 'D', 'x/E.md']);
    });
    it('lead to a note by its path, its file name or its title, in any case', () => {
        const notes = [
            { path: 'process/release.md', title: 'Release process', links: ['home'] },
            { path: 'index.md', title: 'Home', links: ['Release Process', 'process/release', 'nothing'] }
        ];
        const resolve = noteResolver(notes);
        deepStrictEqual(['release', 'RELEASE PROCESS', 'process/release.md', 'home', 'nothing'].map((name) => resolve(name)?.path), [
            'process/release.md', 'process/release.md', 'process/release.md', 'index.md', undefined
        ]);
        deepStrictEqual(linkedFrom(notes, 'process/release.md').map((note) => note.path), ['index.md']);
        deepStrictEqual(linkedFrom(notes, 'index.md').map((note) => note.path), ['process/release.md']);
    });
});
