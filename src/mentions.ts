/**
 * Reading a mention out of the text of a group message (0.7.0, #174): `@<id>`,
 * where the id is that of a member as `list_groups` gives it. `@` is a mention
 * at the start of the text or after a space, a bracket or a comma;
 * `eva@example.com` is a mail address, not a mention, since its `@` stands
 * after a letter.
 *
 * One pure parser, shared by the server and the page: every path a group
 * message comes in reads the mentions the same way, and the page reads the
 * chips of a row with the same rule.
 */
/** An agent id, as the rule of a member gives it (src/groups.ts): letters, digits, ".", "_", "-". */
const MENTION_ID = '[A-Za-z0-9][A-Za-z0-9._-]*';
/** `@` at the start of the text or after a space, a bracket or a comma, followed by an id. */
const MENTION = new RegExp(`(?:^|[\\s(\\[{,])@(${MENTION_ID})`, 'g');
/** One `@id` of the text: the id, and where the `@` begins and the id ends. */
type MentionToken = { readonly id: string; readonly start: number; readonly end: number };
/** The `@id` mentions of the text, in the order they appear; a mail address is not one (its `@` stands after a letter). */
function mentionTokens(text: string): MentionToken[] {
    const found: MentionToken[] = [];
    for (const match of text.matchAll(MENTION)) {
        const id = match[1];
        if (id === undefined) {
            continue;
        }
        // `match[0]` carries the space, bracket or comma before the `@`, or nothing at the start of the text.
        const idStart = match.index + match[0].length - id.length;
        found.push({ id, start: idStart - 1, end: idStart + id.length });
    }
    return found;
}
/** The ids the text names with `@`, in the order they appear, each once. */
function atIds(text: string): string[] {
    const found: string[] = [];
    for (const token of mentionTokens(text)) {
        if (!found.includes(token.id)) {
            found.push(token.id);
        }
    }
    return found;
}
/**
 * The members the text mentions, in the order of the text, each once; an
 * `@id` that is not a member is not a mention of one and is left out.
 */
function mentionsIn(text: string, members: readonly string[]): string[] {
    const memberOf = new Set(members);
    return atIds(text).filter((id) => memberOf.has(id));
}
/**
 * The first `@id` of the text that is not a member of the group — an agent of
 * another group, or nobody at all; the two are refused alike, so that an agent
 * outside a group learns nothing of the members. Nothing when every `@id` is a
 * member or there is none.
 */
function nonMemberMention(text: string, members: readonly string[]): string | undefined {
    const memberOf = new Set(members);
    return atIds(text).find((id) => !memberOf.has(id));
}
/**
 * A message to a group mentions an id that is not a member of it (0.7.0,
 * #174): the message is not posted. The sentence names the id and the group,
 * as a person reads it; an agent is told the same in other words.
 */
class NonMemberMentionError extends Error {
    constructor(readonly agentId: string, readonly groupId: string) {
        super(`"${agentId}" is not a member of group "${groupId}"`);
    }
}
export { atIds, mentionsIn, nonMemberMention, mentionTokens, NonMemberMentionError };
export type { MentionToken };