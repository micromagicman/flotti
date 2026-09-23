import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import type { AgentEvent, AgentStatus } from '../src/agent-events.js';
import { LocalAgentProcess } from '../src/local-agent.js';
import type { LocalAgentOptions } from '../src/local-agent.js';
import type { LocalAgent } from '../src/types.js';
const FAKE_AGENT = fileURLToPath(new URL('./fake-acp-agent.js', import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), 'flotti-agent-'));
const started: LocalAgentProcess[] = [];
after(async () => {
    await Promise.all(started.map((agent) => agent.stop()));
    rmSync(workspace, { recursive: true, force: true });
});
let made = 0;
type FakeSetup = {
    /** What the pretend agent does; see test/fake-acp-agent.ts. */
    readonly fake?: Record<string, unknown>;
    /** Manifest fields over the defaults. */
    readonly manifest?: Partial<LocalAgent>;
    readonly options?: LocalAgentOptions;
    /** Contents of system-prompt.md; no file when absent. */
    readonly systemPrompt?: string;
};
/** A local agent that runs the pretend ACP agent, with its own directory and record file. */
class Harness {
    readonly directory: string;
    readonly recordFile: string;
    readonly agent: LocalAgentProcess;
    readonly events: AgentEvent[] = [];
    private readonly waiting: { test: (event: AgentEvent) => boolean; resolve: (event: AgentEvent) => void }[] = [];
    constructor(setup: FakeSetup = {}) {
        this.directory = join(workspace, `agent-${++made}`);
        mkdirSync(join(this.directory, 'skills'), { recursive: true });
        mkdirSync(join(this.directory, 'memory'), { recursive: true });
        this.recordFile = join(this.directory, 'record.jsonl');
        const systemPromptFile = join(this.directory, 'system-prompt.md');
        if (setup.systemPrompt !== undefined) {
            writeFileSync(systemPromptFile, setup.systemPrompt);
        }
        const manifest: LocalAgent = {
            kind: 'local',
            id: `agent-${made}`,
            name: `agent-${made}`,
            directory: this.directory,
            manifestPath: join(this.directory, 'agent.json'),
            command: process.execPath,
            arguments: [FAKE_AGENT],
            workdir: this.directory,
            env: {},
            restart: 'on-failure',
            heartbeatTimeoutSec: 60,
            skillsDirectory: join(this.directory, 'skills'),
            memoryDirectory: join(this.directory, 'memory'),
            ...(setup.systemPrompt === undefined ? {} : { systemPromptFile }),
            ...setup.manifest
        };
        const fake = { record: this.recordFile, counter: join(this.directory, 'counter'), ...setup.fake };
        this.agent = new LocalAgentProcess(manifest, {
            env: { ...process.env, FAKE_ACP: JSON.stringify(fake) },
            startSecs: 5,
            maxRetries: 2,
            backoffBaseMs: 10,
            backoffMaxMs: 50,
            cancelTimeoutMs: 1000,
            stopTimeoutMs: 1000,
            ...setup.options
        });
        started.push(this.agent);
        this.agent.subscribe((event) => {
            this.events.push(event);
            for (const waiter of [...this.waiting]) {
                if (waiter.test(event)) {
                    this.waiting.splice(this.waiting.indexOf(waiter), 1);
                    waiter.resolve(event);
                }
            }
        });
    }
    /** The first event from now on, or already seen, that passes the test. */
    next(test: (event: AgentEvent) => boolean): Promise<AgentEvent> {
        const seen = this.events.find(test);
        if (seen !== undefined) {
            return Promise.resolve(seen);
        }
        return new Promise((resolve) => this.waiting.push({ test, resolve }));
    }
    /** The first status event with this status that comes after `seq`. */
    status(status: AgentStatus, afterSeq = 0): Promise<AgentEvent> {
        return this.next((event) => event.seq > afterSeq && event.type === 'status' && event.status === status);
    }
    /**
     * Sends a message and waits until the agent is done with it; resolves with
     * the reason of its `turn-end` event. `send` itself resolves as soon as the
     * message went to the agent.
     */
    async talk(text: string): Promise<string> {
        const before = this.lastSeq;
        const sent = this.next((event) =>
            event.seq > before && event.type === 'message' && event.role === 'user' && event.text === text);
        await this.agent.send(text);
        const { seq } = await sent;
        const end = await this.next((event) => event.seq > seq && event.type === 'turn-end');
        return end.type === 'turn-end' ? end.reason : '';
    }
    /** What the pretend agent recorded, one object per line. */
    record(): Record<string, unknown>[] {
        if (!existsSync(this.recordFile)) {
            return [];
        }
        return readFileSync(this.recordFile, 'utf8').trim().split('\n').filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
    }
    recorded(event: string): Record<string, unknown>[] {
        return this.record().filter((entry) => entry['event'] === event);
    }
    get lastSeq(): number {
        return this.events.at(-1)?.seq ?? 0;
    }
}
function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
/** Waits until the condition holds, checking every 20 ms; fails after `timeoutMs`. */
async function eventually(condition: () => boolean, timeoutMs = 3000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > until) {
            throw new Error('the condition did not come true in time');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
export { FAKE_AGENT, Harness, eventually, isAlive, workspace };
