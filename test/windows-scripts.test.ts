import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FAKE_AGENT, Harness, eventually, isAlive, workspace } from './local-agent-helpers.js';
/**
 * The agent started through an npm-style `.cmd` script, the way `npx` and `codex` are installed
 * on Windows. Real processes and a real `cmd.exe`, so only on Windows; the lookup itself is
 * tested on every platform in command-line.test.ts.
 */
const skip = process.platform !== 'win32' && 'Windows only: needs cmd.exe';
/** Arguments that `cmd.exe` would break if they were passed on unescaped. */
const TRICKY = ['plain', 'with space', 'say "hi"', 'a"&calc', '100%', '%PATH%', 'x^y', 'a|b', '<in>', '(p)', 'end\\', 'c:\\dir with space\\', ''];
let scripts = 0;
/** A directory with `<name>.cmd` that runs the pretend agent the way npm's cmd-shim does. */
function scriptDirectory(name: string): string {
    const directory = join(workspace, `scripts-${++scripts}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.cmd`), `@ECHO off\r\n"${process.execPath}" "${FAKE_AGENT}" %*\r\n`);
    // What npm puts next to it for Git Bash; Windows cannot start it, the lookup must pass it by.
    writeFileSync(join(directory, name), '#!/bin/sh\nexit 1\n');
    return directory;
}
/** The manifest of an agent whose command is `name`, found through `PATH`. */
function onPath(name: string, directory: string, args: string[]) {
    const key = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === 'PATH') ?? 'PATH';
    return { command: name, arguments: args, env: { [key]: `${directory};${process.env[key] ?? ''}` } };
}
describe('LocalAgentProcess on Windows: commands that are .cmd scripts', { skip, timeout: 30_000 }, () => {
    it('finds the script through PATH and PATHEXT, and the arguments reach the agent unchanged', async () => {
        const harness = new Harness({ manifest: onPath('flotti-shim', scriptDirectory('flotti-shim'), TRICKY) });
        await harness.agent.start();
        const [started] = harness.recorded('started');
        deepStrictEqual(started?.['argv'], TRICKY);
        strictEqual(await harness.talk('hello'), 'end_turn');
    });
    it('stops the whole tree, cmd.exe included', async () => {
        const harness = new Harness({ manifest: onPath('flotti-shim', scriptDirectory('flotti-shim'), []) });
        await harness.agent.start();
        await harness.talk('spawn');
        const [grandchild] = harness.recorded('grandchild');
        const [agent] = harness.recorded('started');
        // The parent of the agent is the cmd.exe flotti started.
        const pids = [agent?.['ppid'], agent?.['pid'], grandchild?.['pid']] as number[];
        await eventually(() => pids.every(isAlive));
        await harness.agent.stop();
        await eventually(() => !pids.some(isAlive), 10_000);
    });
    it('still says command not found for a command that is nowhere', async () => {
        const harness = new Harness({ manifest: onPath('flotti-no-such-command', scriptDirectory('flotti-shim'), []) });
        await rejects(harness.agent.start(), /command not found: flotti-no-such-command/);
    });
});
