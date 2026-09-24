/**
 * The `[[links]]` of a memory bank, the way Obsidian writes them:
 * `[[name]]`, `[[name|label]]`, `[[name#heading]]` and `![[name]]`. No Node in
 * here: the server lists the links of every note, and the page — built by Vite
 * for the browser — resolves them with the very same rules.
 */
/** A `[[link]]`: its target, and the label after `|` when there is one. */
const WIKILINK = /!?\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;
/** The note a link leads to: what comes before `#` or `^` in it, trimmed. */
function linkTarget(raw: string): string {
    return (raw.split(/[#^]/)[0] ?? '').trim();
}
/** The targets of the links of a note, each once, in the order they come. */
function linksOf(text: string): string[] {
    const targets = [...text.matchAll(WIKILINK)].map((match) => linkTarget(match[1] ?? ''));
    return [...new Set(targets.filter((target) => target !== ''))];
}
/** A name to look a note up by: lower case, `\` as `/`, without `.md` at the end. */
function noteKey(name: string): string {
    return name.trim().replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase();
}
/** The file name of a note path, without folders and `.md`. */
function baseName(path: string): string {
    return (path.split('/').pop() ?? path).replace(/\.md$/i, '');
}
type LinkableNote = { readonly path: string; readonly title: string };
/**
 * Finds the note a link names: by its path in the bank, by its file name, or
 * by its title — the first note in the list wins when two share a name.
 */
function noteResolver<T extends LinkableNote>(notes: readonly T[]): (target: string) => T | undefined {
    const byKey = new Map<string, T>();
    const add = (key: string, note: T): void => {
        if (!byKey.has(key)) {
            byKey.set(key, note);
        }
    };
    notes.forEach((note) => add(noteKey(note.path), note));
    notes.forEach((note) => add(noteKey(baseName(note.path)), note));
    notes.forEach((note) => add(noteKey(note.title), note));
    return (target) => byKey.get(noteKey(target));
}
/** The notes with a link to the note at `path`, in the order of the list. */
function linkedFrom<T extends LinkableNote & { readonly links: readonly string[] }>(notes: readonly T[], path: string): T[] {
    const resolve = noteResolver(notes);
    return notes.filter((note) => note.path !== path && note.links.some((target) => resolve(target)?.path === path));
}
export { WIKILINK, baseName, linkTarget, linkedFrom, linksOf, noteResolver };
export type { LinkableNote };
