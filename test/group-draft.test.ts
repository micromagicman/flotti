import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentSummary } from '../src/dashboard-protocol.js';
import { fromGroupConfig, memberChoices, newGroupDraft, toGroupConfig, withMember } from '../web/src/group-draft.js';
const agent = (id: string, name = id): AgentSummary => ({ id, name, kind: 'local', status: 'idle' });
const FLEET = [agent('claude', 'Claude'), agent('codex')];
describe('the draft of a group', () => {
    it('starts empty: no id, no name, no topic, no member', () => {
        deepStrictEqual(newGroupDraft(), { id: '', name: '', topic: '', members: [], others: '' });
    });
    it('is the file as it says it: the name and the topic stay empty when the file has none', () => {
        deepStrictEqual(fromGroupConfig({ id: 'release', members: ['claude', 'ghost'] }),
            { id: 'release', name: '', topic: '', members: ['claude', 'ghost'], others: '' });
        deepStrictEqual(fromGroupConfig({ id: 'release', name: 'Release', topic: 'Ship it.', members: [] }).topic, 'Ship it.');
    });
    it('says the file: the blanks left out, the fields trimmed, the ticked members first and the typed ids after, each once', () => {
        deepStrictEqual(toGroupConfig({ id: ' release ', name: ' ', topic: ' Ship it. ', members: ['claude'], others: '' }),
            { id: 'release', topic: 'Ship it.', members: ['claude'] });
        deepStrictEqual(toGroupConfig({ id: 'release', name: 'Release', topic: '', members: ['codex', 'claude'], others: ' ghost \n\nclaude\nother\n' }),
            { id: 'release', name: 'Release', members: ['codex', 'claude', 'ghost', 'other'] });
    });
    it('does not check what the server checks: a wrong id and a wrong member id go as they are', () => {
        deepStrictEqual(toGroupConfig({ ...newGroupDraft(), id: '-bad', others: 'two words' }), { id: '-bad', members: ['two words'] });
    });
    it('ticks a member last and unticks it anywhere; ticking a member twice keeps its place', () => {
        const one = withMember(newGroupDraft(), 'codex', true);
        const two = withMember(one, 'claude', true);
        deepStrictEqual(two.members, ['codex', 'claude']);
        deepStrictEqual(withMember(two, 'codex', true).members, ['codex', 'claude']);
        deepStrictEqual(withMember(two, 'codex', false).members, ['claude']);
        strictEqual(withMember(two, 'ghost', false), two, 'unticking one that is not there changes nothing');
    });
    it('offers the agents of the fleet in its order, then the members the fleet does not have, ticked and marked so', () => {
        const draft = { ...newGroupDraft(), members: ['ghost', 'codex'] };
        deepStrictEqual(memberChoices(draft, FLEET), [
            { id: 'claude', name: 'Claude', inFleet: true, ticked: false },
            { id: 'codex', name: 'codex', inFleet: true, ticked: true },
            { id: 'ghost', name: 'ghost', inFleet: false, ticked: true }
        ]);
        deepStrictEqual(memberChoices(newGroupDraft(), []), []);
    });
    it('a member the fleet does not have, unticked, is out of the group', () => {
        const draft = withMember({ ...newGroupDraft(), members: ['ghost', 'codex'] }, 'ghost', false);
        deepStrictEqual(memberChoices(draft, FLEET).map((choice) => choice.id), ['claude', 'codex']);
    });
});
