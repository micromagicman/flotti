import { useEffect, useMemo, useState } from 'react';
import type { MemoryNote, MemoryNoteSummary } from '../../../src/dashboard-protocol.js';
import { baseName, linkedFrom, noteResolver } from '../../../src/memory-links.js';
import { api } from '../api.js';
import { parseMarkdown, plainText } from '../markdown.js';
import type { Block } from '../markdown.js';
import { changedAgo } from '../memory.js';
import { Markdown } from './Markdown.js';
import type { WikiLinks } from './Markdown.js';
type Loaded = { readonly path: string; readonly note?: MemoryNote; readonly error?: string };
type NoteViewProps = {
    readonly agentId: string;
    readonly notes: readonly MemoryNoteSummary[];
    readonly path: string;
    /** Changes each time the bank is read again: the note is read again too. */
    readonly stamp: number;
    readonly onOpen: (path: string) => void;
    /** Back to the list, on a narrow screen. */
    readonly onBack: () => void;
};
function messageOf(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
}
/** The note at `path` as the server gives it; undefined while it is read. */
function useNote(agentId: string, path: string, stamp: number): Loaded | undefined {
    const [loaded, setLoaded] = useState<Loaded>();
    useEffect(() => {
        let live = true;
        api.memoryNote(agentId, path).then(
            (note) => live && setLoaded({ path, note }),
            (reason: unknown) => live && setLoaded({ path, error: messageOf(reason) })
        );
        return () => {
            live = false;
        };
    }, [agentId, path, stamp]);
    return loaded?.path === path ? loaded : undefined;
}
/** The blocks of the note, without a first `# heading` — after its properties, if any — that only repeats its title. */
function bodyOf(text: string, title: string): Block[] {
    const blocks = parseMarkdown(text);
    const at = blocks[0]?.kind === 'code' && blocks[0].properties === true ? 1 : 0;
    const first = blocks[at];
    const repeats = first?.kind === 'heading' && first.level === 1 && plainText(first.content).trim() === title;
    return repeats ? blocks.filter((_block, index) => index !== at) : blocks;
}
/** Copies the absolute path of the note, and says so for a moment. */
function CopyPath({ file }: { readonly file: string }) {
    const [copied, setCopied] = useState<boolean>();
    const copy = (): void => {
        navigator.clipboard.writeText(file).then(() => setCopied(true), () => setCopied(false));
        setTimeout(() => setCopied(undefined), 1500);
    };
    const label = copied === undefined ? 'Copy path' : copied ? 'Copied' : 'Could not copy';
    return <button type="button" className="btn btn-ghost btn-xs" onClick={copy} title={file}>{label}</button>;
}
function NoteHead({ path, summary, note }: { readonly path: string; readonly summary: MemoryNoteSummary | undefined; readonly note: MemoryNote | undefined }) {
    const modifiedAt = note?.modifiedAt ?? summary?.modifiedAt;
    return (
        <div className="note-head">
            <div className="note-path">
                <span>memory/{path}</span>
                {modifiedAt === undefined ? null : <span>edited {changedAgo(modifiedAt, Date.now())}</span>}
            </div>
            {note === undefined ? null : <div className="note-tools"><CopyPath file={note.file} /></div>}
        </div>
    );
}
function NoteBody({ loaded, title, links }: { readonly loaded: Loaded | undefined; readonly title: string; readonly links: WikiLinks }) {
    if (loaded === undefined) {
        return <p className="note-empty">Reading the note…</p>;
    }
    if (loaded.note === undefined) {
        return <p className="error" role="alert">{loaded.error}</p>;
    }
    return <Markdown blocks={bodyOf(loaded.note.text, title)} links={links} />;
}
function Backlinks({ notes, path, onOpen }: Pick<NoteViewProps, 'notes' | 'path' | 'onOpen'>) {
    const from = useMemo(() => linkedFrom(notes, path), [notes, path]);
    return (
        <div className="backlinks">
            Linked from
            {from.length === 0
                ? <span>nothing yet</span>
                : from.map((note) => <button key={note.path} type="button" className="btn btn-xs" onClick={() => onOpen(note.path)}>{note.title}</button>)}
        </div>
    );
}
/** One note of the memory bank on a card: where it is, its markdown rendered, and what links to it. */
function NoteView({ agentId, notes, path, stamp, onOpen, onBack }: NoteViewProps) {
    const loaded = useNote(agentId, path, stamp);
    const resolve = useMemo(() => noteResolver(notes), [notes]);
    const summary = notes.find((note) => note.path === path);
    const title = summary?.title ?? baseName(path);
    const links: WikiLinks = { resolve: (target) => resolve(target)?.path, onOpen };
    return (
        <article className="note-card" aria-label={title}>
            <button type="button" className="btn btn-ghost btn-sm back-btn" onClick={onBack}>← All notes</button>
            <NoteHead path={path} summary={summary} note={loaded?.note} />
            <h2>{title}</h2>
            <NoteBody loaded={loaded} title={title} links={links} />
            <Backlinks notes={notes} path={path} onOpen={onOpen} />
        </article>
    );
}
export { NoteView };
