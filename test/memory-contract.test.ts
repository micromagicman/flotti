import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { CODEX_CONFIG_VARIABLE, prepareHandover } from '../src/acp-adapters.js';
import { MEMORY_POLICY, MEMORY_POLICY_VERSION, MEMORY_SKILL_NAME, skillText } from '../src/memory-contract.js';
import type { LocalAgent, LocalAgentAdapter } from '../src/types.js';
const workspace = mkdtempSync(join(tmpdir(), 'flotti-contract-'));
after(() => rmSync(workspace, { recursive: true, force: true }));
let made = 0;
function agentWith(adapter: LocalAgentAdapter | undefined, systemPrompt?: string, extra: Partial<LocalAgent> = {}): LocalAgent {
    const directory = join(workspace, `agent-${++made}`);
    mkdirSync(join(directory, 'skills'), { recursive: true });
    const systemPromptFile = join(directory, 'system-prompt.md');
    if (systemPrompt !== undefined) {
        writeFileSync(systemPromptFile, systemPrompt);
    }
    return {
        kind: 'local',
        id: `agent-${made}`,
        name: `agent-${made}`,
        directory,
        manifestPath: join(directory, 'agent.json'),
        ...(adapter === undefined ? {} : { adapter }),
        command: 'adapter',
        arguments: [],
        workdir: directory,
        env: {},
        restart: 'on-failure',
        heartbeatTimeoutSec: 60,
        skillsDirectory: join(directory, 'skills'),
        memoryDirectory: join(directory, 'memory'),
        ...(systemPrompt === undefined ? {} : { systemPromptFile }),
        ...extra
    };
}
function appended(agent: LocalAgent): string {
    const meta = prepareHandover(agent, {}, true).meta as { systemPrompt?: { append?: string } };
    return meta.systemPrompt?.append ?? '';
}
function developerInstructions(agent: LocalAgent, env: Record<string, string> = {}): string {
    const config = JSON.parse(prepareHandover(agent, env, true).env[CODEX_CONFIG_VARIABLE] ?? '{}') as { developer_instructions?: string };
    return config.developer_instructions ?? '';
}
function skillFile(agent: LocalAgent): string {
    return join(agent.skillsDirectory, MEMORY_SKILL_NAME, 'SKILL.md');
}
function count(text: string, piece: string): number {
    return text.split(piece).length - 1;
}
describe('memory contract (#101): the policy and the skill on connect', () => {
    it('Claude Code gets the policy after its own system prompt, which is kept and never written', () => {
        const agent = agentWith('claude-code', 'You are the release manager.\n');
        const append = appended(agent);
        ok(append.startsWith('You are the release manager.'), 'the agent\'s own prompt comes first');
        ok(append.endsWith(MEMORY_POLICY));
        match(append, new RegExp(`policy v${MEMORY_POLICY_VERSION}`));
        strictEqual(readFileSync(agent.systemPromptFile ?? '', 'utf8'), 'You are the release manager.\n');
        strictEqual(count(appended(agent), MEMORY_POLICY), 1, 'a second start does not pile the policy up');
        strictEqual(appended(agentWith('claude-code')), MEMORY_POLICY, 'an agent without a system prompt gets the policy alone');
    });
    it('Codex gets the policy in developer_instructions, after the system prompt or the instructions given on purpose', () => {
        const agent = agentWith('codex', 'Be brief.');
        const instructions = developerInstructions(agent);
        ok(instructions.startsWith('Be brief.'));
        ok(instructions.endsWith(MEMORY_POLICY));
        const given = developerInstructions(agent, { [CODEX_CONFIG_VARIABLE]: JSON.stringify({ developer_instructions: 'Given.', model: 'o3' }) });
        ok(given.startsWith('Given.') && given.endsWith(MEMORY_POLICY));
        const config = JSON.parse(prepareHandover(agent, { [CODEX_CONFIG_VARIABLE]: '{"model":"o3"}' }, true).env[CODEX_CONFIG_VARIABLE] ?? '') as Record<string, unknown>;
        strictEqual(config['model'], 'o3', 'the rest of the given configuration is kept');
        strictEqual(developerInstructions(agentWith('codex')), MEMORY_POLICY);
    });
});
describe('memory contract (#101): only with the tools', () => {
    it('without the memory tools nothing of the contract goes, as before', () => {
        const agent = agentWith('claude-code', 'Own.');
        const handover = prepareHandover(agent, {});
        deepStrictEqual((handover.meta as { systemPrompt?: unknown }).systemPrompt, { append: 'Own.' });
        strictEqual(handover.memory, undefined);
        strictEqual(existsSync(skillFile(agent)), false);
    });
});
describe('memory contract (#101): the built-in skill', () => {
    it('the built-in skill goes among the skills of the agent, where both adapters look for them', () => {
        for (const adapter of ['claude-code', 'codex'] as const) {
            const agent = agentWith(adapter);
            const handover = prepareHandover(agent, {}, true);
            deepStrictEqual(handover.memory, { policy: MEMORY_POLICY_VERSION, skill: 'builtin' });
            strictEqual(readFileSync(skillFile(agent), 'utf8'), skillText());
            match(skillText(), new RegExp(`^---\\nname: ${MEMORY_SKILL_NAME}\\ndescription: `));
            if (adapter === 'codex') {
                ok(existsSync(join(agent.directory, '.agents', 'skills', MEMORY_SKILL_NAME, 'SKILL.md')), 'Codex finds it through .agents/skills');
            } else {
                deepStrictEqual((handover.meta as { claudeCode: unknown }).claudeCode, { options: { plugins: [{ type: 'local', path: agent.directory }] } });
            }
        }
    });
    it('installing again is idempotent, and an older built-in version is brought up to date', () => {
        const agent = agentWith('claude-code');
        prepareHandover(agent, {}, true);
        prepareHandover(agent, {}, true);
        strictEqual(readFileSync(skillFile(agent), 'utf8'), skillText());
        const older = skillText().replace(/v\d+ sha256:/, 'v0 sha256:');
        writeFileSync(skillFile(agent), older);
        strictEqual(prepareHandover(agent, {}, true).memory?.skill, 'builtin');
        strictEqual(readFileSync(skillFile(agent), 'utf8'), skillText());
    });
    it('a skill of the agent\'s own of the same name is never overwritten, and the status says it is not flotti\'s', () => {
        const own = agentWith('claude-code');
        mkdirSync(join(own.skillsDirectory, MEMORY_SKILL_NAME));
        writeFileSync(skillFile(own), '---\nname: flotti-memory\ndescription: mine\n---\nMy own rules.\n');
        const handover = prepareHandover(own, {}, true);
        strictEqual(handover.memory?.skill, 'user');
        strictEqual(readFileSync(skillFile(own), 'utf8'), '---\nname: flotti-memory\ndescription: mine\n---\nMy own rules.\n');
        ok(appended(own).endsWith(MEMORY_POLICY), 'the short rule still arrives');
        ok(handover.notes.some((note) => /agent's own/.test(note)));
        const edited = agentWith('codex');
        prepareHandover(edited, {}, true);
        const changed = readFileSync(skillFile(edited), 'utf8').replace('# flotti memory', '# flotti memory, my way');
        writeFileSync(skillFile(edited), changed);
        strictEqual(prepareHandover(edited, {}, true).memory?.skill, 'user', 'a built-in skill a person edited is theirs from then on');
        strictEqual(readFileSync(skillFile(edited), 'utf8'), changed);
    });
});
describe('memory contract (#101): where it does not go', () => {
    it('an agent on another host or without an adapter gets no contract', () => {
        strictEqual(prepareHandover(agentWith('claude-code', undefined, { ssh: 'eva@example.org', workdir: '~' }), {}, true).memory, undefined);
        strictEqual(prepareHandover(agentWith(undefined), {}, true).memory, undefined);
    });
    it('a bank that cannot be used is said so', () => {
        const agent = agentWith('claude-code');
        writeFileSync(agent.memoryDirectory, 'not a folder');
        match(prepareHandover(agent, {}, true).memory?.unavailable ?? '', /is not a folder/);
    });
});
