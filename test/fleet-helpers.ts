import { ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { ConfigurationError } from '../src/errors.js';
import { loadFleet } from '../src/fleet.js';
import type { LoadFleetOptions } from '../src/fleet.js';
import type { Fleet } from '../src/types.js';
const HOME = '/home/eva';
const workspace = mkdtempSync(join(tmpdir(), 'flotti-fleet-'));
after(() => rmSync(workspace, { recursive: true, force: true }));
let made = 0;
/** A fresh, empty fleet directory. */
function fleetDirectory(): string {
    const path = join(workspace, `fleet-${++made}`);
    mkdirSync(path);
    return path;
}
/** Writes an agent directory with the manifest given as text or as an object. */
function agent(root: string, group: 'local' | 'remote', id: string, manifest: string | object): string {
    const directory = join(root, group, id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, 'agent.json'),
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 4)
    );
    return directory;
}
function load(root: string, options: LoadFleetOptions = {}): Fleet {
    return loadFleet({ env: { HOME }, ...options, argv: ['--fleet', root] });
}
function failure(options: LoadFleetOptions): ConfigurationError {
    try {
        loadFleet(options);
    } catch (error) {
        ok(error instanceof ConfigurationError, `expected a ConfigurationError, got ${String(error)}`);
        return error;
    }
    throw new Error('expected loadFleet() to fail, but it succeeded');
}
/** Loads a fleet with a single agent and returns the complaint about it. */
function rejected(group: 'local' | 'remote', manifest: string | object): ConfigurationError {
    const root = fleetDirectory();
    agent(root, group, 'agent', manifest);
    return failure({ env: { HOME }, argv: ['--fleet', root] });
}
/** Loads a fleet with a single agent and returns it. */
function single(group: 'local' | 'remote', manifest: string | object) {
    const root = fleetDirectory();
    const directory = agent(root, group, 'agent', manifest);
    const [only] = load(root).agents;
    ok(only !== undefined, 'expected one agent');
    return { agent: only, directory };
}
const LOCAL = { command: 'claude-code-acp' };
const REMOTE = { url: 'https://eva.example.org/a2a' };
export { HOME, LOCAL, REMOTE, agent, failure, fleetDirectory, load, rejected, single, workspace };
