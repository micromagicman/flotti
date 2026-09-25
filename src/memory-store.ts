/**
 * The memory of an agent as the memory tools see it (#101): the markdown notes
 * of its `memory/`, one fact per file, with a front matter of `title`,
 * `description` and `updated` — the same files the dashboard shows (#73).
 *
 * A note is named by its id: its path inside the bank without `.md`
 * (`deploy`, `projects/flotti`). Its revision is a hash of the file, so an edit
 * made outside the tools changes it too, and a write that names a revision
 * seen before the edit is a conflict, not an overwrite.
 *
 * A write is on disk before it is confirmed: the text goes to a hidden file
 * next to the note, is flushed, and takes the note's place in one rename.
 * Nothing is written or removed outside the bank — no `..`, no hidden entry,
 * no folder that is a link leading out of it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MAX_NOTE_BYTES, bankRoot, collectNotes, frontMatter, inside, withoutFrontMatter } from './memory-bank.js';
import type { Found } from './memory-bank.js';
/** The one scope of the MVP: the memory of the agent itself. The fleet's is stage 2. */
const AGENT_SCOPE = 'agent';
/** Longest id a note may have. */
const MAX_ID_LENGTH = 200;
/** Longest title and description, in characters: they go into every index. */
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
/** Notes a search returns at most. */
const MAX_SEARCH_RESULTS = 20;
/** Why a memory operation did not happen, in words for the agent. */
class MemoryStoreError extends Error {
    constructor(
        readonly kind: 'invalid' | 'not-found' | 'conflict' | 'unsupported' | 'unavailable',
        message: string
    ) {
        super(message);
    }
}
/** A note as the tools give it. */
type StoredNote = {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    /** When the note was last written: its `updated`, else the time of the file. */
    readonly updated: string;
    readonly revision: string;
    /** The markdown after the front matter. */
    readonly body: string;
};
type NoteSummary = Omit<StoredNote, 'body' | 'revision'>;
type SearchHit = NoteSummary & { readonly snippet: string };
/** What `memory_write` answers once the note is on disk. */
type WriteReceipt = { readonly id: string; readonly revision: string; readonly scope: 'agent'; readonly at: string };
type WriteRequest = {
    readonly id?: string;
    readonly title: string;
    readonly description: string;
    readonly body: string;
    readonly expectedRevision?: string;
};
/** What the index of the bank holds: the newest notes first, and whether some were left out. */
type MemoryIndex = {
    readonly at: string;
    readonly total: number;
    readonly notes: readonly NoteSummary[];
    readonly truncated: boolean;
};
/** One write or delete at a time in a bank: a revision checked stays the revision written over. */
const locks = new Map<string, Promise<unknown>>();
function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = locks.get(key) ?? Promise.resolve();
    const done = before.then(work, work);
    const settled = done.catch(() => undefined);
    locks.set(key, settled);
    void settled.then(() => {
        if (locks.get(key) === settled) {
            locks.delete(key);
        }
    });
    return done;
}
/**
 * Refuses any scope but the agent's own.
 *
 * @throws MemoryStoreError (unsupported) for any other.
 */
function checkScope(scope: unknown): void {
    if (scope === undefined || scope === AGENT_SCOPE) {
        return;
    }
    throw new MemoryStoreError('unsupported', `scope "${String(scope)}" is not supported yet: only "${AGENT_SCOPE}", `
        + 'the memory of the agent itself, is. Nothing was read or written.');
}
/**
 * The parts of the path of a note named by this id: folders and a file name,
 * none of them empty, hidden, `.` or `..`. A trailing `.md` is allowed.
 *
 * @throws MemoryStoreError (invalid) for any other.
 */
function idParts(id: string): string[] {
    const bare = id.trim().replace(/\.md$/i, '');
    const parts = bare.split('/');
    const refused = bare === '' || bare.length > MAX_ID_LENGTH || /[\\\0:]/.test(bare)
        || parts.some((part) => part === '' || part.startsWith('.') || part.trim() !== part);
    if (refused) {
        throw new MemoryStoreError('invalid', `"${id}" is not an id of a note: it is a path inside the memory bank `
            + '— folders and a name joined with "/", none of them empty or starting with "." — without ".md".');
    }
    return parts;
}
function revisionOf(content: string | Buffer): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
}
function oneLine(value: string, limit: number): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}
/** The note in `text`, found at `file` whose time is `modifiedMs`. */
function noteOf(id: string, text: string, modifiedMs: number): StoredNote {
    const fields = frontMatter(text);
    const body = withoutFrontMatter(text).replace(/^\r?\n/, '');
    const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body)?.[1]?.trim();
    const updated = Date.parse(fields['updated'] ?? '');
    return {
        id,
        title: oneLine(fields['title'] || heading || id.split('/').at(-1) || id, MAX_TITLE_LENGTH),
        description: oneLine(fields['description'] ?? '', MAX_DESCRIPTION_LENGTH),
        updated: new Date(Number.isNaN(updated) ? modifiedMs : updated).toISOString(),
        revision: revisionOf(text),
        body
    };
}
function summaryOf(note: StoredNote): NoteSummary {
    return { id: note.id, title: note.title, description: note.description, updated: note.updated };
}
/** The text of a note as the tools write it: the front matter, then the body. */
function noteText(title: string, description: string, updated: string, body: string): string {
    const text = body.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
    return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\nupdated: ${updated}\n---\n\n${text}\n`;
}
/** An id for a new note, made of its title, that no note has yet. */
async function freshId(root: string, title: string): Promise<string> {
    const slug = title.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)
        .replace(/-+$/, '') || 'note';
    for (let count = 1; ; count += 1) {
        const id = count === 1 ? slug : `${slug}-${count}`;
        if (await fileAt(join(root, `${id}.md`)) === undefined) {
            return id;
        }
    }
}
/** The file there, when it is one. */
async function fileAt(path: string): Promise<{ readonly modifiedMs: number; readonly size: number } | undefined> {
    const info = await stat(path).catch(() => undefined);
    return info?.isFile() === true ? { modifiedMs: info.mtimeMs, size: info.size } : undefined;
}
/**
 * The memory of one agent: its bank at `directory`. The bank need not exist
 * yet; the first write makes it.
 */
class MemoryStore {
    constructor(readonly directory: string) {}
    /** The note with this id, with its revision. */
    async read(id: string): Promise<StoredNote> {
        const parts = idParts(id);
        const root = await this.root(false);
        const file = root === undefined ? undefined : await this.noteFile(root, parts, false);
        const found = file === undefined ? undefined : await fileAt(file);
        if (root === undefined || file === undefined || found === undefined) {
            throw new MemoryStoreError('not-found', `There is no note "${parts.join('/')}" in the memory bank.`);
        }
        if (found.size > MAX_NOTE_BYTES) {
            throw new MemoryStoreError('invalid', `The note "${parts.join('/')}" is larger than ${MAX_NOTE_BYTES / 1024 / 1024} MB.`);
        }
        return noteOf(parts.join('/'), await readFile(file, 'utf8'), found.modifiedMs);
    }
    /**
     * Writes the note and confirms once it is on disk. A note that is there
     * already is written over only when `expectedRevision` is the revision it
     * has now: a note changed since it was read is a conflict.
     */
    async write(request: WriteRequest): Promise<WriteReceipt> {
        const title = oneLine(request.title, MAX_TITLE_LENGTH);
        if (title === '') {
            throw new MemoryStoreError('invalid', 'title is missing: a note needs one.');
        }
        const description = oneLine(request.description, MAX_DESCRIPTION_LENGTH);
        const parts = request.id === undefined ? undefined : idParts(request.id);
        return exclusive(this.directory, async () => {
            const root = await this.root(true) as string;
            const id = parts?.join('/') ?? await freshId(root, title);
            const file = await this.noteFile(root, id.split('/'), true) as string;
            await this.checkRevision(file, id, request.expectedRevision, true);
            return writeNote(file, id, title, description, request.body);
        });
    }
    /** Removes the note; with `expectedRevision`, only when the note is still at it. */
    async delete(id: string, expectedRevision?: string): Promise<{ readonly id: string; readonly deleted: true }> {
        const parts = idParts(id);
        return exclusive(this.directory, async () => {
            const root = await this.root(false);
            const file = root === undefined ? undefined : await this.noteFile(root, parts, false);
            if (file === undefined || await fileAt(file) === undefined) {
                throw new MemoryStoreError('not-found', `There is no note "${parts.join('/')}" in the memory bank: nothing was deleted.`);
            }
            await this.checkRevision(file, parts.join('/'), expectedRevision, false);
            await unlink(file);
            return { id: parts.join('/'), deleted: true as const };
        });
    }
    /**
     * The notes whose id, title, description or text hold the words of the
     * query — the more words, the higher — with a piece of text around the
     * first. An empty query finds the newest notes.
     */
    async search(query: string): Promise<SearchHit[]> {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const scored = (await this.notes()).map((note) => {
            const haystack = `${note.id}\n${note.title}\n${note.description}\n${note.body}`.toLowerCase();
            return { note, score: words.filter((word) => haystack.includes(word)).length };
        }).filter(({ score }) => words.length === 0 || score > 0);
        scored.sort((left, right) => right.score - left.score || right.note.updated.localeCompare(left.note.updated));
        return scored.slice(0, MAX_SEARCH_RESULTS).map(({ note }) => ({ ...summaryOf(note), snippet: snippet(note.body, words) }));
    }
    /**
     * The index of the bank: id, title and description of the newest notes,
     * no more than `maxNotes` of them and no more than `maxChars` of text.
     */
    async index(maxNotes: number, maxChars: number): Promise<MemoryIndex> {
        const at = new Date().toISOString();
        const notes = (await this.notes()).sort((left, right) => right.updated.localeCompare(left.updated));
        const shown: NoteSummary[] = [];
        let used = 0;
        for (const note of notes.slice(0, maxNotes)) {
            used += note.id.length + note.title.length + note.description.length + 8;
            if (used > maxChars) {
                break;
            }
            shown.push(summaryOf(note));
        }
        return { at, total: notes.length, notes: shown, truncated: shown.length < notes.length };
    }
    /** Every note of the bank that can be read; none when there is no bank yet. */
    private async notes(): Promise<StoredNote[]> {
        const root = await this.root(false);
        if (root === undefined) {
            return [];
        }
        const { found } = await collectNotes(root);
        return found.filter((note): note is Found & { text: string } => note.text !== undefined)
            .map(({ summary, text }) => noteOf(summary.path.replace(/\.md$/i, ''), text, summary.modifiedAt));
    }
    /**
     * The real path of the bank; with `create`, a bank not there yet is made.
     *
     * @throws MemoryStoreError (unavailable) when it cannot be made or is not a folder.
     */
    private async root(create: boolean): Promise<string | undefined> {
        if (create) {
            try {
                await mkdir(this.directory, { recursive: true });
            } catch (error) {
                throw new MemoryStoreError('unavailable', `The memory bank cannot be created: ${describe(error)}`);
            }
        }
        const root = await bankRoot(this.directory);
        if (root === undefined && create) {
            throw new MemoryStoreError('unavailable', `The memory bank ${this.directory} is not a folder.`);
        }
        return root;
    }
    /**
     * The file of the note inside the bank; its folders are made when `create`.
     * A folder that leads out of the bank is refused.
     */
    private async noteFile(root: string, parts: readonly string[], create: boolean): Promise<string | undefined> {
        const folder = join(root, ...parts.slice(0, -1));
        if (create) {
            await mkdir(folder, { recursive: true }).catch((error: unknown) => {
                throw new MemoryStoreError('unavailable', `The folder of the note cannot be created: ${describe(error)}`);
            });
        }
        const real = await realpath(folder).catch(() => undefined);
        if (real === undefined) {
            return undefined;
        }
        const file = join(real, `${parts.at(-1) ?? ''}.md`);
        const target = await realpath(file).catch(() => file);
        if ((real !== root && !inside(root, real)) || !inside(root, target)) {
            throw new MemoryStoreError('invalid', `"${parts.join('/')}" leads out of the memory bank.`);
        }
        return file;
    }
    /**
     * @param mustMatchExisting A note that is there must be named with its
     *   revision: a write never goes over a note blindly.
     * @throws MemoryStoreError (conflict) when the note is not at the revision named.
     */
    private async checkRevision(file: string, id: string, expected: string | undefined, mustMatchExisting: boolean): Promise<void> {
        const current = await readFile(file).then(revisionOf, () => undefined);
        if (current === undefined) {
            if (expected !== undefined) {
                throw new MemoryStoreError('conflict', `Conflict: note "${id}" is not there any more, so it is not at revision `
                    + `${expected}. Nothing was written; search again.`);
            }
            return;
        }
        if (expected === undefined && !mustMatchExisting) {
            return;
        }
        if (expected !== current) {
            throw new MemoryStoreError('conflict', expected === undefined
                ? `Conflict: note "${id}" exists already (revision ${current}). Nothing was written: read it, then write `
                    + 'with expected_revision to change it, or leave out id to add a new note.'
                : `Conflict: note "${id}" changed since revision ${expected}; it is at ${current} now. Nothing was written: `
                    + 'read it again and decide.');
        }
    }
}
/** Writes the note at `file` and gives the receipt: the note is on disk by then. */
async function writeNote(file: string, id: string, title: string, description: string, body: string): Promise<WriteReceipt> {
    const at = new Date().toISOString();
    const text = noteText(title, description, at, body);
    if (Buffer.byteLength(text) > MAX_NOTE_BYTES) {
        throw new MemoryStoreError('invalid', `The note is larger than ${MAX_NOTE_BYTES / 1024 / 1024} MB: keep one fact per note.`);
    }
    await writeAtomically(file, text);
    return { id, revision: revisionOf(text), scope: AGENT_SCOPE, at };
}
/** The text around the first word of the query found in the body, on one line. */
function snippet(body: string, words: readonly string[]): string {
    const flat = body.replace(/\s+/g, ' ').trim();
    const lower = flat.toLowerCase();
    const at = words.map((word) => lower.indexOf(word)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, at - 60);
    const piece = flat.slice(start, start + 200);
    return `${start > 0 ? '…' : ''}${piece}${start + 200 < flat.length ? '…' : ''}`;
}
/** Writes to a hidden file beside the target, flushes it, and renames it over the target. */
async function writeAtomically(file: string, text: string): Promise<void> {
    const temporary = join(dirname(file), `.${randomBytes(6).toString('hex')}.flotti-tmp`);
    try {
        const handle = await open(temporary, 'wx');
        try {
            await handle.writeFile(text, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporary, file);
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error instanceof MemoryStoreError ? error : new MemoryStoreError('unavailable', `The note was not saved: ${describe(error)}`);
    }
}
function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
export { AGENT_SCOPE, MemoryStore, MemoryStoreError, checkScope, idParts };
export type { MemoryIndex, NoteSummary, SearchHit, StoredNote, WriteReceipt, WriteRequest };
