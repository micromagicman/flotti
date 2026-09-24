import type { ReactNode } from 'react';
import type { Block, Inline, ListItem } from '../markdown.js';
import { useT } from '../i18n/I18n.js';
/** What a `[[link]]` leads to: the path of a note of the bank, or nothing when there is no such note. */
type WikiLinks = {
    readonly resolve: (target: string) => string | undefined;
    readonly onOpen: (path: string) => void;
};
function WikiLink({ piece, links }: { readonly piece: Extract<Inline, { kind: 'wikilink' }>; readonly links: WikiLinks }) {
    const path = links.resolve(piece.target);
    const t = useT();
    if (path === undefined) {
        return <span className="wikilink wikilink-broken" tabIndex={0} title={t.memory.missing(piece.target)}>{piece.text}</span>;
    }
    return <button type="button" className="wikilink" onClick={() => links.onOpen(path)}>{piece.text}</button>;
}
function InlineNode({ piece, links }: { readonly piece: Inline; readonly links: WikiLinks }): ReactNode {
    switch (piece.kind) {
        case 'text':
            return piece.text;
        case 'break':
            return <br />;
        case 'code':
            return <code>{piece.text}</code>;
        case 'link':
            return <a className="message-link" href={piece.href} target="_blank" rel="noopener noreferrer">{piece.text}</a>;
        case 'wikilink':
            return <WikiLink piece={piece} links={links} />;
        case 'strong':
            return <strong><Inlines pieces={piece.children} links={links} /></strong>;
        case 'em':
            return <em><Inlines pieces={piece.children} links={links} /></em>;
    }
}
function Inlines({ pieces, links }: { readonly pieces: readonly Inline[]; readonly links: WikiLinks }) {
    return <>{pieces.map((piece, index) => <InlineNode key={index} piece={piece} links={links} />)}</>;
}
function Item({ item, links }: { readonly item: ListItem; readonly links: WikiLinks }) {
    const content = <Inlines pieces={item.content} links={links} />;
    const depth = item.depth === 0 ? '' : ` md-depth-${item.depth}`;
    const t = useT();
    if (item.checked === undefined) {
        return <li className={depth.trim() || undefined}>{content}</li>;
    }
    return (
        <li className={`task${depth}`}>
            <input type="checkbox" disabled checked={item.checked} aria-label={item.checked ? t.memory.done : t.memory.notDone} />
            <span>{content}</span>
        </li>
    );
}
/** Headings of a note sit under the title of its card, an `<h2>`: `#` is an `<h3>`, and so on down to `<h6>`. */
function Heading({ level, children }: { readonly level: number; readonly children: ReactNode }) {
    const Tag = (['h3', 'h4', 'h5', 'h6'] as const)[Math.min(level, 4) - 1] ?? 'h6';
    return <Tag>{children}</Tag>;
}
function BlockNode({ block, links }: { readonly block: Block; readonly links: WikiLinks }): ReactNode {
    switch (block.kind) {
        case 'heading':
            return <Heading level={block.level}><Inlines pieces={block.content} links={links} /></Heading>;
        case 'paragraph':
            return <p><Inlines pieces={block.content} links={links} /></p>;
        case 'quote':
            return <blockquote><Inlines pieces={block.content} links={links} /></blockquote>;
        case 'code':
            return <pre className={block.properties === true ? 'md-properties' : undefined}><code>{block.text}</code></pre>;
        case 'rule':
            return <hr />;
        case 'list': {
            const items = block.items.map((item, index) => <Item key={index} item={item} links={links} />);
            return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
        }
    }
}
/** A note as rendered markdown: every piece a React node, none of it HTML from the note. */
function Markdown({ blocks, links }: { readonly blocks: readonly Block[]; readonly links: WikiLinks }) {
    return <div className="md">{blocks.map((block, index) => <BlockNode key={index} block={block} links={links} />)}</div>;
}
export { Markdown };
export type { WikiLinks };
