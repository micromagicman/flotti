import { statSync } from 'node:fs';
import { win32 } from 'node:path';
/**
 * Turning the `command` of a manifest into what `spawn` can start.
 *
 * On POSIX nothing is done: `spawn` finds the command in `PATH` itself. On Windows it does not
 * find `npx` or `codex`: npm installs them as `.cmd` scripts, `spawn` without a shell tries only
 * `.com` and `.exe`, and Node refuses to start a `.cmd` or `.bat` without a shell anyway
 * (`EINVAL`, since CVE-2024-27980). So on Windows flotti looks the command up the way the shell
 * does — in the working directory, then in `PATH`, with the extensions of `PATHEXT` — and starts a
 * script it found through `cmd.exe /d /s /c`, every argument quoted and escaped for `cmd.exe`.
 * An `.exe` is started directly. A command that is found nowhere is passed on as it is, so that
 * `spawn` fails with `ENOENT` and the agent says `command not found`.
 */
/** What to hand `spawn`. */
type Spawnable = {
    readonly command: string;
    readonly arguments: string[];
    /** Set for `cmd.exe`: the command line is quoted here, Node must not quote it again. */
    readonly windowsVerbatimArguments?: boolean;
};
/** Where the command is looked up; tests pass a pretend file system and platform. */
type Lookup = {
    readonly env: NodeJS.ProcessEnv;
    /** The working directory of the process; the current one when absent. */
    readonly cwd?: string;
    readonly platform?: NodeJS.Platform;
    readonly isFile?: (path: string) => boolean;
};
/** What `PATHEXT` is when the environment has none, as in `cmd.exe`. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
/** Scripts `cmd.exe` runs; everything else is started directly. */
const SCRIPT = /\.(?:cmd|bat)$/i;
/** Characters `cmd.exe` treats specially outside quotes; escaped with `^`. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function commandToSpawn(command: string, args: readonly string[], lookup: Lookup): Spawnable {
    const found = windowsCommand(command, lookup);
    if (found === undefined) {
        return { command, arguments: [...args] };
    }
    return SCRIPT.test(found) ? scriptToSpawn(found, args, lookup.env) : { command: found, arguments: [...args] };
}
/** The file of `command` on Windows; nothing anywhere else, or when there is none. */
function windowsCommand(command: string, lookup: Lookup): string | undefined {
    return (lookup.platform ?? process.platform) === 'win32' ? findCommand(command, lookup) : undefined;
}
/** A script `found` is started through `cmd.exe`. */
function scriptToSpawn(found: string, args: readonly string[], env: NodeJS.ProcessEnv): Spawnable {
    const line = [`"${found}"`, ...args.map(quoteForCmd)].join(' ');
    return {
        command: variable(env, 'ComSpec') ?? 'cmd.exe',
        arguments: ['/d', '/s', '/c', `"${line}"`],
        windowsVerbatimArguments: true
    };
}
/**
 * The file `cmd.exe` would run for `command`, or nothing: a path is taken as it is, a bare name
 * is looked for in the working directory and then in every directory of `PATH`. A name without
 * an extension gets each extension of `PATHEXT` in turn — never tried bare, since npm puts a
 * POSIX shell script by that name next to the `.cmd`.
 */
function findCommand(command: string, lookup: Lookup): string | undefined {
    const isFile = lookup.isFile ?? isRegularFile;
    for (const candidate of candidates(command, lookup)) {
        if (isFile(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
/** Every file `command` may be, in the order `cmd.exe` tries them. */
function candidates(command: string, lookup: Lookup): string[] {
    const names = commandNames(command, lookup.env);
    return commandDirectories(command, lookup).flatMap((directory) => names.map((name) => win32.resolve(directory, name)));
}
function commandNames(command: string, env: NodeJS.ProcessEnv): string[] {
    const extensions = (variable(env, 'PATHEXT') ?? DEFAULT_PATHEXT).split(';').filter(Boolean);
    const named = extensions.map((extension) => command + extension.toLowerCase());
    return win32.extname(command) === '' ? named : [command, ...named];
}
function commandDirectories(command: string, lookup: Lookup): string[] {
    const cwd = lookup.cwd ?? process.cwd();
    return /[\\/]/.test(command) ? [cwd] : [cwd, ...pathDirectories(lookup.env)];
}
function pathDirectories(env: NodeJS.ProcessEnv): string[] {
    return (variable(env, 'PATH') ?? '').split(';')
        .map((directory) => directory.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean);
}
/**
 * One argument on the command line of a script: quoted the way the C runtime of the program at
 * the end reads it back (backslashes before a quote doubled, the quote escaped), then every
 * special character escaped for `cmd.exe` — twice, because `cmd.exe` reads the line once, and
 * the script, passing `%*` on, has it read once more.
 */
function quoteForCmd(argument: string): string {
    const quoted = `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
    return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}
/** A variable of a Windows environment, whose names are case-insensitive: the last spelling wins. */
function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
    const key = Object.keys(env).filter((candidate) => candidate.toUpperCase() === name.toUpperCase()).at(-1);
    return key === undefined ? undefined : env[key];
}
function isRegularFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}
export { commandToSpawn, findCommand, quoteForCmd };
export type { Lookup, Spawnable };
