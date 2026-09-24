import { deepStrictEqual, match, strictEqual } from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_HEARTBEAT_TIMEOUT_SEC, DEFAULT_RESTART_POLICY } from '../src/manifest.js';
import { LOCAL, REMOTE, agent, failure, fleetDirectory, load, rejected, single } from './fleet-helpers.js';
describe('local manifest: reading it', () => {
    it('reads every field', () => {
        const { agent: found, directory } = single('local', {
            id: 'agent',
            name: 'Claude',
            description: 'Writes the code',
            adapter: 'claude-code',
            model: 'opus',
            command: 'npx',
            arguments: ['@zed-industries/claude-code-acp'],
            workdir: '/srv/app',
            env: { LOG_LEVEL: 'debug' },
            restart: 'always',
            heartbeatTimeoutSec: 15
        });
        deepStrictEqual(found, {
            id: 'agent',
            name: 'Claude',
            description: 'Writes the code',
            directory,
            manifestPath: join(directory, 'agent.json'),
            kind: 'local',
            adapter: 'claude-code',
            model: 'opus',
            command: 'npx',
            arguments: ['@zed-industries/claude-code-acp'],
            workdir: '/srv/app',
            env: { LOG_LEVEL: 'debug' },
            restart: 'always',
            heartbeatTimeoutSec: 15,
            skillsDirectory: join(directory, 'skills'),
            memoryDirectory: join(directory, 'memory')
        });
    });
});
describe('local manifest: defaults', () => {
    it('fills the optional fields with the documented defaults', () => {
        const { agent: found, directory } = single('local', LOCAL);
        deepStrictEqual(found, {
            id: 'agent',
            name: 'agent',
            directory,
            manifestPath: join(directory, 'agent.json'),
            kind: 'local',
            command: 'claude-code-acp',
            arguments: [],
            workdir: directory,
            env: {},
            restart: DEFAULT_RESTART_POLICY,
            heartbeatTimeoutSec: DEFAULT_HEARTBEAT_TIMEOUT_SEC,
            skillsDirectory: join(directory, 'skills'),
            memoryDirectory: join(directory, 'memory')
        });
    });
});
describe('local manifest: paths', () => {
    it('resolves workdir against the agent directory and expands ~', () => {
        const relative = single('local', { ...LOCAL, workdir: 'repo' });
        strictEqual(relative.agent.kind === 'local' && relative.agent.workdir, join(relative.directory, 'repo'));
        const home = single('local', { ...LOCAL, workdir: '~/src' }).agent;
        strictEqual(home.kind === 'local' && home.workdir, join('/home/eva', 'src'));
    });
    it('points at system-prompt.md when the agent has one', () => {
        const root = fleetDirectory();
        const directory = agent(root, 'local', 'claude', LOCAL);
        writeFileSync(join(directory, 'system-prompt.md'), 'You are Claude.');
        const [found] = load(root).agents;
        strictEqual(found?.kind === 'local' && found.systemPromptFile, join(directory, 'system-prompt.md'));
    });
    it('reports system-prompt.md that is not a file', () => {
        const root = fleetDirectory();
        const directory = agent(root, 'local', 'claude', LOCAL);
        mkdirSync(join(directory, 'system-prompt.md'));
        strictEqual(failure({ argv: ['--fleet', root], env: { HOME: '/home/eva' } }).kind, 'wrong-type');
    });
});
describe('local manifest: fields it refuses', () => {
    it('reports a root value that is not an object', () => {
        match(rejected('local', '[]').message, /agent\.json: the manifest must be a JSON object, got array$/);
    });
    it('reports a missing command', () => {
        const error = rejected('local', { name: 'Claude' });
        strictEqual(error.kind, 'missing-field');
        match(error.message, /agent\.json: command is missing \(expected a non-empty string\)$/);
    });
    it('reports an empty command', () => {
        match(rejected('local', { command: ' ' }).message, /command must be a non-empty string, got an empty one$/);
    });
    it('reports a non-string inside arguments', () => {
        match(rejected('local', { ...LOCAL, arguments: ['-p', 1] }).message, /arguments\[1\] must be a string, got number$/);
    });
    it('reports a non-string environment value', () => {
        match(rejected('local', { ...LOCAL, env: { PORT: 8080 } }).message, /env\.PORT must be a string, got number$/);
    });
    it('reports an unknown adapter and lists the known ones', () => {
        match(
            rejected('local', { ...LOCAL, adapter: 'gemini' }).message,
            /adapter must be one of "claude-code", "codex", got "gemini"$/
        );
    });
    it('reports an unknown restart policy', () => {
        match(rejected('local', { ...LOCAL, restart: 'sometimes' }).message, /restart must be one of "always"/);
    });
    it('reports a heartbeat timeout that is not a positive number', () => {
        match(
            rejected('local', { ...LOCAL, heartbeatTimeoutSec: 0 }).message,
            /heartbeatTimeoutSec must be a positive number, got 0$/
        );
    });
    it('reports an id other than the directory name', () => {
        const error = rejected('local', { ...LOCAL, id: 'claude' });
        strictEqual(error.kind, 'id-mismatch');
        match(error.message, /id is "claude", but the agent directory is "agent"/);
    });
});
describe('manifest: the administrator of the fleet', () => {
    it('reads admin: true, local or remote, and leaves the agent without the role otherwise', () => {
        strictEqual(single('local', { ...LOCAL, admin: true }).agent.admin, true);
        strictEqual(single('remote', { ...REMOTE, admin: true }).agent.admin, true);
        strictEqual('admin' in single('local', { ...LOCAL, admin: false }).agent, false);
        strictEqual('admin' in single('local', LOCAL).agent, false);
    });
    it('reports admin that is not true or false', () => {
        match(rejected('local', { ...LOCAL, admin: 'yes' }).message, /admin must be true or false, got "yes"/);
    });
});
describe('remote manifest', () => {
    it('fills the defaults: A2A, no authentication, the id as the name', () => {
        const { agent: found, directory } = single('remote', REMOTE);
        deepStrictEqual(found, {
            id: 'agent',
            name: 'agent',
            directory,
            manifestPath: join(directory, 'agent.json'),
            kind: 'remote',
            protocol: 'a2a',
            url: 'https://eva.example.org/a2a',
            auth: { type: 'none' }
        });
    });
    it('reads bearer and api-key authentication by the name of a variable', () => {
        const bearer = single('remote', { ...REMOTE, auth: { type: 'bearer', tokenEnv: 'EVA_A2A_TOKEN' } }).agent;
        deepStrictEqual(bearer.kind === 'remote' && bearer.auth, { type: 'bearer', tokenEnv: 'EVA_A2A_TOKEN' });
        const key = single('remote', {
            ...REMOTE,
            auth: { type: 'api-key', header: 'X-Api-Key', valueEnv: 'CUTIE_KEY' }
        }).agent;
        deepStrictEqual(key.kind === 'remote' && key.auth, { type: 'api-key', header: 'X-Api-Key', valueEnv: 'CUTIE_KEY' });
    });
    it('reports a missing or non-http url', () => {
        strictEqual(rejected('remote', {}).kind, 'missing-field');
        match(rejected('remote', { url: 'ftp://eva' }).message, /url must be an http: or https: address, got "ftp:\/\/eva"$/);
        match(rejected('remote', { url: 'eva' }).message, /url must be an http: or https: address/);
    });
    it('reports authentication without a type, or with a secret in place of a variable name', () => {
        strictEqual(rejected('remote', { ...REMOTE, auth: {} }).kind, 'missing-field');
        match(
            rejected('remote', { ...REMOTE, auth: { type: 'bearer', tokenEnv: 'sk-live 123' } }).message,
            /auth\.tokenEnv must name an environment variable .* the secret itself stays out of the manifest$/
        );
        match(rejected('remote', { ...REMOTE, auth: { type: 'bearer' } }).message, /auth\.tokenEnv is missing/);
    });
    it('reports an unknown protocol', () => {
        match(rejected('remote', { ...REMOTE, protocol: 'acp' }).message, /protocol must be one of "a2a", got "acp"$/);
    });
});
describe('remote manifest: over SSH', () => {
    it('takes "user@host" alone, in place of url', () => {
        const found = single('remote', { ssh: 'eva@example.org' }).agent;
        deepStrictEqual(found.kind === 'remote' && [found.ssh, found.url], [{ target: 'eva@example.org' }, undefined]);
    });
    it('takes the target and the published agent as an object', () => {
        const found = single('remote', { ssh: { target: 'cutie@10.0.0.7:2222', agent: 'cutie' } }).agent;
        deepStrictEqual(found.kind === 'remote' && found.ssh, { target: 'cutie@10.0.0.7:2222', agent: 'cutie' });
    });
    it('refuses url and ssh together, and an address ssh would take for an option', () => {
        match(rejected('remote', { ...REMOTE, ssh: 'eva@example.org' }).message, /url and ssh cannot both be given/);
        match(rejected('remote', { ssh: '-oProxyCommand=touch /tmp/x' }).message, /ssh\.target: .* is not an SSH address/);
        match(rejected('remote', { ssh: { agent: 'eva' } }).message, /ssh\.target is missing/);
        match(rejected('remote', { ssh: 42 }).message, /ssh must be "user@host" or a JSON object, got number/);
    });
    it('says how to fix a manifest with neither url nor ssh', () => {
        match(rejected('remote', {}).message, /url is missing: give the address of the agent, or "ssh": "user@host"/);
    });
});
