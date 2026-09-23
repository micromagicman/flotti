import { lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalAgent } from './types.js';
/** Environment variable codex-acp reads extra Codex configuration from, as a JSON object. */
const CODEX_CONFIG_VARIABLE = 'CODEX_CONFIG';
/**
 * How an agent gets what its directory holds. ACP has no field for a system
 * prompt or for skills, so each adapter takes them its own way:
 *
 * - claude-agent-acp reads `_meta.systemPrompt` of `session/new` (`{append}`
 *   adds to Claude Code's own prompt instead of replacing it) and passes
 *   `_meta.claudeCode.options` to the Claude Agent SDK — `plugins` loads the
 *   agent directory as a local plugin, which brings its `skills/` along;
 * - codex-acp has no `_meta` for either. It merges the JSON of `CODEX_CONFIG`
 *   into the Codex config — `developer_instructions` is added to Codex's own
 *   prompt — and looks for skills in `.agents/skills` of every workspace root.
 *
 * Both get the agent directory as an extra workspace root, so the agent can
 * read its skills and keep its memory bank. The model is not here: ACP has a
 * standard way for it, the session's `model` config option.
 */
type Handover = {
    /** Variables added to the environment of the adapter process. */
    readonly env: Readonly<Record<string, string>>;
    /** `_meta` of `session/new`, `session/resume` and `session/load`. */
    readonly meta?: Readonly<Record<string, unknown>>;
    /** Extra workspace roots, sent when the agent supports them. */
    readonly additionalDirectories: readonly string[];
    /** What could not be handed over, in words for people. */
    readonly notes: readonly string[];
};
/**
 * Decides how the system prompt and the skills reach the agent, and prepares
 * what has to be on disk for that.
 *
 * @param env Environment the adapter will run with, to merge into what it already holds.
 */
function prepareHandover(agent: LocalAgent, env: Readonly<Record<string, string | undefined>>): Handover {
    const systemPrompt = readSystemPrompt(agent);
    switch (agent.adapter) {
        case 'claude-code':
            return {
                env: {},
                meta: {
                    ...(systemPrompt === undefined ? {} : { systemPrompt: { append: systemPrompt } }),
                    claudeCode: { options: { plugins: [{ type: 'local', path: agent.directory }] } }
                },
                additionalDirectories: [agent.directory],
                notes: []
            };
        case 'codex':
            linkCodexSkills(agent);
            return {
                env: systemPrompt === undefined ? {} : { [CODEX_CONFIG_VARIABLE]: codexConfig(env, systemPrompt) },
                additionalDirectories: [agent.directory],
                notes: []
            };
        default:
            return {
                env: {},
                additionalDirectories: [],
                notes: systemPrompt === undefined
                    ? []
                    : ['system-prompt.md is not passed on: the manifest names no adapter, and ACP itself has no field for it']
            };
    }
}
function readSystemPrompt(agent: LocalAgent): string | undefined {
    if (agent.systemPromptFile === undefined) {
        return undefined;
    }
    const text = readFileSync(agent.systemPromptFile, 'utf8');
    return text.trim() === '' ? undefined : text;
}
/**
 * The Codex configuration with the system prompt in it. A `CODEX_CONFIG` the
 * manifest or the environment already sets is kept; a `developer_instructions`
 * in it wins over the file, because it was written on purpose.
 */
function codexConfig(env: Readonly<Record<string, string | undefined>>, systemPrompt: string): string {
    const given = env[CODEX_CONFIG_VARIABLE];
    let config: Record<string, unknown> = {};
    if (given !== undefined && given.trim() !== '') {
        const parsed: unknown = JSON.parse(given);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error(`${CODEX_CONFIG_VARIABLE} must hold a JSON object`);
        }
        config = parsed as Record<string, unknown>;
    }
    return JSON.stringify({ developer_instructions: systemPrompt, ...config });
}
/**
 * Codex looks for skills in `<root>/.agents/skills`, and the agent keeps them in
 * `<root>/skills`: a link joins the two. A junction on Windows, where it needs
 * no special rights; an ordinary symbolic link elsewhere. Something already
 * there is left alone.
 */
function linkCodexSkills(agent: LocalAgent): void {
    const container = join(agent.directory, '.agents');
    const link = join(container, 'skills');
    try {
        lstatSync(link);
        return;
    } catch {
        // Nothing there yet.
    }
    mkdirSync(container, { recursive: true });
    symlinkSync(agent.skillsDirectory, link, 'junction');
}
export { CODEX_CONFIG_VARIABLE, prepareHandover };
export type { Handover };
