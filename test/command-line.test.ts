import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commandToSpawn, findCommand, quoteForCmd } from '../src/command-line.js';
import type { Lookup } from '../src/command-line.js';
/** A pretend Windows machine: these files exist, nothing else; paths compared case-insensitively. */
function windows(files: readonly string[], env: NodeJS.ProcessEnv, cwd = 'C:\\work'): Lookup {
    const existing = new Set(files.map((file) => file.toLowerCase()));
    return { platform: 'win32', env, cwd, isFile: (path) => existing.has(path.toLowerCase()) };
}
const NODE_DIRECTORY = 'C:\\Program Files\\nodejs';
const NPM_GLOBAL = 'C:\\Users\\someone\\AppData\\Roaming\\npm';
/** What npm installs for `npx`: a POSIX script, a `.cmd` and a `.ps1`, side by side. */
const NPX = ['npx', 'npx.cmd', 'npx.ps1'].map((file) => `${NODE_DIRECTORY}\\${file}`);
const ENV = { Path: `${NPM_GLOBAL};${NODE_DIRECTORY}`, PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
/** Arguments `cmd.exe` would break if they were passed on unescaped. */
const TRICKY = ['plain', 'with space', 'say "hi"', 'a"&calc', '100%', '%PATH%', 'x^y', 'a|b', '<in>', '(p)', 'end\\', 'c:\\dir with space\\', ''];
/**
 * One reading of a line by `cmd.exe`: carets outside quotes escape the next character and go
 * away, quotes switch the quoted mode. A character that would split or redirect the command,
 * or a `%NAME%` that would be expanded, fails the test.
 */
function cmdReads(line: string, expandsPercent: boolean): string {
    ok(!expandsPercent || !/%[^%^\s]+%/.test(line), `cmd.exe would expand a variable in ${line}`);
    let quoted = false;
    let out = '';
    for (let i = 0; i < line.length; i++) {
        const c = line[i] ?? '';
        if (c === '"') {
            quoted = !quoted;
            out += c;
        } else if (!quoted && c === '^') {
            out += line[++i] ?? '';
        } else {
            ok(quoted || !'&|<>'.includes(c), `bare ${c} in ${line}`);
            out += c;
        }
    }
    return out;
}
/** Backslashes at `start` and what they mean: before a quote they are halved, an odd one escapes it. */
function backslashes(line: string, start: number): { text: string; next: number } {
    let end = start;
    while (line[end] === '\\') {
        end++;
    }
    const count = end - start;
    if (line[end] !== '"') {
        return { text: '\\'.repeat(count), next: end };
    }
    const odd = count % 2 === 1;
    return { text: '\\'.repeat(Math.floor(count / 2)) + (odd ? '"' : ''), next: odd ? end + 1 : end };
}
/** The arguments a program built with the Microsoft C runtime reads from its command line. */
function crtArguments(line: string): string[] {
    const args: string[] = [];
    let i = 0;
    while (i < line.length) {
        while (line[i] === ' ') {
            i++;
        }
        if (i >= line.length) {
            break;
        }
        let current = '';
        let quoted = false;
        while (i < line.length && (quoted || line[i] !== ' ')) {
            if (line[i] === '\\') {
                const read = backslashes(line, i);
                current += read.text;
                i = read.next;
            } else {
                quoted = line[i] === '"' ? !quoted : quoted;
                current += line[i] === '"' ? '' : line[i];
                i++;
            }
        }
        args.push(current);
    }
    return args;
}
describe('commandToSpawn', () => {
    it('leaves the command to spawn on POSIX', () => {
        deepStrictEqual(commandToSpawn('npx', ['-y', 'a b'], { platform: 'linux', env: {} }), { command: 'npx', arguments: ['-y', 'a b'] });
    });
    it('runs an npm .cmd script through cmd.exe, found in PATH, never the POSIX script beside it', () => {
        const spawnable = commandToSpawn('npx', ['-y', '@agentclientprotocol/codex-acp@1.13.1'], windows(NPX, ENV));
        strictEqual(spawnable.command, 'C:\\Windows\\system32\\cmd.exe');
        strictEqual(spawnable.windowsVerbatimArguments, true);
        deepStrictEqual(spawnable.arguments.slice(0, 3), ['/d', '/s', '/c']);
        ok(spawnable.arguments[3]?.startsWith(`""${NODE_DIRECTORY}\\npx.cmd" `), spawnable.arguments[3]);
    });
    it('starts an .exe directly, with the arguments as they are', () => {
        const spawnable = commandToSpawn('codex', ['a b'], windows([`${NPM_GLOBAL}\\codex.exe`, `${NPM_GLOBAL}\\codex.cmd`], ENV));
        deepStrictEqual(spawnable, { command: `${NPM_GLOBAL}\\codex.exe`, arguments: ['a b'] });
    });
    it('passes a command found nowhere on unchanged, so that spawn says it is not there', () => {
        const spawnable = commandToSpawn('flotti-no-such-command', ['x'], windows(NPX, ENV));
        deepStrictEqual(spawnable, { command: 'flotti-no-such-command', arguments: ['x'] });
    });
    it('takes cmd.exe when the environment names no ComSpec', () => {
        strictEqual(commandToSpawn('npx', [], windows(NPX, { PATH: NODE_DIRECTORY })).command, 'cmd.exe');
    });
    it('passes every argument to the program behind the script unchanged', () => {
        const line = commandToSpawn('npx', TRICKY, windows(NPX, ENV)).arguments[3] ?? '';
        // `/s` takes the outer quotes off; the script is the first word, quoted.
        const inner = line.slice(1, -1);
        const afterScript = inner.slice(inner.indexOf('" ') + 2);
        // cmd.exe reads the line, then the script reads again what %* gives it.
        deepStrictEqual(crtArguments(cmdReads(cmdReads(afterScript, true), false)), TRICKY);
    });
});
describe('findCommand', () => {
    it('tries the extensions in the order of PATHEXT within a directory, and the directories in the order of PATH', () => {
        const lookup = windows([`${NPM_GLOBAL}\\tool.cmd`, `${NODE_DIRECTORY}\\tool.exe`, `${NODE_DIRECTORY}\\tool.com`], ENV);
        strictEqual(findCommand('tool', lookup), `${NPM_GLOBAL}\\tool.cmd`);
        strictEqual(findCommand('tool', windows([`${NODE_DIRECTORY}\\tool.cmd`, `${NODE_DIRECTORY}\\tool.exe`], ENV)), `${NODE_DIRECTORY}\\tool.exe`);
    });
    it('uses only the extensions PATHEXT names, and those of cmd.exe without it', () => {
        strictEqual(findCommand('tool', windows([`${NODE_DIRECTORY}\\tool.cmd`], { PATH: NODE_DIRECTORY, PATHEXT: '.EXE' })), undefined);
        strictEqual(findCommand('tool', windows([`${NODE_DIRECTORY}\\tool.bat`], { PATH: NODE_DIRECTORY })), `${NODE_DIRECTORY}\\tool.bat`);
    });
    it('reads variable names in any case, the last spelling winning', () => {
        const lookup = windows(['D:\\second\\tool.cmd', 'D:\\first\\tool.cmd'], { Path: 'D:\\first', PATH: 'D:\\second', pathext: '.CMD' });
        strictEqual(findCommand('tool', lookup), 'D:\\second\\tool.cmd');
    });
    it('looks in the working directory before PATH, and takes a name with its own extension as it is', () => {
        strictEqual(findCommand('npx', windows([...NPX, 'C:\\work\\npx.cmd'], ENV)), 'C:\\work\\npx.cmd');
        strictEqual(findCommand('npx.cmd', windows(NPX, ENV)), `${NODE_DIRECTORY}\\npx.cmd`);
    });
    it('takes a path relative to the working directory, not to PATH', () => {
        const lookup = windows(['C:\\work\\bin\\agent.cmd', `${NODE_DIRECTORY}\\bin\\agent.cmd`], ENV);
        strictEqual(findCommand('bin\\agent', lookup), 'C:\\work\\bin\\agent.cmd');
    });
    it('reads quoted directories and skips empty ones in PATH', () => {
        strictEqual(findCommand('tool', windows(['C:\\with space\\tool.exe'], { PATH: ';"C:\\with space";' })), 'C:\\with space\\tool.exe');
    });
});
describe('quoteForCmd', () => {
    it('quotes an argument and escapes it twice for cmd.exe', () => {
        strictEqual(quoteForCmd('a b'), '^^^"a^^^ b^^^"');
    });
});
