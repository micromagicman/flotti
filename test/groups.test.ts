import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ConfigurationError } from '../src/errors.js';
import { readGroup } from '../src/fleet.js';
import { canReach, groupsOf, peersOf } from '../src/groups.js';
import type { Group } from '../src/types.js';
import { HOME, LOCAL, REMOTE, agent, failure, fleetDirectory, load } from './fleet-helpers.js';
/** Writes a group directory with the file given as text or as an object. */
function group(root: string, id: string, file: string | object): string {
    const directory = join(root, 'groups', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'group.json'), typeof file === 'string' ? file : JSON.stringify(file, null, 4));
    return directory;
}
/** Loads a fleet with a single group and returns the complaint about it. */
function refused(file: string | object): ConfigurationError {
    const root = fleetDirectory();
    group(root, 'release', file);
    return failure({ env: { HOME }, argv: ['--fleet', root] });
}
describe('loadFleet: the groups of the fleet', () => {
    it('reads a fleet without groups/ as one with no groups: none is made for it', () => {
        const root = fleetDirectory();
        agent(root, 'local', 'claude', LOCAL);
        deepStrictEqual(load(root).groups, []);
    });
    it('lists the groups by id, with the defaults filled in and unknown fields left alone', () => {
        const root = fleetDirectory();
        agent(root, 'local', 'eva', LOCAL);
        agent(root, 'remote', 'reviewer', REMOTE);
        const release = group(root, 'release', { name: 'Release 0.6.0', topic: 'Ship it.', members: ['eva', 'reviewer'], colour: 'kept' });
        group(root, 'docs', { members: [] });
        deepStrictEqual(load(root).groups, [
            { id: 'docs', name: 'docs', members: [], directory: join(root, 'groups', 'docs'), filePath: join(root, 'groups', 'docs', 'group.json') },
            { id: 'release', name: 'Release 0.6.0', topic: 'Ship it.', members: ['eva', 'reviewer'], directory: release, filePath: join(release, 'group.json') }
        ]);
    });
    it('keeps a member that is not in the fleet: it is not an error', () => {
        const root = fleetDirectory();
        agent(root, 'local', 'eva', LOCAL);
        group(root, 'release', { members: ['eva', 'gone'] });
        deepStrictEqual(load(root).groups[0]?.members, ['eva', 'gone']);
    });
    it('lets a group and an agent share an id: the two are separate namespaces', () => {
        const root = fleetDirectory();
        agent(root, 'local', 'eva', LOCAL);
        group(root, 'eva', { members: ['eva'] });
        strictEqual(load(root).groups[0]?.id, 'eva');
    });
    it('skips hidden entries, and reads one group on its own', () => {
        const root = fleetDirectory();
        group(root, 'release', { members: [] });
        writeFileSync(join(root, 'groups', '.DS_Store'), '');
        deepStrictEqual(load(root).groups.map((found) => found.id), ['release']);
        strictEqual(readGroup(root, 'release').name, 'release');
    });
});
describe('loadFleet: a group it refuses, naming the file', () => {
    it('a group directory without group.json, and offers one', () => {
        const root = fleetDirectory();
        mkdirSync(join(root, 'groups', 'release'), { recursive: true });
        const error = failure({ env: { HOME }, argv: ['--fleet', root] });
        strictEqual(error.kind, 'missing-group-file');
        match(error.message, /^Group file not found: .*release.group\.json$/);
        match(error.hint ?? '', /"members"/);
    });
    it('a file where a group directory is expected, and a directory name that cannot be an id', () => {
        const root = fleetDirectory();
        mkdirSync(join(root, 'groups'));
        writeFileSync(join(root, 'groups', 'release.json'), '{}');
        const file = failure({ env: { HOME }, argv: ['--fleet', root] });
        strictEqual(file.kind, 'not-a-directory');
        match(file.message, /release\.json: every group is a directory with group\.json in it/);
        const other = fleetDirectory();
        group(other, 'my group', { members: [] });
        const name = failure({ env: { HOME }, argv: ['--fleet', other] });
        strictEqual(name.kind, 'invalid-group-id');
        match(name.message, /"my group" cannot be a group id/);
    });
    it('a file that is not JSON, or not an object', () => {
        const json = refused('{\n    "members": [],\n}');
        strictEqual(json.kind, 'not-json');
        match(json.message, /group\.json: the group file is not valid JSON \(.+\)$/);
        match(refused('[]').message, /group\.json: the group must be a JSON object, got array$/);
    });
    it('members missing, not a list, not ids, or repeated', () => {
        const missing = refused({ name: 'Release' });
        strictEqual(missing.kind, 'missing-field');
        match(missing.message, /group\.json: members is missing/);
        match(refused({ members: 'eva' }).message, /members must be an array of agent ids, got string$/);
        match(refused({ members: ['eva', 7] }).message, /members\[1\] must be an agent id — .* got 7$/);
        match(refused({ members: ['my agent'] }).message, /members\[0\] must be an agent id/);
        match(refused({ members: ['eva', 'eva'] }).message, /members\[1\] repeats "eva"; an agent is in a group once$/);
    });
    it('a name or a topic that is not text, and an id other than the directory', () => {
        match(refused({ name: 3, members: [] }).message, /group\.json: name must be a non-empty string, got number$/);
        match(refused({ topic: '', members: [] }).message, /topic must be a non-empty string, got an empty one$/);
        const id = refused({ id: 'other', members: [] });
        strictEqual(id.kind, 'id-mismatch');
        match(id.message, /id is "other", but the group directory is "release"/);
    });
});
/** A group of the fleet in memory: the paths do not matter here. */
function of(id: string, members: string[]): Group {
    return { id, name: id, members, directory: `/fleet/groups/${id}`, filePath: `/fleet/groups/${id}/group.json` };
}
const GROUPS: readonly Group[] = [of('docs', ['writer', 'eva']), of('release', ['eva', 'reviewer', 'tester']), of('empty', [])];
describe('groupsOf, peersOf and canReach', () => {
    it('groupsOf: the groups the agent is in, in the order of the groups', () => {
        deepStrictEqual(groupsOf(GROUPS, 'eva').map((found) => found.id), ['docs', 'release']);
        deepStrictEqual(groupsOf(GROUPS, 'tester').map((found) => found.id), ['release']);
        deepStrictEqual(groupsOf(GROUPS, 'nobody'), []);
    });
    it('peersOf: the members of every group the agent is in, itself excluded, each once', () => {
        deepStrictEqual(peersOf(GROUPS, 'eva'), ['writer', 'reviewer', 'tester']);
        deepStrictEqual(peersOf(GROUPS, 'writer'), ['eva']);
        deepStrictEqual(peersOf(GROUPS, 'nobody'), [], 'an agent in no group has no peers');
        deepStrictEqual(peersOf([of('solo', ['eva'])], 'eva'), [], 'alone in a group, no peer');
        deepStrictEqual(peersOf([of('a', ['eva', 'x']), of('b', ['x', 'eva'])], 'eva'), ['x'], 'two groups, one peer');
    });
    it('canReach: the two share a group; nobody reaches itself, and an agent in no group reaches nobody', () => {
        ok(canReach(GROUPS, 'eva', 'tester'));
        ok(canReach(GROUPS, 'tester', 'eva'));
        ok(canReach(GROUPS, 'writer', 'eva'));
        ok(!canReach(GROUPS, 'writer', 'tester'), 'not in one group');
        ok(!canReach(GROUPS, 'eva', 'eva'));
        ok(!canReach(GROUPS, 'nobody', 'eva'));
        ok(!canReach(GROUPS, 'eva', 'nobody'));
        ok(!canReach([], 'eva', 'tester'), 'a fleet without groups: nobody sees anybody');
        ok(canReach([of('r', ['eva', 'gone'])], 'eva', 'gone'), 'membership only: whether the agent is in the fleet is for the supervisor to say');
    });
});
