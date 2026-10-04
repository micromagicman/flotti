import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { mentionPieces, mentionQuery, offerMembers } from '../web/src/mentions.js';
import type { MentionOption } from '../web/src/mentions.js';
const members: readonly MentionOption[] = [{ id: 'codex', name: 'Codex' }, { id: 'reviewer', name: 'Reviewer' }];
test('the @ picker reads the mention being typed from the text before the caret', () => {
    strictEqual(mentionQuery('@'), '');
    strictEqual(mentionQuery('hello @cod'), 'cod');
    strictEqual(mentionQuery('hello @codex'), 'codex');
    strictEqual(mentionQuery('eva@example.com'), undefined);
    strictEqual(mentionQuery('hello @codex '), undefined);
    strictEqual(mentionQuery('(@re'), 're');
});
test('the @ picker offers the members matched by name and id', () => {
    deepStrictEqual(offerMembers(members, '').map((m) => m.id), ['codex', 'reviewer']);
    deepStrictEqual(offerMembers(members, 'cod').map((m) => m.id), ['codex']);
    deepStrictEqual(offerMembers(members, 'rev').map((m) => m.id), ['reviewer']);
    deepStrictEqual(offerMembers(members, 'x').map((m) => m.id), ['codex']);
    deepStrictEqual(offerMembers(members, 'nope').map((m) => m.id), []);
});
test('a message text splits into its words and its mentions as chips', () => {
    deepStrictEqual(mentionPieces('@codex please review', ['codex']), [
        { kind: 'mention', id: 'codex' },
        { kind: 'text', text: ' please review' }
    ]);
    deepStrictEqual(mentionPieces('hi @codex and @reviewer', ['codex', 'reviewer']), [
        { kind: 'text', text: 'hi ' },
        { kind: 'mention', id: 'codex' },
        { kind: 'text', text: ' and ' },
        { kind: 'mention', id: 'reviewer' }
    ]);
    deepStrictEqual(mentionPieces('write to eva@example.com', ['eva']), [{ kind: 'text', text: 'write to eva@example.com' }]);
    deepStrictEqual(mentionPieces('@tester is not a member', ['codex']), [{ kind: 'text', text: '@tester is not a member' }]);
});
