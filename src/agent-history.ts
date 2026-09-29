import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from './agent-events.js';
import type { GroupMessage } from './dashboard-protocol.js';
/** Where the history of an agent or a group lives: in its own directory, next to its manifest. */
const HISTORY_FILE = '.flotti-history.jsonl';
/** What every line of a history has: its number, which only grows, and its time. */
type Numbered = { readonly seq: number; readonly time: string };
/** A line of the file as JSON, with the fields every line has; nothing when it lacks them. */
type Line = Numbered & Record<string, unknown>;
/**
 * What the file holds, as the one who keeps it reads a line: the event of an
 * agent, or the message of a group. Nothing for a line that is not one.
 */
type Reader<T extends Numbered> = (line: Line) => T | undefined;
function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
function isLine(value: unknown): value is Line {
    return typeof value === 'object' && value !== null && hasLineFields(value as Record<string, unknown>);
}
function hasLineFields({ seq, time }: Record<string, unknown>): boolean {
    return isEventNumber(seq) && typeof time === 'string';
}
function isEventNumber(seq: unknown): boolean {
    return typeof seq === 'number' && Number.isInteger(seq) && seq > 0;
}
/** The events of an agent, as the file of the agent `agentId` gives them: the id is the file's, not the line's. */
function agentEvents(agentId: string): Reader<AgentEvent> {
    return (line) => typeof line['type'] === 'string' ? { ...line, agentId } as AgentEvent : undefined;
}
/** The messages of a group, as the file of the group `groupId` gives them. */
function groupMessages(groupId: string): Reader<GroupMessage> {
    return (line) => typeof line['text'] === 'string' && Array.isArray(line['deliveries']) ? { ...line, groupId } as GroupMessage : undefined;
}
/**
 * The events of one agent on disk, so its tab shows the same conversation
 * after flotti is started again — or the messages of one group, so the tab of
 * the group does: one per line, as JSON, in `.flotti-history.jsonl` in the
 * directory of the agent or the group.
 *
 * Bounded by the same number of events the supervisor keeps in memory: lines
 * are appended as events come, and once the file holds twice that many it is
 * rewritten with the newest `limit` only — the oldest go first.
 *
 * A file that cannot be read or written costs the history, not the agent: it
 * says so once and flotti goes on without it.
 */
class HistoryFile<T extends Numbered> {
    readonly path: string;
    private lines = 0;
    private broken = false;
    /**
     * @param owner Whose history it is, for the warning: `agent "eva"`, `group "release"`.
     * @param read What a line of the file is, when it is one: {@link agentEvents}, {@link groupMessages}.
     */
    constructor(
        private readonly owner: string,
        directory: string,
        private readonly limit: number,
        private readonly warn: (text: string) => void,
        private readonly read: Reader<T>
    ) {
        this.path = join(directory, HISTORY_FILE);
    }
    /**
     * The newest `limit` events of the file, oldest first. A line that is not
     * an event — the last one torn by a crash, a hand edit — is skipped, and so
     * is one whose number does not grow: the numbers of an agent only grow.
     */
    load(): T[] {
        const contents = this.contents();
        if (contents === undefined) {
            return [];
        }
        const lines = contents.split('\n');
        const events = this.growing(lines);
        this.lines = lines.filter((line) => line.trim() !== '').length;
        return events.slice(-this.limit);
    }
    /** The events of the lines, each numbered above the one before it. */
    private growing(lines: readonly string[]): T[] {
        const events: T[] = [];
        let last = 0;
        for (const line of lines) {
            const event = this.parse(line);
            if (event !== undefined && event.seq > last) {
                events.push(event);
                last = event.seq;
            }
        }
        return events;
    }
    /** The whole file; nothing when there is none yet or it cannot be read. */
    private contents(): string | undefined {
        try {
            return readFileSync(this.path, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.fail('read', error);
            }
            return undefined;
        }
    }
    /**
     * Writes one more event down.
     *
     * @param kept What is left of the history once this event is in it: the file is rewritten with it when it grows too long.
     */
    append(event: T, kept: readonly T[]): void {
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
    private rewrite(kept: readonly T[]): void {
        const temporary = `${this.path}.tmp`;
        writeFileSync(temporary, kept.map((event) => `${JSON.stringify(event)}\n`).join(''));
        renameSync(temporary, this.path);
        this.lines = kept.length;
    }
    private parse(line: string): T | undefined {
        if (line.trim() === '') {
            return undefined;
        }
        try {
            const parsed: unknown = JSON.parse(line);
            return isLine(parsed) ? this.read(parsed) : undefined;
        } catch {
            return undefined;
        }
    }
    private fail(what: 'read' | 'write', error: unknown): void {
        this.broken = true;
        this.warn(`Could not ${what} the history of ${this.owner} (${this.path}): ${describeError(error)}. `
            + 'Its tab keeps what happens while flotti runs, and loses it on restart.');
    }
}
export { HISTORY_FILE, HistoryFile, agentEvents, groupMessages };
