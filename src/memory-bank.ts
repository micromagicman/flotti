/**
 * The memory bank of a local agent, read for the dashboard (#73): the
 * markdown notes in its `memory/`, read-only. flotti never writes there — the
 * notes belong to the agent — and reads nothing outside it: only `.md` files,
 * no hidden entries, no symbolic link that leads out of the bank, and no note
 * larger than {@link MAX_NOTE_BYTES}.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { MemoryBank, MemoryNote, MemoryNoteSummary } from './dashboard-protocol.js';
import { baseName, linksOf } from './memory-links.js';
import type { Agent } from './types.js';
/** A note is what an agent writes down; a megabyte is far more than that. */
const MAX_NOTE_BYTES = 1024 * 1024;
/** How many notes the list holds at most; the rest is cut off, and the list says so. */
const MAX_NOTES = 2000;
/** How deep the folders are followed. */
const MAX_DEPTH = 16;
/** A note that cannot be given, with the status code that says why. */
class MemoryError extends Error {
    constructor(readonly status: 400 | 404 | 413, message: string) {
        super(message);
    }
}
/** A note found in the bank: what the list shows, and its text when it is small enough to read. */
type Found = { readonly summary: MemoryNoteSummary; readonly text: string | undefined };
type Walk = { readonly found: Found[]; truncated: boolean };
/** Where the memory bank of the agent is on this machine, or why it is not here. */
function bankDirectory(agent: Agent): { readonly directory: string } | { readonly reason: string } {
    if (agent.kind === 'remote') {
        return { reason: 'A remote agent keeps its memory on its own machine: the dashboard cannot read it.' };
    }
    if (agent.ssh !== undefined) {
        return { reason: `The agent runs on ${agent.ssh} and works with the files there: memory/ on this machine is not its memory bank.` };
    }
    return { directory: agent.memoryDirectory };
}
/** The real path of the bank, links resolved; undefined when there is no such directory. */
async function bankRoot(directory: string): Promise<string | undefined> {
    try {
        const real = await realpath(directory);
        return (await stat(real)).isDirectory() ? real : undefined;
    } catch {
        return undefined;
    }
}
function inside(root: string, path: string): boolean {
    return path.startsWith(root.endsWith(sep) ? root : root + sep);
}
/** The markdown without the YAML front matter Obsidian keeps properties in. */
function withoutFrontMatter(text: string): string {
    return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}
/** The first `# heading` of the note, or its file name. */
function titleOf(text: string, path: string): string {
    const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(withoutFrontMatter(text));
    return heading?.[1]?.trim() || baseName(path);
}
function summaryOf(path: string, info: Stats, text: string | undefined): MemoryNoteSummary {
    return {
        path,
        title: text === undefined ? baseName(path) : titleOf(text, path),
        modifiedAt: Math.round(info.mtimeMs),
        size: info.size,
        links: text === undefined ? [] : linksOf(text),
        ...(text === undefined ? { tooLarge: true as const } : {})
    };
}
/** The note in this file, when it is a file inside the bank — followed through any link. */
async function noteAt(root: string, file: string): Promise<Found | undefined> {
    const real = await realpath(file).catch(() => undefined);
    if (real === undefined || !inside(root, real)) {
        return undefined;
    }
    const info = await stat(real);
    if (!info.isFile()) {
        return undefined;
    }
    const text = info.size > MAX_NOTE_BYTES ? undefined : await readFile(real, 'utf8');
    return { summary: summaryOf(relative(root, file).split(sep).join('/'), info, text), text };
}
/**
 * Adds the notes of a folder and of the folders in it. Hidden entries
 * (`.obsidian`, `.git`) are left out, and so are linked folders: a link may
 * lead out of the bank, or round in a circle.
 */
async function walkFolder(root: string, folder: string, depth: number, walk: Walk): Promise<void> {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries.filter(({ name }) => !name.startsWith('.'))) {
        if (walk.found.length >= MAX_NOTES) {
            walk.truncated = true;
            return;
        }
        const path = join(folder, entry.name);
        if (entry.isDirectory() && depth < MAX_DEPTH) {
            await walkFolder(root, path, depth + 1, walk);
        } else if (/\.md$/i.test(entry.name) && (entry.isFile() || entry.isSymbolicLink())) {
            const note = await noteAt(root, path).catch(() => undefined);
            if (note !== undefined) {
                walk.found.push(note);
            }
        }
    }
}
function matches({ summary, text }: Found, query: string): boolean {
    const words = query.trim().toLowerCase();
    return words === '' || [summary.title, summary.path, text ?? ''].some((part) => part.toLowerCase().includes(words));
}
/**
 * The notes of the memory bank of the agent; with `query`, only those whose
 * title, path or text has these words. A bank not created yet has no notes.
 */
async function readMemoryBank(agent: Agent, query = ''): Promise<MemoryBank> {
    const place = bankDirectory(agent);
    if ('reason' in place) {
        return { available: false, reason: place.reason };
    }
    const root = await bankRoot(place.directory);
    const walk: Walk = { found: [], truncated: false };
    if (root !== undefined) {
        await walkFolder(root, root, 0, walk);
    }
    const notes = walk.found.filter((found) => matches(found, query)).map(({ summary }) => summary);
    return { available: true, directory: place.directory, notes, ...(walk.truncated ? { truncated: true as const } : {}) };
}
/**
 * The path of a note as the page names it, checked: folders and a `.md` file,
 * joined with `/`, none of them hidden, `.` or `..`.
 *
 * @throws MemoryError (400) for any other.
 */
function notePath(path: string): string[] {
    const parts = path.replace(/\\/g, '/').split('/');
    const refused = parts.some((part) => part === '' || part.startsWith('.') || /[\0:]/.test(part));
    if (refused || !/\.md$/i.test(path)) {
        throw new MemoryError(400, 'A note is a path to a .md file inside the memory bank.');
    }
    return parts;
}
/**
 * One note of the memory bank of the agent, with its text.
 *
 * @throws MemoryError — 400 for a path that is not one of a note, 404 when
 *   there is no such note (or no memory bank here), 413 for a note too large to show.
 */
async function readMemoryNote(agent: Agent, path: string): Promise<MemoryNote> {
    const place = bankDirectory(agent);
    if ('reason' in place) {
        throw new MemoryError(404, place.reason);
    }
    const parts = notePath(path);
    const root = await bankRoot(place.directory);
    const found = root === undefined ? undefined : await noteAt(root, join(root, ...parts)).catch(() => undefined);
    if (found === undefined) {
        throw new MemoryError(404, `There is no note ${parts.join('/')} in the memory bank.`);
    }
    if (found.text === undefined) {
        throw new MemoryError(413, `The note is larger than ${MAX_NOTE_BYTES / 1024 / 1024} MB: the dashboard does not show it.`);
    }
    const { modifiedAt, size } = found.summary;
    return { path: parts.join('/'), file: join(place.directory, ...parts), modifiedAt, size, text: found.text };
}
export { MAX_NOTE_BYTES, MAX_NOTES, MemoryError, readMemoryBank, readMemoryNote };
