import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigurationError } from './errors.js';
/**
 * What flotti remembers about itself between runs, as the dashboard set it:
 * `~/.flotti/settings.json`. The fleet directory lives here, and — under
 * `notifications`, read by notifications.ts — how to reach a person outside
 * the browser. The command line has nothing but `run` and `stop`, so whatever
 * a flag used to say lives here and is changed on the settings page.
 *
 * The file may hold secrets (a bot token), so it is written for its owner only.
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
    const text = settingsText(path);
    if (text === undefined) {
        return {};
    }
    return parseSettings(text, path);
}
/**
 * One top-level field of the settings file, as it is there; `undefined` when
 * there is no file or no such field.
 *
 * @throws ConfigurationError when the file is there but is not a JSON object.
 */
function readSettingsField(env: Environment, name: string): unknown {
    const path = settingsFile(env);
    const text = path === undefined ? undefined : settingsText(path);
    return text === undefined || path === undefined ? undefined : (settingsObject(text, path) as Record<string, unknown>)[name];
}
/**
 * Text of the settings file; `undefined` when there is no file yet.
 *
 * @throws ConfigurationError when the file is there but cannot be read.
 */
function settingsText(path: string): string | undefined {
    try {
        return readFileSync(path, 'utf8');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return undefined;
        }
        throw new ConfigurationError('unreadable-file', `Settings could not be read (${code ?? 'unknown error'}): ${path}`, {
            path,
            cause: error
        });
    }
}
/**
 * Settings out of the text of the settings file.
 *
 * @throws ConfigurationError when the text is not settings.
 */
function parseSettings(text: string, path: string): Settings {
    const value = settingsObject(text, path);
    const { fleet } = value as { fleet?: unknown };
    if (fleet === undefined) {
        return {};
    }
    if (typeof fleet !== 'string' || fleet.trim() === '') {
        throw new ConfigurationError('wrong-type', `${path}: fleet must be a non-empty string`, { path });
    }
    return { fleet };
}
/** @throws ConfigurationError when the text is not a JSON object. */
function settingsObject(text: string, path: string): object {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new ConfigurationError('not-json', `${path}: the settings are not valid JSON`, { path, cause: error });
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ConfigurationError('wrong-type', `${path}: the settings must be a JSON object`, { path });
    }
    return value;
}
/**
 * Saves the settings, keeping whatever else the file holds. Written to a
 * temporary file first and renamed, so a crash never leaves half a file.
 *
 * @returns Path of the settings file.
 */
function writeSettings(env: Environment, settings: Settings | Readonly<Record<string, unknown>>): string {
    const path = settingsFile(env);
    if (path === undefined) {
        throw new ConfigurationError(
            'unresolved-home',
            'Cannot save the settings: neither HOME nor USERPROFILE is set in the environment'
        );
    }
    const kept = keptSettings(path);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...kept, ...settings }, null, 4)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return path;
}
/** Whatever the settings file already holds; nothing when it is missing or not a JSON object. */
function keptSettings(path: string): Record<string, unknown> {
    let kept: Record<string, unknown> = {};
    try {
        const current: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
            kept = current as Record<string, unknown>;
        }
    } catch {
        // No file yet, or one we could not read: what we write replaces it.
    }
    return kept;
}
export { readSettings, readSettingsField, settingsFile, writeSettings };
export type { Settings };
