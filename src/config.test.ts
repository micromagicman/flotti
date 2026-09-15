import {deepStrictEqual, match, ok, strictEqual} from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {
    CONFIGURATION_PATH_VARIABLE,
    DEFAULT_HEARTBEAT_TIMEOUT_SEC,
    DEFAULT_RESTART_POLICY,
    loadConfiguration,
    resolveConfigurationLocation
} from './config.js';
import type {LoadConfigurationOptions} from './config.js';
import {ConfigurationError} from './errors.js';

const HOME = '/home/eva';

const workspace = mkdtempSync(join(tmpdir(), 'supavisor-config-'));

after(() => rmSync(workspace, {recursive: true, force: true}));

let written = 0;

function configurationFile(contents: string | object): string {
    const path = join(workspace, `configuration-${++written}.json`);
    writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 4));
    return path;
}

function load(contents: string | object, options: LoadConfigurationOptions = {}) {
    return loadConfiguration({...options, argv: ['--config', configurationFile(contents)]});
}

function failure(options: LoadConfigurationOptions): ConfigurationError {
    try {
        loadConfiguration(options);
    } catch (error) {
        ok(error instanceof ConfigurationError, `expected a ConfigurationError, got ${String(error)}`);
        return error;
    }
    throw new Error('expected loadConfiguration() to fail, but it succeeded');
}

function rejected(contents: string | object): ConfigurationError {
    return failure({argv: ['--config', configurationFile(contents)]});
}

function withAgent(agent: object): object {
    return {agents: [agent]};
}

const VALID_AGENT = {name: 'claude', command: 'claude', arguments: ['-p', 'Hello, claude!']};

describe('resolveConfigurationLocation', () => {
    it('falls back to ~/.config/supavisor/configuration.json', () => {
        deepStrictEqual(resolveConfigurationLocation({argv: [], env: {HOME}}), {
            path: '/home/eva/.config/supavisor/configuration.json',
            source: 'default'
        });
    });

    it('takes the path from the environment variable and expands ~ itself', () => {
        deepStrictEqual(
            resolveConfigurationLocation({argv: [], env: {HOME, [CONFIGURATION_PATH_VARIABLE]: '~/agents.json'}}),
            {path: '/home/eva/agents.json', source: 'environment'}
        );
    });

    it('prefers the argument over the environment variable', () => {
        deepStrictEqual(
            resolveConfigurationLocation({
                argv: ['--config', '/etc/supavisor/agents.json'],
                env: {HOME, [CONFIGURATION_PATH_VARIABLE]: '~/agents.json'}
            }),
            {path: '/etc/supavisor/agents.json', source: 'argument'}
        );
    });

    it('accepts --config=<path> as well', () => {
        strictEqual(
            resolveConfigurationLocation({argv: ['--config=~/agents.json'], env: {HOME}}).path,
            '/home/eva/agents.json'
        );
    });

    it('resolves a relative path against the working directory', () => {
        strictEqual(
            resolveConfigurationLocation({argv: ['--config', 'agents.json'], env: {HOME}, cwd: '/srv/app'}).path,
            '/srv/app/agents.json'
        );
    });

    it('ignores an empty environment variable', () => {
        strictEqual(
            resolveConfigurationLocation({argv: [], env: {HOME, [CONFIGURATION_PATH_VARIABLE]: '  '}}).source,
            'default'
        );
    });

    it('reports --config without a path', () => {
        const error = failure({argv: ['--config'], env: {HOME}});
        strictEqual(error.kind, 'invalid-argument');
        match(error.message, /--config requires a path/);
    });

    it('reports a home directory that cannot be resolved', () => {
        const error = failure({argv: [], env: {}});
        strictEqual(error.kind, 'unresolved-home');
        match(error.message, /neither HOME nor USERPROFILE is set/);
        match(String(error.hint), /--config/);
    });
});

describe('loadConfiguration', () => {
    it('reads agents from the file and reports where they came from', () => {
        const path = configurationFile({
            agents: [
                VALID_AGENT,
                {
                    name: 'codex',
                    command: 'codex',
                    arguments: [],
                    workdir: '/srv/app',
                    env: {OPENAI_API_KEY: 'secret'},
                    restart: 'always',
                    heartbeatTimeoutSec: 15
                }
            ]
        });

        const loaded = loadConfiguration({argv: ['--config', path]});

        deepStrictEqual(loaded.location, {path, source: 'argument'});
        deepStrictEqual(loaded.configuration.agents[1], {
            name: 'codex',
            command: 'codex',
            arguments: [],
            workdir: '/srv/app',
            env: {OPENAI_API_KEY: 'secret'},
            restart: 'always',
            heartbeatTimeoutSec: 15
        });
    });

    it('fills the optional fields with the documented defaults', () => {
        const loaded = load(withAgent(VALID_AGENT));
        const agent = loaded.configuration.agents[0];

        strictEqual(agent?.workdir, undefined, 'no workdir means supavisor\'s own directory');
        deepStrictEqual(agent, {
            name: 'claude',
            command: 'claude',
            arguments: ['-p', 'Hello, claude!'],
            env: {},
            restart: DEFAULT_RESTART_POLICY,
            heartbeatTimeoutSec: DEFAULT_HEARTBEAT_TIMEOUT_SEC
        });
    });

    it('reads the file the environment variable points at', () => {
        const path = configurationFile(withAgent(VALID_AGENT));
        const loaded = loadConfiguration({argv: [], env: {HOME, [CONFIGURATION_PATH_VARIABLE]: path}});

        deepStrictEqual(loaded.location, {path, source: 'environment'});
    });

    it('reports a missing file apart from a broken one and tells how to create it', () => {
        const path = join(workspace, 'no-such-configuration.json');
        const error = failure({argv: ['--config', path]});

        strictEqual(error.kind, 'missing-file');
        match(error.message, /Configuration file not found/);
        ok(error.message.includes(path), `expected the path in ${error.message}`);
        match(String(error.hint), /--config/);
        match(String(error.hint), new RegExp(CONFIGURATION_PATH_VARIABLE));
        match(String(error.hint), /"agents"/);
    });

    it('reports a file it is not allowed to read', () => {
        const path = join(workspace, 'forbidden.json');
        const error = failure({
            argv: ['--config', path],
            readFile: () => {
                throw Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'});
            }
        });

        strictEqual(error.kind, 'not-readable');
        match(error.message, /permission denied/);
        ok(error.message.includes(path), `expected the path in ${error.message}`);
    });

    it('reports any other read failure', () => {
        const error = failure({
            argv: ['--config', join(workspace, 'busy.json')],
            readFile: () => {
                throw Object.assign(new Error('EISDIR: illegal operation on a directory'), {code: 'EISDIR'});
            }
        });

        strictEqual(error.kind, 'unreadable-file');
        match(error.message, /could not be read \(EISDIR\)/);
    });

    it('reports a file that is not JSON, with the place the parser stopped at', () => {
        const error = rejected('{\n    "agents": [\n        {"name": "claude",}\n    ]\n}\n');

        strictEqual(error.kind, 'not-json');
        match(error.message, /is not valid JSON/);
        match(error.message, /line 3/);
    });

    it('quotes the place even when the parser reports no line', () => {
        const error = rejected('{\n    "agents": [,]\n}\n');

        strictEqual(error.kind, 'not-json');
        match(error.message, /is not valid JSON \(Unexpected token/);
        ok(!error.message.endsWith('is not valid JSON)'), `the parser complaint is repeated in ${error.message}`);
    });

    it('reports a root value that is not an object', () => {
        const error = rejected([VALID_AGENT]);

        strictEqual(error.kind, 'wrong-type');
        match(error.message, /configuration must be a JSON object, got array/);
    });

    it('reports a missing agents list', () => {
        const error = rejected({});

        strictEqual(error.kind, 'missing-field');
        match(error.message, /agents is missing/);
    });

    it('reports an agents list that is not an array', () => {
        const error = rejected({agents: {claude: VALID_AGENT}});

        strictEqual(error.kind, 'wrong-type');
        match(error.message, /agents must be an array, got object/);
    });

    it('reports an empty agents list', () => {
        const error = rejected({agents: []});

        strictEqual(error.kind, 'empty-agent-list');
        match(error.message, /agents must list at least one agent/);
    });

    it('reports an agent that is not an object', () => {
        const error = rejected({agents: ['claude']});

        strictEqual(error.kind, 'wrong-type');
        match(error.message, /agents\[0\] must be a JSON object, got string/);
    });

    it('reports a missing required field with its place', () => {
        const error = rejected({agents: [VALID_AGENT, {name: 'codex', arguments: []}]});

        strictEqual(error.kind, 'missing-field');
        match(error.message, /agents\[1\]\.command is missing/);
    });

    it('reports an empty required field', () => {
        const error = rejected(withAgent({...VALID_AGENT, name: '   '}));

        strictEqual(error.kind, 'wrong-type');
        match(error.message, /agents\[0\]\.name must be a non-empty string/);
    });

    it('reports a field of the wrong type', () => {
        const error = rejected(withAgent({...VALID_AGENT, command: 42}));

        strictEqual(error.kind, 'wrong-type');
        match(error.message, /agents\[0\]\.command must be a non-empty string, got number/);
    });

    it('reports a non-string inside arguments', () => {
        const error = rejected(withAgent({...VALID_AGENT, arguments: ['-p', 7]}));

        strictEqual(error.kind, 'wrong-type');
        match(error.message, /agents\[0\]\.arguments\[1\] must be a string, got number/);
    });

    it('reports a non-string environment value', () => {
        const error = rejected(withAgent({...VALID_AGENT, env: {TOKEN: 7}}));

        strictEqual(error.kind, 'wrong-type');
        match(error.message, /agents\[0\]\.env\.TOKEN must be a string, got number/);
    });

    it('reports an unknown restart policy and lists the allowed ones', () => {
        const error = rejected(withAgent({...VALID_AGENT, restart: 'sometimes'}));

        strictEqual(error.kind, 'wrong-type');
        match(error.message, /agents\[0\]\.restart must be one of "always", "on-failure", "never", got "sometimes"/);
    });

    it('reports a heartbeat timeout that is not a positive number', () => {
        const error = rejected(withAgent({...VALID_AGENT, heartbeatTimeoutSec: 0}));

        strictEqual(error.kind, 'wrong-type');
        match(error.message, /agents\[0\]\.heartbeatTimeoutSec must be a positive number, got 0/);
    });

    it('reports repeated agent names', () => {
        const error = rejected({agents: [VALID_AGENT, {...VALID_AGENT, arguments: []}]});

        strictEqual(error.kind, 'duplicate-agent-name');
        match(error.message, /agents\[1\]\.name repeats the name "claude" of agents\[0\]/);
    });

    it('names the configuration file in every complaint about its contents', () => {
        const path = configurationFile({agents: []});
        const error = failure({argv: ['--config', path]});

        ok(error.message.startsWith(`${path}: `), `expected the path in ${error.message}`);
        strictEqual(error.path, path);
    });
});
