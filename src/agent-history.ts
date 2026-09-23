import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from './agent-events.js';
/** Where the history of an agent lives: in its own directory, next to its manifest. */
const HISTORY_FILE = '.flotti-history.jsonl';
function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
function isEvent(value: unknown): value is AgentEvent {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const { seq, type, time } = value as Record<string, unknown>;
    return typeof seq === 'number' && Number.isInteger(seq) && seq > 0 && typeof type === 'string' && typeof time === 'string';
}
/**
 * The events of one agent on disk, so its tab shows the same conversation
 * after flotti is started again: one event per line, as JSON, in
 * `.flotti-history.jsonl` in the agent directory.
 *
 * Bounded by the same number of events the supervisor keeps in memory: lines
 * are appended as events come, and once the file holds twice that many it is
 * rewritten with the newest `limit` only — the oldest go first.
 *
 * A file that cannot be read or written costs the history, not the agent: it
 * says so once and flotti goes on without it.
 */
class HistoryFile {
    readonly path: string;
    private lines = 0;
    private broken = false;
    constructor(
        private readonly agentId: string,
        directory: string,
        private readonly limit: number,
        private readonly warn: (text: string) => void
    ) {
        this.path = join(directory, HISTORY_FILE);
    }
    /**
     * The newest `limit` events of the file, oldest first. A line that is not
     * an event — the last one torn by a crash, a hand edit — is skipped, and so
     * is one whose number does not grow: the numbers of an agent only grow.
     */
    load(): AgentEvent[] {
        let contents: string;
        try {
            contents = readFileSync(this.path, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.fail('read', error);
            }
            return [];
        }
        const events: AgentEvent[] = [];
        const lines = contents.split('\n');
        for (const line of lines) {
            const event = this.parse(line);
            if (event !== undefined && event.seq > (events.at(-1)?.seq ?? 0)) {
                events.push(event);
            }
        }
        this.lines = lines.filter((line) => line.trim() !== '').length;
        return events.slice(-this.limit);
    }
    /**
     * Writes one more event down.
     *
     * @param kept What is left of the history once this event is in it: the file is rewritten with it when it grows too long.
     */
    append(event: AgentEvent, kept: readonly AgentEvent[]): void {
        if (this.broken) {
            return;
        }
        try {
            if (this.lines + 1 >= 2 * this.limit) {
                this.rewrite(kept);
            } else {
                appendFileSync(this.path, `${JSON.stringify(event)}\n`);
                this.lines += 1;
            }
        } catch (error) {
            this.fail('write', error);
        }
    }
    private rewrite(kept: readonly AgentEvent[]): void {
        const temporary = `${this.path}.tmp`;
        writeFileSync(temporary, kept.map((event) => `${JSON.stringify(event)}\n`).join(''));
        renameSync(temporary, this.path);
        this.lines = kept.length;
    }
    private parse(line: string): AgentEvent | undefined {
        if (line.trim() === '') {
            return undefined;
        }
        try {
            const parsed: unknown = JSON.parse(line);
            return isEvent(parsed) ? { ...parsed, agentId: this.agentId } : undefined;
        } catch {
            return undefined;
        }
    }
    private fail(what: 'read' | 'write', error: unknown): void {
        this.broken = true;
        this.warn(`Could not ${what} the history of agent "${this.agentId}" (${this.path}): ${describeError(error)}. `
            + 'Its tab keeps what happens while flotti runs, and loses it on restart.');
    }
}
export { HISTORY_FILE, HistoryFile };
