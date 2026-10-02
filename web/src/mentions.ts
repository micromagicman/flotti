/**
 * The pure parts of a mention on the page (0.7.0, #174): the member being
 * typed in the composer, the members the `@` picker offers, and the split of a
 * message text into the words and the mentions a row shows as chips. Pure: the
 * page and the tests share them.
 */
import { mentionTokens } from '../../src/mentions.js';
/** A member the picker offers, or a mention the row shows as a chip: its id and name, as the roster gives them. */
type MentionOption = { readonly id: string; readonly name: string };
/** The pieces of a message text: the words, and the mentions shown as chips in place of `@<id>`. */
type MentionPiece = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'mention'; readonly id: string };
/** `@` that starts a mention: at the start of the text or after a space, a bracket or a comma. */
const AT = /(?:^|[\s(\[{,])@/g;
/**
 * The mention being typed: the text from the last `@` that starts a mention to
 * the caret. Nothing when the caret is not right after such an `@` — the last
 * `@` stands after a letter (a mail address), or a space, a bracket or a comma
 * already closed the mention.
 */
function mentionQuery(beforeCaret: string): string | undefined {
    const matches = [...beforeCaret.matchAll(AT)];
    const last = matches.at(-1);
    if (last === undefined) {
        return undefined;
    }
    const query = beforeCaret.slice(last.index + last[0].length);
    return /[\s(\[{,]/.test(query) ? undefined : query;
}
/** The members the picker offers for the query, matched by name and id, in the order of the members. */
function offerMembers(members: readonly MentionOption[], query: string): readonly MentionOption[] {
    const q = query.toLowerCase();
    return members.filter((member) => member.name.toLowerCase().includes(q) || member.id.toLowerCase().includes(q));
}
/**
 * The text of a message split into its words and its mentions, in the order
 * they appear: an `@<id>` that is in `mentions` becomes a chip, any other text
 * — including an `@id` that is not a mention and a mail address — stays words.
 */
function mentionPieces(text: string, mentions: readonly string[]): readonly MentionPiece[] {
    const mentionSet = new Set(mentions);
    const pieces: MentionPiece[] = [];
    let at = 0;
    for (const token of mentionTokens(text)) {
        if (!mentionSet.has(token.id)) {
            continue;
        }
        pieces.push(...textPiece(text, at, token.start));
        pieces.push({ kind: 'mention', id: token.id });
        at = token.end;
    }
    pieces.push(...textPiece(text, at, text.length));
    return pieces;
}
/** The words between two positions, as one piece; nothing when there are none. */
function textPiece(text: string, from: number, to: number): readonly MentionPiece[] {
    return to > from ? [{ kind: 'text', text: text.slice(from, to) }] : [];
}
export { mentionPieces, mentionQuery, offerMembers };
export type { MentionOption, MentionPiece };