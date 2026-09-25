/**
 * The behavioural smoke of agent memory (#101), on a live agent — kept apart
 * from the unit tests: it needs a real Claude Code or Codex that is logged in,
 * costs tokens, and its verdict reads what a model says.
 *
 *     npm run smoke:memory -- claude-code   # or: codex
 *
 * One agent in a fleet of its own, in a temporary directory, with the fleet
 * tools as `flotti run` gives them. It is asked to remember a made-up fact;
 * then, in a new session and after a restart that resumes the session, it is
 * asked about the fact with no hint. Asked to forget, it no longer knows it.
 * Last, with a bank that cannot be written, it must not say it remembered.
 *
 * The permission requests of the memory tools are allowed; any other is refused.
 * Every answer is printed: the checks are plain, and a person reads the rest.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '../../src/agent-events.js';
import { FleetMcpServer } from '../../src/fleet-mcp.js';
import { Supervisor } from '../../src/supervisor.js';
import type { Fleet, LocalAgent, LocalAgentAdapter } from '../../src/types.js';
const COMMANDS: Record<LocalAgentAdapter, readonly string[]> = {
    'claude-code': ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.81.1'],
    codex: ['npx', '-y', '@agentclientprotocol/codex-acp@1.13.1']
};
/** A fact no model knows by itself. */
const FACT = 'the codename of project Kestrel-42 is "Violet Lantern"';
const QUESTION = 'What is the codename of project Kestrel-42? If you do not know, say "I do not know".';
const TOKEN = /violet lantern/i;
type Step = { readonly name: string; readonly ok: boolean; readonly answer: string };
const adapter = (process.argv[2] ?? 'claude-code') as LocalAgentAdapter;
if (!(adapter in COMMANDS)) {
    throw new Error(`no adapter ${adapter}: claude-code or codex`);
}
const root = mkdtempSync(join(tmpdir(), 'flotti-memory-smoke-'));
const directory = join(root, 'local', 'keeper');
const [command = 'npx', ...args] = COMMANDS[adapter];
const agent: LocalAgent = {
    kind: 'local',
    id: 'keeper',
    name: 'keeper',
    directory,
    manifestPath: join(directory, 'agent.json'),
    adapter,
    command,
    arguments: args,
    workdir: directory,
    env: {},
    restart: 'never',
    heartbeatTimeoutSec: 600,
    skillsDirectory: join(directory, 'skills'),
    memoryDirectory: join(directory, 'memory')
};
const fleet = { location: { directory: root, source: 'flag' }, exists: true, agents: [agent] } as unknown as Fleet;
const tools = await FleetMcpServer.start();
const supervisor = new Supervisor(fleet, { fleetTools: tools });
tools.serve(supervisor);
const events: AgentEvent[] = [];
supervisor.subscribe((notice) => {
    if (notice.type !== 'event') {
        return;
    }
    const event = notice.event;
    events.push(event);
    if (event.type === 'permission') {
        const allow = /memory_/.test(event.title) ? event.options.find((option) => option.kind.startsWith('allow')) : undefined;
        console.log(`  permission "${event.title}": ${allow === undefined ? 'refused' : 'allowed'}`);
        supervisor.answerPermission(agent.id, event.requestId, allow?.optionId);
    }
    if (event.type === 'tool-call' && event.title !== undefined) {
        console.log(`  tool: ${event.title}${event.status === undefined ? '' : ` (${event.status})`}`);
    }
});
/** Sends the message and gives the whole answer once the turn is over. */
async function ask(text: string): Promise<string> {
    const from = events.length;
    await supervisor.send(agent.id, text);
    for (;;) {
        const end = events.slice(from).findIndex((event) => event.type === 'turn-end');
        if (end !== -1) {
            return events.slice(from, from + end).filter((event) => event.type === 'message' && event.role === 'agent')
                .map((event) => event.type === 'message' ? event.text : '').join('');
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}
const steps: Step[] = [];
async function step(name: string, text: string, check: (answer: string) => boolean): Promise<void> {
    console.log(`\n# ${name}\n> ${text}`);
    const answer = await ask(text);
    console.log(answer.trim().split('\n').map((line) => `< ${line}`).join('\n'));
    steps.push({ name, ok: check(answer), answer });
}
try {
    await supervisor.startAgent(agent.id);
    console.log('memory status:', JSON.stringify(supervisor.agents()[0]?.memory));
    await step('remember', `Please remember this for later: ${FACT}.`, () => /Violet Lantern/.test(JSON.stringify(events)));
    await supervisor.clearContext(agent.id);
    await step('recall in a new session', QUESTION, (answer) => TOKEN.test(answer));
    await supervisor.restart(agent.id);
    await step('recall after a restart (resume)', QUESTION, (answer) => TOKEN.test(answer));
    await step('forget', 'Please forget the codename of project Kestrel-42.', () => true);
    await supervisor.clearContext(agent.id);
    await step('forgotten in a new session', QUESTION, (answer) => !TOKEN.test(answer));
    await supervisor.stopAgent(agent.id);
    rmSync(agent.memoryDirectory, { recursive: true, force: true });
    writeFileSync(agent.memoryDirectory, 'a file where the memory bank should be');
    await supervisor.startAgent(agent.id);
    console.log('memory status:', JSON.stringify(supervisor.agents()[0]?.memory));
    await step('an unwritable bank: no false "remembered"', 'Please remember this for later: my favourite tea is oolong.',
        (answer) => /(not|n't|couldn't|unable|failed|unavailable)/i.test(answer));
} finally {
    await supervisor.stop();
    await tools.close();
    rmSync(root, { recursive: true, force: true });
}
console.log('\n## verdict');
for (const { name, ok } of steps) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
process.exitCode = steps.every(({ ok }) => ok) ? 0 : 1;
