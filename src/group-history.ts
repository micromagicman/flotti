import { HistoryFile, groupMessages } from './agent-history.js';
import type { GroupMessage } from './dashboard-protocol.js';
/** A message of a group before it is numbered and timed: what the one who posts it knows. */
type GroupMessageBody = Omit<GroupMessage, 'groupId' | 'seq' | 'time'>;
/** What the history of a group starts with: the messages of its file, and where their numbers go on from. */
type Restored = { readonly messages: GroupMessage[]; readonly lastSeq: number };
/**
 * The messages of one group (docs/groups.md), numbered and kept: in memory,
 * bounded as the events of an agent are, and in `.flotti-history.jsonl` of
 * the group directory when the run keeps histories. The numbers of a group
 * only grow: a page that has seen N gets what comes next, across a restart.
 */
class GroupHistory {
    private readonly messages: GroupMessage[];
    private lastSeq: number;
    private readonly file: HistoryFile<GroupMessage> | undefined;
    /**
     * @param directory Where the file of the group is; absent when the history is kept in memory only.
     * @param offset The last number given to a message of this group before: the next one is above it.
     */
    constructor(
        readonly groupId: string,
        directory: string | undefined,
        private readonly limit: number,
        warn: (text: string) => void,
        offset = 0
    ) {
        this.file = openFile(groupId, directory, limit, warn);
        const { messages, lastSeq } = restore(this.file, offset);
        this.messages = messages;
        this.lastSeq = lastSeq;
    }
    /** The last number given to a message of the group; 0 when there was none. */
    get last(): number {
        return this.lastSeq;
    }
    /** The messages that came after `afterSeq`, oldest first. */
    since(afterSeq = 0): GroupMessage[] {
        return this.messages.filter((message) => message.seq > afterSeq);
    }
    /** Keeps one more message of the group, with the next number and the time; returns it as kept. */
    add(body: GroupMessageBody): GroupMessage {
        this.lastSeq += 1;
        const message: GroupMessage = { groupId: this.groupId, seq: this.lastSeq, time: new Date().toISOString(), ...body };
        this.messages.push(message);
        if (this.messages.length > this.limit) {
            this.messages.splice(0, this.messages.length - this.limit);
        }
        this.file?.append(message, this.messages);
        return message;
    }
}
/** The file of the group, when the history goes to disk. */
function openFile(groupId: string, directory: string | undefined, limit: number, warn: (text: string) => void): HistoryFile<GroupMessage> | undefined {
    return directory === undefined ? undefined : new HistoryFile(`group "${groupId}"`, directory, limit, warn, groupMessages(groupId));
}
/**
 * What the file kept, when it is newer than anything numbered since flotti
 * started: a group made again in one run does not show its messages twice,
 * and goes on numbering above them.
 */
function restore(file: HistoryFile<GroupMessage> | undefined, offset: number): Restored {
    const loaded = file === undefined ? [] : file.load();
    const fileLast = lastSeqOf(loaded);
    return fileLast > offset ? { messages: loaded, lastSeq: fileLast } : { messages: [], lastSeq: offset };
}
function lastSeqOf(messages: readonly GroupMessage[]): number {
    return messages.at(-1)?.seq ?? 0;
}
export { GroupHistory };
export type { GroupMessageBody };
