import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { AgentAnswers } from '../src/agent-answers.js';
import type { AgentEvent, SendOptions } from '../src/agent-events.js';
import { senderMark } from '../src/agent-events.js';
import { senderMarks } from '../src/a2a-inbox.js';
import { INBOX_EXTENSION } from '../src/a2a-protocol.js';
import { mentionsIn, nonMemberMention } from '../src/mentions.js';
const members = ['eva', 'codex', 'reviewer'];
/** The answer a turn of `agentId` on a message owes, if any. */
function answerOf(agentId: string, message: { readonly text: string } & Partial<AgentEvent>): string | undefined {
    const answers = new AgentAnswers();
    answers.take({ type: 'message', role: 'user', messageId: 'u', append: false, agentId, seq: 1, time: '', ...message } as AgentEvent);
    answers.take({ type: 'message', role: 'agent', messageId: 'm', text: 'on it', append: false, agentId, seq: 2, time: '' } as AgentEvent);
    return answers.take({ type: 'turn-end', reason: 'end_turn', agentId, seq: 3, time: '' } as AgentEvent)?.text;
}
test('a mention is @ at the start or after a space, a bracket or a comma, followed by a member id', () => {
    deepStrictEqual(mentionsIn('@codex please review the diff', members), ['codex']);
    deepStrictEqual(mentionsIn('please, @codex, review', members), ['codex']);
    deepStrictEqual(mentionsIn('(@codex) and [@eva] and {@reviewer}', members), ['codex', 'eva', 'reviewer']);
    deepStrictEqual(mentionsIn('@codex and @eva, both', members), ['codex', 'eva']);
});
test('a mention keeps the order of the text, each once', () => {
    deepStrictEqual(mentionsIn('@eva @codex @eva', members), ['eva', 'codex']);
});
test('a mail address is not a mention', () => {
    deepStrictEqual(mentionsIn('write to eva@example.com about it', members), []);
    deepStrictEqual(mentionsIn('no @ here either', members), []);
});
test('an @id that is not a member is not a mention of one', () => {
    deepStrictEqual(mentionsIn('@tester and @codex', members), ['codex']);
    strictEqual(nonMemberMention('@codex please', members), undefined);
    strictEqual(nonMemberMention('@tester please', members), 'tester');
    strictEqual(nonMemberMention('@codex @tester', members), 'tester');
});
test('a group message asks the mentioned member only, and everyone when it mentions nobody', () => {
    strictEqual(answerOf('codex', { from: 'eva', group: 'release', text: '@codex please', mentions: ['codex'] }), 'on it');
    strictEqual(answerOf('reviewer', { from: 'eva', group: 'release', text: '@codex please', mentions: ['codex'] }), undefined);
    strictEqual(answerOf('reviewer', { from: 'eva', group: 'release', text: 'hello team' }), 'on it');
    strictEqual(answerOf('codex', { from: 'eva', group: 'release', text: 'hello team' }), 'on it');
});
test('a member mentioned by id in the text answers, whatever its place', () => {
    strictEqual(answerOf('eva', { from: 'codex', group: 'release', text: 'done, @eva', mentions: ['eva'] }), 'on it');
    strictEqual(answerOf('reviewer', { from: 'codex', group: 'release', text: 'done, @eva', mentions: ['eva'] }), undefined);
});
test('the mark in the text says who is asked', () => {
    const mentioned: SendOptions = { from: 'eva', group: 'release', mentions: ['codex'], mentioned: true };
    const other: SendOptions = { from: 'eva', group: 'release', mentions: ['codex'], mentioned: false };
    strictEqual(senderMark(mentioned), '[from eva in group release, to you]');
    strictEqual(senderMark(other), '[from eva in group release, to codex]');
    strictEqual(senderMark({ from: 'eva', group: 'release' }), '[from eva in group release]');
    strictEqual(senderMark({ group: 'release', mentions: ['codex'], mentioned: true }), '[in group release, to you]');
    strictEqual(senderMark({ from: 'eva', group: 'release', mentions: ['codex', 'reviewer'], mentioned: false }), '[from eva in group release, to codex, reviewer]');
});
test('the inbox metadata carries mentions beside from and group, the same array for every member', () => {
    deepStrictEqual(senderMarks({ from: 'eva', group: 'release', mentions: ['codex'] }).metadata?.[INBOX_EXTENSION], { from: 'eva', group: 'release', mentions: ['codex'] });
    deepStrictEqual(senderMarks({ from: 'eva', group: 'release' }).metadata?.[INBOX_EXTENSION], { from: 'eva', group: 'release' });
});
