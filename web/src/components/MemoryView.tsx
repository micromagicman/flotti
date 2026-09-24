import { useCallback, useEffect, useRef, useState } from 'react';
import type { MemoryBank, MemoryNoteSummary } from '../../../src/dashboard-protocol.js';
import { api } from '../api.js';
import { changedAgo, firstNote, memoryTree } from '../memory.js';
import type { MemoryFolder } from '../memory.js';
import { NoteView } from './MemoryNote.js';
type OpenBank = Extract<MemoryBank, { available: true }>;
type ListProps = {
    readonly selected: string | undefined;
    readonly onOpen: (path: string) => void;
    readonly now: number;
};
/** The bank as the server gives it, read again on demand; `stamp` counts the reads. */
function useMemoryBank(agentId: string) {
    const [bank, setBank] = useState<MemoryBank>();
    const [error, setError] = useState<string>();
    const [stamp, setStamp] = useState(0);
    const load = useCallback(() => {
        setError(undefined);
        api.memory(agentId).then((read) => {
            setBank(read);
            setStamp((count) => count + 1);
        }, (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    }, [agentId]);
    useEffect(load, [load]);
    return { bank, error, load, stamp };
}
/** Asks for the notes with the words after a pause in typing; returns the way to call it off. */
function searchLater(agentId: string, words: string, onFound: (paths: ReadonlySet<string>) => void): () => void {
    let live = true;
    const timer = setTimeout(() => {
        api.memory(agentId, words).then((bank) => {
            if (live && bank.available) {
                onFound(new Set(bank.notes.map((note) => note.path)));
            }
        }, () => undefined);
    }, 200);
    return () => {
        live = false;
        clearTimeout(timer);
    };
}
/** The paths of the notes that have the words; undefined with no words, and before the first answer. */
function useSearch(agentId: string, query: string, stamp: number): ReadonlySet<string> | undefined {
    const [found, setFound] = useState<{ readonly query: string; readonly paths: ReadonlySet<string> }>();
    const words = query.trim();
    useEffect(() => (words === '' ? undefined : searchLater(agentId, words, (paths) => setFound({ query: words, paths }))), [agentId, words, stamp]);
    return words === '' ? undefined : found?.paths;
}
function NoteItem({ note, selected, onOpen, now }: ListProps & { readonly note: MemoryNoteSummary }) {
    return (
        <button type="button" className="note-item" aria-current={selected === note.path ? 'true' : undefined} onClick={() => onOpen(note.path)}>
            <span className="note-item-title">{note.title}</span>
            <span className="note-item-meta">{changedAgo(note.modifiedAt, now)}</span>
        </button>
    );
}
function FolderItems({ folder, ...list }: ListProps & { readonly folder: MemoryFolder }) {
    return (
        <>
            {folder.notes.map((note) => <NoteItem key={note.path} note={note} {...list} />)}
            {folder.folders.map((inner) => (
                <details key={inner.path} open>
                    <summary>{inner.name}</summary>
                    <div className="tree"><FolderItems folder={inner} {...list} /></div>
                </details>
            ))}
        </>
    );
}
function NoteTree({ notes, searching, ...list }: Omit<ListProps, 'now'> & { readonly notes: readonly MemoryNoteSummary[]; readonly searching: boolean }) {
    if (notes.length === 0) {
        return <p className="note-empty">{searching ? 'No note has these words.' : 'No notes yet: the agent has not written any.'}</p>;
    }
    return <nav className="tree" aria-label="Notes"><FolderItems folder={memoryTree(notes)} now={Date.now()} {...list} /></nav>;
}
/** Which note is open, and on a narrow screen whether the note or the list is in sight. */
function useSelection(bank: OpenBank) {
    const [selected, setSelected] = useState(() => firstNote(bank.notes)?.path);
    const [open, setOpen] = useState(false);
    const pane = useRef<HTMLDivElement>(null);
    useEffect(() => {
        pane.current?.scrollTo?.({ top: 0 });
    }, [selected]);
    const onOpen = (path: string): void => {
        setSelected(path);
        setOpen(true);
    };
    return { selected, open, pane, onOpen, onBack: () => setOpen(false) };
}
function MemoryList({ bank, query, setQuery, found, onRefresh, selected, onOpen }: {
    readonly bank: OpenBank;
    readonly query: string;
    readonly setQuery: (query: string) => void;
    readonly found: ReadonlySet<string> | undefined;
    readonly onRefresh: () => void;
} & Omit<ListProps, 'now'>) {
    const shown = found === undefined ? bank.notes : bank.notes.filter((note) => found.has(note.path));
    return (
        <div className="memory-list">
            <div className="memory-tools">
                <input type="search" className="input" aria-label="Search notes" placeholder="Search notes…" value={query} onChange={(event) => setQuery(event.target.value)} />
                <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh} title="Read the notes again">Refresh</button>
            </div>
            <NoteTree notes={shown} searching={query.trim() !== ''} selected={selected} onOpen={onOpen} />
            {bank.truncated === true ? <p className="note">Only the first {bank.notes.length} notes are listed.</p> : null}
        </div>
    );
}
function MemoryBrowser({ agentId, bank, stamp, onRefresh }: { readonly agentId: string; readonly bank: OpenBank; readonly stamp: number; readonly onRefresh: () => void }) {
    const [query, setQuery] = useState('');
    const found = useSearch(agentId, query, stamp);
    const { selected, open, pane, onOpen, onBack } = useSelection(bank);
    return (
        <div className="memory" data-open={open}>
            <MemoryList bank={bank} query={query} setQuery={setQuery} found={found} onRefresh={onRefresh} selected={selected} onOpen={onOpen} />
            <div className="memory-note" ref={pane}>
                {selected === undefined
                    ? <p className="note-empty">Pick a note.</p>
                    : <NoteView agentId={agentId} notes={bank.notes} path={selected} stamp={stamp} onOpen={onOpen} onBack={onBack} />}
            </div>
        </div>
    );
}
/**
 * The memory bank of the agent (#73), read-only: its folders and notes on the
 * left, a note on the right; on a narrow screen the list, then the note.
 */
function MemoryView({ agentId }: { readonly agentId: string }) {
    const { bank, error, load, stamp } = useMemoryBank(agentId);
    if (error !== undefined) {
        return (
            <div className="memory-state">
                <p className="error" role="alert">{error}</p>
                <button type="button" className="btn btn-sm" onClick={load}>Try again</button>
            </div>
        );
    }
    if (bank === undefined) {
        return <div className="memory-state"><p className="note">Reading the memory bank…</p></div>;
    }
    return bank.available
        ? <MemoryBrowser agentId={agentId} bank={bank} stamp={stamp} onRefresh={load} />
        : <div className="memory-state"><p>{bank.reason}</p></div>;
}
export { MemoryView };
