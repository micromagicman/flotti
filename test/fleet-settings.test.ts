import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { AgentConfig } from '../src/dashboard-protocol.js';
import { ConfigurationError } from '../src/errors.js';
import { loadFleet, resolveFleetLocation } from '../src/fleet.js';
import { FleetSettings, TRASH_DIRECTORY } from '../src/fleet-settings.js';
import type { FleetSettingsOptions } from '../src/fleet-settings.js';
import { SshError } from '../src/ssh.js';
import type { PublishedAgent, SshTarget } from '../src/ssh.js';
import { readSettings } from '../src/settings.js';
import { Supervisor } from '../src/supervisor.js';
import type { Fleet } from '../src/types.js';
import { FakeFleetAgent } from './fake-fleet-agent.js';
const workspace = mkdtempSync(join(tmpdir(), 'flotti-settings-'));
after(() => rmSync(workspace, { recursive: true, force: true }));
let made = 0;
/** A home directory of its own and a fleet in it, run by a supervisor of fake agents. */
function setUp(write?: (root: string) => void, options: Pick<FleetSettingsOptions, 'discover'> = {}) {
    const home = join(workspace, `home-${++made}`);
    const root = join(home, 'fleet');
    mkdirSync(root, { recursive: true });
    write?.(root);
    const env = { HOME: home };
    const fleet = loadFleet({ argv: ['--fleet', root], env });
    const fakes = new Map<string, FakeFleetAgent>();
    const createAgent = (agent: { id: string }): FakeFleetAgent => {
        const created = new FakeFleetAgent(agent.id);
        fakes.set(agent.id, created);
        return created;
    };
    const supervisor = new Supervisor(fleet, { createAgent });
    const switched: Fleet[] = [];
    const settings = new FleetSettings(fleet, supervisor, { env, onSwitch: (next) => switched.push(next), ...options });
    return { home, root, env, supervisor, settings, fakes, switched };
}
function manifestAt(root: string, group: string, id: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(root, group, id, 'agent.json'), 'utf8')) as Record<string, unknown>;
}
function writeAgent(root: string, group: string, id: string, manifest: object): void {
    mkdirSync(join(root, group, id), { recursive: true });
    writeFileSync(join(root, group, id, 'agent.json'), JSON.stringify(manifest));
}
async function settled(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
}
const CLAUDE: AgentConfig = {
    kind: 'local',
    id: 'claude',
    name: 'Claude',
    adapter: 'claude-code',
    command: 'npx',
    arguments: ['-y', '@agentclientprotocol/claude-agent-acp@0.81.1'],
    env: {},
    systemPrompt: 'Be brief.'
};
describe('FleetSettings: a new agent', () => {
    test('writes its directory, leaves the empty fields out, and starts it', async () => {
        const { root, supervisor, settings, fakes } = setUp();
        const summary = settings.create(CLAUDE);
        deepStrictEqual([summary.id, summary.name, summary.kind], ['claude', 'Claude', 'local']);
        deepStrictEqual(manifestAt(root, 'local', 'claude'), {
            name: 'Claude',
            adapter: 'claude-code',
            command: 'npx',
            arguments: ['-y', '@agentclientprotocol/claude-agent-acp@0.81.1']
        });
        strictEqual(readFileSync(join(root, 'local', 'claude', 'system-prompt.md'), 'utf8'), 'Be brief.\n');
        ok(existsSync(join(root, 'local', 'claude', 'skills')), 'skills/ is created');
        ok(existsSync(join(root, 'local', 'claude', 'memory')), 'memory/ is created');
        await settled();
        deepStrictEqual(fakes.get('claude')?.calls, ['start']);
        deepStrictEqual(supervisor.agents().map((agent) => [agent.id, agent.status]), [['claude', 'idle']]);
        strictEqual(loadFleet({ argv: ['--fleet', root] }).agents.length, 1, 'flotti run reads it just the same');
    });
    test('a remote one keeps the name of the secret, never a secret', () => {
        const { root, settings } = setUp();
        settings.create({ kind: 'remote', id: 'eva', url: 'https://eva.example.org/a2a', auth: { type: 'bearer', tokenEnv: 'EVA_TOKEN' } });
        deepStrictEqual(manifestAt(root, 'remote', 'eva'), {
            url: 'https://eva.example.org/a2a',
            auth: { type: 'bearer', tokenEnv: 'EVA_TOKEN' }
        });
    });
    test('refuses what flotti run would refuse, and writes nothing', () => {
        const { root, settings } = setUp((fleet) => writeAgent(fleet, 'remote', 'eva', { url: 'https://eva.example.org' }));
        const refused = (config: unknown, kind: string): void => {
            throws(() => settings.create(config), (error: unknown) => error instanceof ConfigurationError && error.kind === kind);
        };
        refused({ ...CLAUDE, command: '' }, 'missing-field');
        refused({ ...CLAUDE, id: '-claude' }, 'invalid-agent-id');
        refused({ ...CLAUDE, id: 'eva' }, 'duplicate-agent-id');
        refused({ ...CLAUDE, restart: 'sometimes' }, 'wrong-type');
        refused({ kind: 'remote', id: 'qu', url: 'ftp://qu.example.org' }, 'wrong-type');
        refused({ kind: 'robot', id: 'r2' }, 'wrong-type');
        deepStrictEqual(readdirSync(root).sort(), ['remote']);
    });
});
/** A fleet with an agent written by hand, with a field the page does not edit. */
function existing(fleet: string): void {
    writeAgent(fleet, 'local', 'codex', { name: 'Codex', command: 'codex-acp', restart: 'always', note: 'kept' });
    writeFileSync(join(fleet, 'local', 'codex', 'system-prompt.md'), 'Old prompt.\n');
}
describe('FleetSettings: an agent of the fleet', () => {
    test('its manifest is read as the file says it, without the defaults', () => {
        const { settings } = setUp(existing);
        deepStrictEqual(settings.config('codex'), {
            kind: 'local',
            id: 'codex',
            name: 'Codex',
            command: 'codex-acp',
            restart: 'always',
            systemPrompt: 'Old prompt.\n'
        });
    });
    test('a change is written over the file, keeps what the page does not edit, and restarts the agent', async () => {
        const { root, supervisor, settings, fakes } = setUp(existing);
        await supervisor.start();
        const summary = await settings.update('codex', { kind: 'local', id: 'codex', name: 'Codex 2', command: 'codex-acp', model: 'gpt-5', systemPrompt: '' });
        strictEqual(summary.name, 'Codex 2');
        deepStrictEqual(manifestAt(root, 'local', 'codex'), { name: 'Codex 2', command: 'codex-acp', note: 'kept', model: 'gpt-5' });
        ok(!existsSync(join(root, 'local', 'codex', 'system-prompt.md')), 'an empty prompt removes the file');
        await settled();
        deepStrictEqual(fakes.get('codex')?.calls, ['start'], 'the new manifest runs in an agent started anew');
        strictEqual(supervisor.agent('codex').kind === 'local' && supervisor.agent('codex').name, 'Codex 2');
    });
    test('a stopped agent stays stopped after a change', async () => {
        const { supervisor, settings, fakes } = setUp(existing);
        await settings.update('codex', { kind: 'local', id: 'codex', command: 'codex-acp' });
        await settled();
        deepStrictEqual(fakes.get('codex')?.calls, []);
        strictEqual(supervisor.agents()[0]?.status, 'stopped');
    });
    test('a broken change leaves the file and the running agent as they were', async () => {
        const { root, settings } = setUp(existing);
        await rejects(settings.update('codex', { kind: 'local', id: 'codex', command: 'codex-acp', heartbeatTimeoutSec: -1 }), ConfigurationError);
        await rejects(settings.update('codex', { kind: 'remote', id: 'codex', url: 'https://x.example.org' }), ConfigurationError);
        strictEqual(manifestAt(root, 'local', 'codex')['name'], 'Codex');
    });
});
describe('FleetSettings: administrators', () => {
    test('the role is written to the manifest when ticked, left out when not, and the fleet lists it', async () => {
        const { root, supervisor, settings } = setUp(existing);
        await settings.update('codex', { kind: 'local', id: 'codex', command: 'codex-acp', admin: true });
        strictEqual(manifestAt(root, 'local', 'codex')['admin'], true);
        strictEqual(settings.config('codex').admin, true);
        strictEqual(supervisor.agents()[0]?.admin, true);
        await settings.update('codex', { kind: 'local', id: 'codex', command: 'codex-acp', admin: false });
        ok(!('admin' in manifestAt(root, 'local', 'codex')), 'no role, no field');
        strictEqual(supervisor.agents()[0]?.admin, undefined);
    });
    test('the confirmation of their actions is off by default, and saved with the other settings', () => {
        const { env, settings } = setUp();
        deepStrictEqual(settings.adminSettings(), { confirmActions: false });
        deepStrictEqual(settings.setAdminSettings({ confirmActions: true }), { confirmActions: true });
        strictEqual(readSettings(env).confirmAdminActions, true);
        throws(() => settings.setAdminSettings({ confirmActions: 'yes' }), ConfigurationError);
        deepStrictEqual(settings.adminSettings(), { confirmActions: true });
    });
});
describe('FleetSettings: removing an agent', () => {
    test('removing stops the agent and moves its directory, memory and all, to .trash', async () => {
        const { root, supervisor, settings, fakes } = setUp(existing);
        await supervisor.start();
        const trash = await settings.remove('codex');
        deepStrictEqual(fakes.get('codex')?.calls, ['start', 'stop']);
        deepStrictEqual(supervisor.agents(), []);
        ok(trash !== undefined && trash.startsWith(join(root, TRASH_DIRECTORY, 'local-codex-')), String(trash));
        ok(existsSync(join(trash, 'system-prompt.md')));
        ok(!existsSync(join(root, 'local', 'codex')));
        strictEqual(loadFleet({ argv: ['--fleet', root] }).agents.length, 0, '.trash is not part of the fleet');
    });
});
describe('FleetSettings: the fleet directory', () => {
    test('switching saves it, stops the old agents and starts the new ones', async () => {
        const { home, env, root, supervisor, settings, fakes, switched } = setUp((fleet) => writeAgent(fleet, 'local', 'old', { command: 'x' }));
        await supervisor.start();
        const next = join(home, 'other');
        writeAgent(next, 'remote', 'eva', { url: 'https://eva.example.org' });
        const info = await settings.switchTo({ path: '~/other' });
        deepStrictEqual(info, { path: next, source: 'settings', pinnedBy: 'argument', settingsFile: join(home, '.flotti', 'settings.json') });
        deepStrictEqual(readSettings(env), { fleet: next });
        deepStrictEqual(switched.map((fleet) => fleet.location.path), [next]);
        deepStrictEqual(fakes.get('old')?.calls, ['start', 'stop']);
        await settled();
        deepStrictEqual(supervisor.agents().map((agent) => [agent.id, agent.status]), [['eva', 'idle']]);
        deepStrictEqual(resolveFleetLocation({ argv: [], env }), { path: next, source: 'settings' }, 'the next run opens it');
        strictEqual(resolveFleetLocation({ argv: ['--fleet', root], env }).source, 'argument', '--fleet still wins');
    });
    test('a directory that is not there yet is created: a new fleet begins empty', async () => {
        const { home, supervisor, settings } = setUp();
        await settings.switchTo({ path: join(home, 'new', 'fleet') });
        ok(existsSync(join(home, 'new', 'fleet')));
        deepStrictEqual(supervisor.agents(), []);
    });
    test('refuses a relative path, and a fleet flotti run would refuse, and changes nothing', async () => {
        const { home, env, root, settings, switched } = setUp();
        await rejects(settings.switchTo({ path: 'fleet' }), (error: unknown) => error instanceof ConfigurationError && error.kind === 'invalid-argument');
        const broken = join(home, 'broken');
        writeAgent(broken, 'local', 'bad', { name: 'no command' });
        await rejects(settings.switchTo({ path: broken }), (error: unknown) => error instanceof ConfigurationError && error.kind === 'missing-field');
        deepStrictEqual(switched, []);
        deepStrictEqual(readSettings(env), {});
        strictEqual(settings.info().path, root);
    });
    test('refuses a fleet another flotti runs', async () => {
        const { home, root, supervisor } = setUp();
        const settings = new FleetSettings(loadFleet({ argv: ['--fleet', root] }), supervisor, {
            env: { HOME: home },
            onSwitch: () => {
                throw new ConfigurationError('already-running', 'flotti already runs this fleet');
            }
        });
        await rejects(settings.switchTo({ path: join(home, 'taken') }), /already runs/);
        strictEqual(settings.info().path, root);
    });
});
describe('FleetSettings: a remote agent in one step, from user@host', () => {
    const EVA: PublishedAgent = { id: 'eva', name: 'Eva', description: 'AI teammate', url: 'http://127.0.0.1:18741/', token: 'never-written' };
    test('adds every agent the host publishes, reached over SSH, and starts it', async () => {
        const asked: SshTarget[] = [];
        const { root, settings, fakes } = setUp(undefined, {
            discover: async (target) => {
                asked.push(target);
                return [EVA, { id: 'cutie', url: 'http://127.0.0.1:18742/' }];
            }
        });
        const answer = await settings.addOverSsh({ target: ' eva@example.org ' });
        deepStrictEqual(asked, [{ destination: 'eva@example.org', host: 'example.org' }]);
        deepStrictEqual(answer.added.map((agent) => [agent.id, agent.name, agent.kind]), [['eva', 'Eva', 'remote'], ['cutie', 'cutie', 'remote']]);
        deepStrictEqual(manifestAt(root, 'remote', 'eva'), {
            name: 'Eva',
            description: 'AI teammate',
            ssh: { target: 'eva@example.org', agent: 'eva' }
        });
        ok(!readFileSync(join(root, 'remote', 'eva', 'agent.json'), 'utf8').includes('never-written'), 'the token stays out of the manifest');
        await settled();
        strictEqual(fakes.get('eva')?.status, 'idle');
    });
    test('skips the agents already in the fleet, and gives a taken id the host name', async () => {
        const { root, settings } = setUp((fleet) => {
            writeAgent(fleet, 'remote', 'eva', { ssh: { target: 'eva@example.org', agent: 'eva' } });
            writeAgent(fleet, 'local', 'cutie', { command: 'cutie' });
        }, { discover: async () => [EVA, { id: 'cutie', url: 'http://127.0.0.1:18742/' }] });
        const answer = await settings.addOverSsh({ target: 'eva@example.org' });
        deepStrictEqual(answer.added.map((agent) => agent.id), ['cutie-example.org']);
        deepStrictEqual(answer.present, ['eva']);
        deepStrictEqual(manifestAt(root, 'remote', 'cutie-example.org')['ssh'], { target: 'eva@example.org', agent: 'cutie' });
        await rejects(settings.addOverSsh({ target: 'eva@example.org' }), (error: unknown) =>
            error instanceof ConfigurationError && error.kind === 'duplicate-agent-id'
            && /Every agent eva@example\.org publishes is in the fleet already: eva, cutie-example\.org/.test(error.message));
    });
    test('says why when the host cannot be asked, or publishes nothing', async () => {
        const refused = setUp(undefined, {
            discover: async () => {
                throw new SshError('eva@example.org did not accept the SSH key');
            }
        });
        await rejects(refused.settings.addOverSsh({ target: 'eva@example.org' }), (error: unknown) =>
            error instanceof ConfigurationError && error.kind === 'ssh-failed' && /did not accept the SSH key\.$/.test(error.message));
        const empty = setUp(undefined, { discover: async () => [] });
        await rejects(empty.settings.addOverSsh({ target: 'eva@example.org' }), /publishes no agent: ~\/\.flotti\/a2a\/ on it has no \.json file/);
        await rejects(empty.settings.addOverSsh({ target: '-oProxyCommand=x' }), /is not an SSH address/);
        await rejects(empty.settings.addOverSsh({}), /target is missing/);
        deepStrictEqual(readdirSync(empty.root), []);
    });
});
