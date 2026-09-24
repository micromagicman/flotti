import { lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_POLICY_VERSION, bankProblem, installMemorySkill, withPolicy } from './memory-contract.js';
import type { SkillState } from './memory-contract.js';
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
 *
 * The memory contract (#101) rides the same channels: the policy after the
 * system prompt, the built-in skill among the agent's skills. Every start
 * composes them anew — nothing piles up, and system-prompt.md is never written.
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
    /** What of the memory contract went out; absent when none did. */
    readonly memory?: MemoryHandover;
};
/** The memory contract as handed over: the version of the policy, where the skill stands, and a bank that cannot be used. */
type MemoryHandover = {
    readonly policy: number;
    readonly skill: SkillState;
    /** Why the bank cannot be read and written; absent when it can. */
    readonly unavailable?: string;
};
/**
 * Decides how the system prompt and the skills reach the agent, and prepares
 * what has to be on disk for that.
 *
 * @param env Environment the adapter will run with, to merge into what it already holds.
 */
/**
 * @param memory Whether the memory contract goes too: the agent gets the
 *   memory tools. Only an agent on this machine with an adapter takes it.
 */
function prepareHandover(agent: LocalAgent, env: Readonly<Record<string, string | undefined>>, memory = false): Handover {
    const systemPrompt = readSystemPrompt(agent);
    if (agent.ssh !== undefined) {
        return remoteHandover(agent, env, systemPrompt);
    }
    switch (agent.adapter) {
        case 'claude-code': {
            const contract = memory ? memoryContract(agent) : undefined;
            return withMemory(localClaudeCodeHandover(agent, contract === undefined ? systemPrompt : withPolicy(systemPrompt)), contract);
        }
        case 'codex': {
            linkCodexSkills(agent);
            const contract = memory ? memoryContract(agent) : undefined;
            return withMemory(codexHandover(env, systemPrompt, [agent.directory], [], contract !== undefined), contract);
        }
        default:
            return noAdapterHandover(systemPrompt);
    }
}
/** Installs the built-in skill and looks at the bank; the policy itself goes with the instructions. */
function memoryContract(agent: LocalAgent): MemoryHandover {
    const unavailable = bankProblem(agent.memoryDirectory);
    return {
        policy: MEMORY_POLICY_VERSION,
        skill: installMemorySkill(agent.skillsDirectory),
        ...(unavailable === undefined ? {} : { unavailable })
    };
}
function withMemory(handover: Handover, memory: MemoryHandover | undefined): Handover {
    if (memory === undefined) {
        return handover;
    }
    const notes = memory.skill === 'user'
        ? ['skills/flotti-memory is the agent\'s own: the built-in memory skill is not installed over it']
        : memory.skill === 'missing' ? ['the built-in memory skill could not be written to skills/flotti-memory'] : [];
    return { ...handover, memory, notes: [...handover.notes, ...notes] };
}
/** Claude Code on this machine: the system prompt in `_meta`, the agent directory as a local plugin. */
function localClaudeCodeHandover(agent: LocalAgent, systemPrompt: string | undefined): Handover {
    return {
        env: {},
        meta: {
            ...(systemPrompt === undefined ? {} : { systemPrompt: { append: systemPrompt } }),
            claudeCode: { options: { plugins: [{ type: 'local', path: agent.directory }] } }
        },
        additionalDirectories: [agent.directory],
        notes: []
    };
}
/**
 * Codex, here or on another host: the system prompt goes in `CODEX_CONFIG`,
 * and the memory policy after it when `policy` is set.
 */
function codexHandover(
    env: Readonly<Record<string, string | undefined>>,
    systemPrompt: string | undefined,
    additionalDirectories: readonly string[],
    notes: readonly string[],
    policy = false
): Handover {
    return {
        env: systemPrompt === undefined && !policy ? {} : { [CODEX_CONFIG_VARIABLE]: codexConfig(env, systemPrompt, policy) },
        additionalDirectories,
        notes
    };
}
/** An agent on this machine whose manifest names no adapter: nothing can be handed over. */
function noAdapterHandover(systemPrompt: string | undefined): Handover {
    return {
        env: {},
        additionalDirectories: [],
        notes: systemPrompt === undefined
            ? []
            : ['system-prompt.md is not passed on: the manifest names no adapter, and ACP itself has no field for it']
    };
}
/**
 * An agent started on another host gets the system prompt — it goes as text —
 * but not the agent directory: that is on this machine, and the agent works
 * with the files of its host.
 */
function remoteHandover(
    agent: LocalAgent,
    env: Readonly<Record<string, string | undefined>>,
    systemPrompt: string | undefined
): Handover {
    const notes = agent.adapter === undefined && systemPrompt !== undefined
        ? ['system-prompt.md is not passed on: the manifest names no adapter, and ACP itself has no field for it']
        : [];
    const skipped = `skills/ and memory/ stay on this machine: the agent runs on ${agent.ssh}`;
    switch (agent.adapter) {
        case 'claude-code':
            return remoteClaudeCodeHandover(systemPrompt, skipped);
        case 'codex':
            return codexHandover(env, systemPrompt, [], [skipped]);
        default:
            return { env: {}, additionalDirectories: [], notes };
    }
}
/** Claude Code on another host: the system prompt in `_meta`, nothing from the agent directory. */
function remoteClaudeCodeHandover(systemPrompt: string | undefined, skipped: string): Handover {
    return {
        env: {},
        ...(systemPrompt === undefined ? {} : { meta: { systemPrompt: { append: systemPrompt } } }),
        additionalDirectories: [],
        notes: [skipped]
    };
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
 * in it wins over the file, because it was written on purpose. The memory
 * policy goes after whichever instructions win.
 */
function codexConfig(env: Readonly<Record<string, string | undefined>>, systemPrompt: string | undefined, policy: boolean): string {
    const given = env[CODEX_CONFIG_VARIABLE];
    let config: Record<string, unknown> = {};
    if (given !== undefined && given.trim() !== '') {
        const parsed: unknown = JSON.parse(given);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error(`${CODEX_CONFIG_VARIABLE} must hold a JSON object`);
        }
        config = parsed as Record<string, unknown>;
    }
    if (!policy) {
        return JSON.stringify({ developer_instructions: systemPrompt, ...config });
    }
    const written = config['developer_instructions'];
    return JSON.stringify({ ...config, developer_instructions: withPolicy(typeof written === 'string' ? written : systemPrompt) });
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
export type { Handover, MemoryHandover };
