/**
 * The markdown of a note of the memory bank (#73), the part agents write:
 * headings, paragraphs, lists and tasks, quotes, code, rules, `**strong**`,
 * `*emphasis*`, `code`, links and `[[wikilinks]]`. The text is cut into blocks
 * and pieces, and the page renders each as a node — never as HTML — so raw
 * HTML in a note is shown as text and nothing in it runs.
 */
import { WIKILINK, linkTarget } from '../../src/memory-links.js';
import { linkify } from './links.js';
type Inline =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'break' }
    | { readonly kind: 'code'; readonly text: string }
    | { readonly kind: 'link'; readonly text: string; readonly href: string }
    | { readonly kind: 'wikilink'; readonly target: string; readonly text: string }
    | { readonly kind: 'strong' | 'em'; readonly children: readonly Inline[] };
type ListItem = {
    readonly depth: number;
    /** `true` or `false` for a task `- [x]`, absent for a plain item. */
    readonly checked?: boolean;
    readonly content: readonly Inline[];
};
type Block =
    | { readonly kind: 'heading'; readonly level: number; readonly content: readonly Inline[] }
    | { readonly kind: 'paragraph'; readonly content: readonly Inline[] }
    | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly ListItem[] }
    | { readonly kind: 'quote'; readonly content: readonly Inline[] }
    | { readonly kind: 'code'; readonly text: string; readonly properties?: true }
    | { readonly kind: 'rule' };
/** What an inline piece of markup is; the groups say which one matched. */
const INLINE = new RegExp([
    '`([^`\\n]+)`',
    WIKILINK.source,
    '\\*\\*(?=\\S)(.+?)\\*\\*',
    '__(?=\\S)(.+?)__',
    '(?<![\\w*])\\*(?=[^\\s*])(.+?)\\*(?![\\w*])',
    '(?<![\\w_])_(?=[^\\s_])(.+?)_(?![\\w_])'
].join('|'), 'g');
function textPieces(text: string): Inline[] {
    return linkify(text).flatMap((piece): Inline[] => {
        const lines = piece.text.split('\n');
        return piece.kind === 'link'
            ? [{ kind: 'link', text: piece.text, href: piece.href }]
            : lines.flatMap((line, index): Inline[] => [...(index === 0 ? [] : [{ kind: 'break' } as const]), ...(line === '' ? [] : [{ kind: 'text', text: line } as const])]);
    });
}
/** The inline piece one match of {@link INLINE} stands for. */
function inlineOf(match: RegExpMatchArray): Inline {
    const [, code, target, label] = match;
    if (code !== undefined) {
        return { kind: 'code', text: code };
    }
    return target === undefined ? emphasisOf(match) : wikilinkOf(target, label);
}
function wikilinkOf(target: string, label: string | undefined): Inline {
    return { kind: 'wikilink', target: linkTarget(target), text: (label ?? target).trim() };
}
/** `**strong**` or `__strong__`, else `*emphasis*` or `_emphasis_`. */
function emphasisOf(match: RegExpMatchArray): Inline {
    const [, , , , strong, strongToo, em, emToo] = match;
    const inner = strong ?? strongToo;
    return inner === undefined
        ? { kind: 'em', children: parseInline(emphasisText(em, emToo)) }
        : { kind: 'strong', children: parseInline(inner) };
}
function emphasisText(em: string | undefined, emToo: string | undefined): string {
    return em ?? emToo ?? '';
}
/** The pieces of a line or a paragraph: text, links, code, emphasis and wikilinks. */
function parseInline(text: string): Inline[] {
    const pieces: Inline[] = [];
    let at = 0;
    for (const match of text.matchAll(INLINE)) {
        pieces.push(...textPieces(text.slice(at, match.index)), inlineOf(match));
        at = (match.index ?? 0) + match[0].length;
    }
    return [...pieces, ...textPieces(text.slice(at))];
}
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ITEM = /^([ \t]*)([-*+]|\d+[.)])[ \t]+(?:\[([ xX])\][ \t]+)?(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
/** A line that begins a block of its own, and so ends a paragraph. */
function startsBlock(line: string): boolean {
    return [ HEADING, RULE, FENCE, ITEM, QUOTE ].some((pattern) => pattern.test(line));
}
/** The block a line is all by itself — a heading or a rule; none when it is not one of those. */
function lineBlock(line: string): Block | undefined {
    const heading = HEADING.exec(line);
    if (heading !== null) {
        return headingOf(heading);
    }
    return RULE.test(line) ? { kind: 'rule' } : undefined;
}
function headingOf(heading: RegExpExecArray): Block {
    return { kind: 'heading', level: heading[1]?.length ?? 1, content: parseInline(heading[2] ?? '') };
}
/** Reads blocks off the lines of a note, one kind at a time. */
class BlockReader {
    readonly blocks: Block[] = [];
    private at = 0;
    constructor(private readonly lines: readonly string[]) {}
    read(): Block[] {
        this.frontMatter();
        while (this.at < this.lines.length) {
            this.block(this.lines[this.at] ?? '');
        }
        return this.blocks;
    }
    /** The YAML properties Obsidian keeps at the top, shown as they are. */
    private frontMatter(): void {
        const end = this.lines[0] === '---' ? this.lines.indexOf('---', 1) : -1;
        if (end > 0) {
            this.blocks.push({ kind: 'code', text: this.lines.slice(1, end).join('\n'), properties: true });
            this.at = end + 1;
        }
    }
    private block(line: string): void {
        const single = line.trim() === '' ? null : lineBlock(line);
        if (single === undefined) {
            this.multiline(line);
            return;
        }
        if (single !== null) {
            this.blocks.push(single);
        }
        this.at++;
    }
    private multiline(line: string): void {
        const fence = FENCE.exec(line);
        if (fence !== null) {
            this.code(fence[1]);
        } else if (ITEM.test(line)) {
            this.list();
        } else if (QUOTE.test(line)) {
            this.quote();
        } else {
            this.paragraph();
        }
    }
    /** Lines from here while `take` says they belong; each as `take` gives it back. */
    private takeWhile(take: (line: string) => string | undefined): string[] {
        const taken: string[] = [];
        for (let line = this.lines[this.at]; line !== undefined; line = this.lines[this.at]) {
            const kept = take(line);
            if (kept === undefined) {
                break;
            }
            taken.push(kept);
            this.at++;
        }
        return taken;
    }
    private code(marker: string | undefined): void {
        const fence = marker ?? '```';
        this.at++;
        const text = this.takeWhile((line) => (line.trimStart().startsWith(fence) ? undefined : line));
        this.at++;
        this.blocks.push({ kind: 'code', text: text.join('\n') });
    }
    private list(): void {
        const ordered = /^\s*\d/.test(this.lines[this.at] ?? '');
        const items = this.takeWhile((line) => (ITEM.test(line) && /^\s*\d/.test(line) === ordered ? line : undefined)).map(listItem);
        this.blocks.push({ kind: 'list', ordered, items });
    }
    private quote(): void {
        const text = this.takeWhile((line) => QUOTE.exec(line)?.[1]);
        this.blocks.push({ kind: 'quote', content: parseInline(text.join('\n')) });
    }
    private paragraph(): void {
        const first = this.lines[this.at++] ?? '';
        const rest = this.takeWhile((line) => (line.trim() === '' || startsBlock(line) ? undefined : line));
        this.blocks.push({ kind: 'paragraph', content: parseInline([first, ...rest].join('\n')) });
    }
}
function listItem(line: string): ListItem {
    const [, indent = '', , task, text = ''] = ITEM.exec(line) ?? [];
    const depth = Math.min(Math.floor(indent.replace(/\t/g, '  ').length / 2), 4);
    return { depth, ...taskMark(task), content: parseInline(text) };
}
/** Whether a task is done, `- [x]`; nothing for a plain item. */
function taskMark(task: string | undefined): Pick<ListItem, 'checked'> {
    return task === undefined ? {} : { checked: task !== ' ' };
}
/** The blocks of a note. */
function parseMarkdown(text: string): Block[] {
    return new BlockReader(text.replace(/\r\n?/g, '\n').split('\n')).read();
}
/** The words of inline pieces, without the markup: to compare a heading with the title. */
function plainText(pieces: readonly Inline[]): string {
    return pieces.map((piece) => {
        switch (piece.kind) {
            case 'break':
                return ' ';
            case 'strong':
            case 'em':
                return plainText(piece.children);
            default:
                return piece.text;
        }
    }).join('');
}
export { parseInline, parseMarkdown, plainText };
export type { Block, Inline, ListItem };
