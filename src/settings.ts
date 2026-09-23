import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigurationError } from './errors.js';
/**
 * What flotti remembers about itself between runs, as the dashboard set it:
 * `~/.flotti/settings.json`. Only the fleet directory for now — the command
 * line has nothing but `run` and `stop`, so whatever a flag used to say lives
 * here and is changed on the settings page.
 */
type Settings = {
    /** Absolute path of the fleet directory the dashboard chose. */
    readonly fleet?: string;
};
type Environment = Readonly<Record<string, string | undefined>>;
/** Where the settings live, relative to the home directory. */
const SETTINGS_PATH = ['.flotti', 'settings.json'] as const;
function home(env: Environment): string | undefined {
    const found = env['HOME']?.trim() || env['USERPROFILE']?.trim();
    return found === undefined || found === '' ? undefined : found;
}
/** Absolute path of the settings file; `undefined` when the environment has no home directory. */
function settingsFile(env: Environment): string | undefined {
    const directory = home(env);
    return directory === undefined ? undefined : join(directory, ...SETTINGS_PATH);
}
/**
 * Reads the settings; none at all when there is no file yet.
 *
 * @throws ConfigurationError when the file is there but is not settings.
 */
function readSettings(env: Environment): Settings {
    const path = settingsFile(env);
    if (path === undefined) {
        return {};
    }
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return {};
        }
        throw new ConfigurationError('unreadable-file', `Settings could not be read (${code ?? 'unknown error'}): ${path}`, {
            path,
            cause: error
        });
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new ConfigurationError('not-json', `${path}: the settings are not valid JSON`, { path, cause: error });
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ConfigurationError('wrong-type', `${path}: the settings must be a JSON object`, { path });
    }
    const { fleet } = value as { fleet?: unknown };
    if (fleet === undefined) {
        return {};
    }
    if (typeof fleet !== 'string' || fleet.trim() === '') {
        throw new ConfigurationError('wrong-type', `${path}: fleet must be a non-empty string`, { path });
    }
    return { fleet };
}
/**
 * Saves the settings, keeping whatever else the file holds. Written to a
 * temporary file first and renamed, so a crash never leaves half a file.
 *
 * @returns Path of the settings file.
 */
function writeSettings(env: Environment, settings: Settings): string {
    const path = settingsFile(env);
    if (path === undefined) {
        throw new ConfigurationError(
            'unresolved-home',
            'Cannot save the settings: neither HOME nor USERPROFILE is set in the environment'
        );
    }
    let kept: Record<string, unknown> = {};
    try {
        const current: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
            kept = current as Record<string, unknown>;
        }
    } catch {
        // No file yet, or one we could not read: what we write replaces it.
    }
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...kept, ...settings }, null, 4)}\n`);
    renameSync(temporary, path);
    return path;
}
export { readSettings, settingsFile, writeSettings };
export type { Settings };
