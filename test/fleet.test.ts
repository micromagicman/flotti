import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FLEET_PATH_VARIABLE, loadFleet, prepareFleet, resolveFleetLocation } from '../src/fleet.js';
import { HOME, LOCAL, REMOTE, agent, failure, fleetDirectory, load, workspace } from './fleet-helpers.js';
describe('resolveFleetLocation: where the path comes from', () => {
    it('falls back to ~/.supavisor/agents', () => {
        deepStrictEqual(resolveFleetLocation({ argv: [], env: { HOME } }), {
            path: '/home/eva/.supavisor/agents',
            source: 'default'
        });
    });
    it('takes the path from the environment variable and expands ~ itself', () => {
        deepStrictEqual(
            resolveFleetLocation({ argv: [], env: { HOME, [FLEET_PATH_VARIABLE]: '~/fleets/test' } }),
            { path: '/home/eva/fleets/test', source: 'environment' }
        );
    });
    it('prefers the argument over the environment variable', () => {
        deepStrictEqual(
            resolveFleetLocation({
                argv: ['--fleet', '/srv/fleet'],
                env: { HOME, [FLEET_PATH_VARIABLE]: '~/fleets/test' }
            }),
            { path: '/srv/fleet', source: 'argument' }
        );
    });
    it('accepts --fleet=<dir> and resolves a relative one against the working directory', () => {
        strictEqual(
            resolveFleetLocation({ argv: ['--fleet=fleet'], env: { HOME }, cwd: '/srv' }).path,
            '/srv/fleet'
        );
    });
    it('ignores an empty environment variable', () => {
        strictEqual(resolveFleetLocation({ argv: [], env: { HOME, [FLEET_PATH_VARIABLE]: ' ' } }).source, 'default');
    });
    it('reports --fleet without a path', () => {
        strictEqual(failure({ argv: ['--fleet'], env: { HOME } }).kind, 'invalid-argument');
    });
    it('reports a home directory that cannot be resolved', () => {
        const error = failure({ argv: [], env: {} });
        strictEqual(error.kind, 'unresolved-home');
        match(error.hint ?? '', /--fleet <path>/);
    });
});
describe('loadFleet: the fleet directory', () => {
    it('reads a missing default directory as an empty fleet', () => {
        const home = join(workspace, 'no-such-home');
        const fleet = loadFleet({ argv: [], env: { HOME: home } });
        strictEqual(fleet.exists, false);
        deepStrictEqual(fleet.agents, []);
    });
    it('reports a missing directory it was pointed at', () => {
        const error = failure({ argv: ['--fleet', join(workspace, 'nowhere')], env: { HOME } });
        strictEqual(error.kind, 'missing-fleet');
        match(error.message, /Fleet directory not found: .*nowhere/);
    });
    it('reads a directory without local/ and remote/ as an empty fleet', () => {
        const fleet = load(fleetDirectory());
        strictEqual(fleet.exists, true);
        deepStrictEqual(fleet.agents, []);
    });
    it('reports a fleet path that is a file', () => {
        const path = join(workspace, 'fleet-file');
        writeFileSync(path, '');
        strictEqual(failure({ argv: ['--fleet', path], env: { HOME } }).kind, 'not-a-directory');
    });
    it('lists local agents first, then remote ones, each ordered by id', () => {
        const root = fleetDirectory();
        agent(root, 'remote', 'eva', REMOTE);
        agent(root, 'local', 'codex', LOCAL);
        agent(root, 'remote', 'cutie', REMOTE);
        agent(root, 'local', 'claude', LOCAL);
        deepStrictEqual(
            load(root).agents.map((found) => `${found.kind}/${found.id}`),
            ['local/claude', 'local/codex', 'remote/cutie', 'remote/eva']
        );
    });
});
describe('loadFleet: agent directories', () => {
    it('skips hidden entries', () => {
        const root = fleetDirectory();
        agent(root, 'local', 'claude', LOCAL);
        writeFileSync(join(root, 'local', '.DS_Store'), '');
        mkdirSync(join(root, 'local', '.trash'));
        deepStrictEqual(load(root).agents.map((found) => found.id), ['claude']);
    });
    it('reports a file where an agent directory is expected', () => {
        const root = fleetDirectory();
        mkdirSync(join(root, 'local'));
        writeFileSync(join(root, 'local', 'claude.json'), '{}');
        const error = failure({ argv: ['--fleet', root], env: { HOME } });
        strictEqual(error.kind, 'not-a-directory');
        match(error.message, /claude\.json: every agent is a directory with agent\.json in it/);
    });
    it('reports a directory name that cannot be an id', () => {
        const root = fleetDirectory();
        agent(root, 'local', 'my agent', LOCAL);
        strictEqual(failure({ argv: ['--fleet', root], env: { HOME } }).kind, 'invalid-agent-id');
    });
    it('reports an agent directory without a manifest and offers one', () => {
        const root = fleetDirectory();
        mkdirSync(join(root, 'local', 'claude'), { recursive: true });
        const error = failure({ argv: ['--fleet', root], env: { HOME } });
        strictEqual(error.kind, 'missing-manifest');
        match(error.message, /Agent manifest not found: .*claude.agent\.json/);
        match(error.hint ?? '', /"command"/);
    });
    it('reports one id used by a local and a remote agent', () => {
        const root = fleetDirectory();
        agent(root, 'local', 'eva', LOCAL);
        agent(root, 'remote', 'eva', REMOTE);
        const error = failure({ argv: ['--fleet', root], env: { HOME } });
        strictEqual(error.kind, 'duplicate-agent-id');
        match(error.message, /the id "eva" is already taken by the local agent/);
    });
});
describe('loadFleet: a manifest it cannot read', () => {
    it('reports a manifest it is not allowed to read', () => {
        const root = fleetDirectory();
        agent(root, 'local', 'claude', LOCAL);
        const error = failure({
            argv: ['--fleet', root],
            env: { HOME },
            readFile: () => {
                throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            }
        });
        strictEqual(error.kind, 'not-readable');
        match(error.message, /^Agent manifest is not readable \(permission denied\): .*agent\.json$/);
    });
    it('reports a manifest that is not JSON, with the place the parser stopped at', () => {
        const root = fleetDirectory();
        agent(root, 'local', 'claude', '{\n    "command": "claude",\n}');
        const error = failure({ argv: ['--fleet', root], env: { HOME } });
        strictEqual(error.kind, 'not-json');
        match(error.message, /agent\.json: the manifest is not valid JSON \(.+\)$/);
    });
});
describe('prepareFleet', () => {
    it('creates skills/ and memory/ of local agents and leaves existing ones alone', () => {
        const root = fleetDirectory();
        const claude = agent(root, 'local', 'claude', LOCAL);
        mkdirSync(join(claude, 'skills'));
        writeFileSync(join(claude, 'skills', 'note.md'), 'mine');
        agent(root, 'remote', 'eva', REMOTE);
        const created = prepareFleet(load(root));
        deepStrictEqual(created, [join(claude, 'memory')]);
        ok(statSync(join(claude, 'memory')).isDirectory());
        ok(existsSync(join(claude, 'skills', 'note.md')));
        ok(!existsSync(join(root, 'remote', 'eva', 'skills')));
        deepStrictEqual(prepareFleet(load(root)), []);
    });
    it('reports skills/ taken by a file', () => {
        const root = fleetDirectory();
        const claude = agent(root, 'local', 'claude', LOCAL);
        writeFileSync(join(claude, 'skills'), '');
        const fleet = load(root);
        let kind: string | undefined;
        try {
            prepareFleet(fleet);
        } catch (error) {
            kind = (error as { kind?: string }).kind;
        }
        strictEqual(kind, 'not-a-directory');
    });
});
