/**
 * Links in the text of a message (#47): a bare `http(s)://…` address, or a
 * markdown link `[label](http(s)://…)` as agents often write them. The text is
 * cut into pieces of plain text and links, and the dashboard renders each
 * piece as a node — never as HTML — so whatever a message says, nothing in it
 * runs.
 */
type TextPiece = { readonly kind: 'text'; readonly text: string };
type LinkPiece = { readonly kind: 'link'; readonly text: string; readonly href: string };
type Piece = TextPiece | LinkPiece;
/** A markdown link, or a bare address up to a space or a character that does not go into one. */
const LINK = /\[([^\][\n]+)\]\((https?:\/\/[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)|https?:\/\/[^\s<>"'`«»]+/gi;
/** What a sentence puts after an address: it closes the sentence, not the address. */
const TRAILING = /[.,;:!?…]$/;
const PAIRS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
function count(text: string, char: string): number {
    return text.split(char).length - 1;
}
/** A closing bracket at the end belongs to the address only when the address opened it. */
function unbalanced(address: string): boolean {
    const last = address.slice(-1);
    const open = PAIRS[last];
    return open !== undefined && count(address, last) > count(address, open);
}
/** The address without the punctuation of the sentence around it. */
function trimAddress(address: string): string {
    let trimmed = address;
    while (TRAILING.test(trimmed) || unbalanced(trimmed)) {
        trimmed = trimmed.slice(0, -1);
    }
    return trimmed;
}
/** The address as a link target when it is a well-formed http(s) URL; anything else stays text. */
function hrefOf(address: string): string | undefined {
    try {
        const url = new URL(address);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' ? url.href : undefined;
    } catch {
        return undefined;
    }
}
/** The link a match stands for, and how much of the match it takes; undefined when it is not one. */
function linkOf(match: RegExpMatchArray): { readonly piece: LinkPiece; readonly length: number } | undefined {
    const [whole, label, target] = match;
    const address = label === undefined ? trimAddress(whole) : target;
    const href = hrefOf(address);
    if (href === undefined || address === '') {
        return undefined;
    }
    const piece: LinkPiece = { kind: 'link', text: label ?? address, href };
    return { piece, length: label === undefined ? address.length : whole.length };
}
/** Adds plain text to the pieces, joined to the text before it. */
function pushText(pieces: Piece[], text: string): void {
    if (text === '') {
        return;
    }
    const last = pieces[pieces.length - 1];
    if (last?.kind === 'text') {
        pieces[pieces.length - 1] = { kind: 'text', text: last.text + text };
    } else {
        pieces.push({ kind: 'text', text });
    }
}
/** The text of a message cut into plain text and links, in order; joined back, the texts give the message. */
function linkify(text: string): Piece[] {
    const pieces: Piece[] = [];
    let from = 0;
    for (const match of text.matchAll(LINK)) {
        const link = linkOf(match);
        if (link !== undefined) {
            pushText(pieces, text.slice(from, match.index));
            pieces.push(link.piece);
            from = match.index + link.length;
        }
    }
    pushText(pieces, text.slice(from));
    return pieces;
}
export { linkify };
export type { LinkPiece, Piece, TextPiece };
