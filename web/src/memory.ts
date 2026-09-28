/**
 * The memory bank as the Memory view of an agent shows it (#73): the notes
 * laid out in their folders, and when each was changed, in words.
 */
import type { MemoryNoteSummary } from '../../src/dashboard-protocol.js';
import type { Messages } from './i18n/en.js';
/** A folder of the bank: its notes, then the folders in it, both by name. */
type MemoryFolder = {
    readonly name: string;
    /** Path in the bank, `''` for the bank itself. */
    readonly path: string;
    readonly notes: MemoryNoteSummary[];
    readonly folders: MemoryFolder[];
};
function folderIn(parent: MemoryFolder, name: string): MemoryFolder {
    const found = parent.folders.find((folder) => folder.name === name);
    if (found !== undefined) {
        return found;
    }
    const created: MemoryFolder = { name, path: parent.path === '' ? name : `${parent.path}/${name}`, notes: [], folders: [] };
    parent.folders.push(created);
    return created;
}
function sortFolder(folder: MemoryFolder): MemoryFolder {
    folder.notes.sort((left, right) => left.title.localeCompare(right.title));
    folder.folders.sort((left, right) => left.name.localeCompare(right.name)).forEach(sortFolder);
    return folder;
}
/** The notes laid out in the folders their paths name. */
function memoryTree(notes: readonly MemoryNoteSummary[]): MemoryFolder {
    const root: MemoryFolder = { name: '', path: '', notes: [], folders: [] };
    for (const note of notes) {
        const folders = note.path.split('/').slice(0, -1);
        folders.reduce(folderIn, root).notes.push(note);
    }
    return sortFolder(root);
}
/** How long ago a note was changed, in words: `just now`, `5 min ago`, `3 h ago`, `yesterday`, `4 days ago`, or the date. */
function changedAgo(at: number, now: number, t: Messages): string {
    const minutes = Math.floor((now - at) / 60_000);
    if (minutes < 1) {
        return t.memory.justNow;
    }
    if (minutes < 60) {
        return t.memory.minutesAgo(minutes);
    }
    return hoursAgo(at, Math.floor(minutes / 60), t);
}
/** A change an hour or more ago, in words. */
function hoursAgo(at: number, hours: number, t: Messages): string {
    const days = Math.floor(hours / 24);
    if (hours < 24) {
        return t.memory.hoursAgo(hours);
    }
    if (days < 7) {
        return days === 1 ? t.memory.yesterday : t.memory.daysAgo(days);
    }
    return t.memory.date(at);
}
/** The note to show first: the home note of the bank when it has one, else the first at its top. */
function firstNote(notes: readonly MemoryNoteSummary[]): MemoryNoteSummary | undefined {
    const home = notes.find((note) => /^(index|readme|home)\.md$/i.test(note.path));
    return home ?? notes.find((note) => !note.path.includes('/')) ?? notes[0];
}
export { changedAgo, firstNote, memoryTree };
export type { MemoryFolder };
