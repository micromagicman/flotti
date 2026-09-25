/**
 * The memory tools of the fleet MCP server (#101): an agent searches, reads,
 * writes and deletes the notes of its own memory bank. A write is confirmed
 * only once the note is on disk; anything that did not happen comes back as an
 * error result, so the agent cannot mistake it for success.
 */
import { describeError } from './describe-error.js';
import { MemoryStore, MemoryStoreError, checkScope } from './memory-store.js';
const scopeProperty = {
    type: 'string',
    enum: ['agent'],
    description: 'Whose memory: "agent", your own, is the only one for now; leave it out.'
} as const;
const MEMORY_TOOLS = [
    {
        name: 'memory_search',
        description: 'Searches your flotti memory — the notes that outlive this conversation — for words in their id, '
            + 'title, description or text. Returns id, title, description, updated and a snippet of each note found. '
            + 'An empty query lists the newest notes. Search before you answer about the past, and before you write.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Words to look for.' },
                scope: scopeProperty
            },
            required: ['query'],
            additionalProperties: false
        }
    },
    {
        name: 'memory_read',
        description: 'Reads one note of your flotti memory: its title, description, text, and the revision to name '
            + 'when you change or delete it.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Id of the note, as memory_search or the index gives it.' },
                scope: scopeProperty
            },
            required: ['id'],
            additionalProperties: false
        }
    },
    {
        name: 'memory_write',
        description: 'The standard way to store flotti memory with a verifiable result: writes one note — one fact, '
            + 'preference or decision — and answers {id, revision, scope, at} only once it is on disk. Without id it '
            + 'adds a new note; with the id of a note that exists it changes that note, and expected_revision must be '
            + 'the revision you read — a note changed since is a conflict, and nothing is written. Say you remembered '
            + 'something only after this answered with a revision. Never store secrets.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Id of the note to change; leave out for a new note.' },
                title: { type: 'string', description: 'What the note is about, in a few words.' },
                description: { type: 'string', description: 'One line that tells, in the index, whether the note is worth reading.' },
                body: { type: 'string', description: 'The fact itself, in markdown.' },
                expected_revision: { type: 'string', description: 'The revision of the note you read; needed to change a note that exists.' },
                scope: scopeProperty
            },
            required: ['title', 'description', 'body'],
            additionalProperties: false
        }
    },
    {
        name: 'memory_delete',
        description: 'Deletes one note of your flotti memory and answers {id, deleted: true} once it is gone. With '
            + 'expected_revision, only when the note is still at that revision.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Id of the note.' },
                expected_revision: { type: 'string', description: 'The revision of the note you read; optional.' },
                scope: scopeProperty
            },
            required: ['id'],
            additionalProperties: false
        }
    }
] as const;
type MemoryToolResult = { readonly content: { type: 'text'; text: string }[]; readonly isError?: boolean };
type Arguments = Readonly<Record<string, unknown>>;
/** Whether the tool is one of the memory tools. */
function isMemoryTool(name: string): boolean {
    return MEMORY_TOOLS.some((tool) => tool.name === name);
}
/**
 * Runs a memory tool on the bank at `directory`. What did not happen — a bad
 * argument, a conflict, a bank that cannot be written — is an error result
 * that says so.
 */
async function callMemoryTool(directory: string, name: string, args: Arguments): Promise<MemoryToolResult> {
    try {
        checkScope(args['scope']);
        return json(await run(new MemoryStore(directory), name, args));
    } catch (error) {
        return failure(failureText(name, error));
    }
}
/** What a tool that did not work says: one that changes the bank says that nothing was done. */
function failureText(name: string, error: unknown): string {
    const reason = describeError(error);
    const kind = error instanceof MemoryStoreError ? error.kind : 'unavailable';
    return CHANGING_TOOLS.has(name) ? `Not done (${kind}): ${reason}` : `${kind}: ${reason}`;
}
/** The memory tools that change the bank. */
const CHANGING_TOOLS: ReadonlySet<string> = new Set(['memory_write', 'memory_delete']);
/** How each memory tool runs on the bank. */
const TOOL_RUNS = new Map<string, (store: MemoryStore, args: Arguments) => Promise<unknown>>([
    ['memory_search', (store, args) => store.search(optionalText(args, 'query') ?? '')],
    ['memory_read', (store, args) => store.read(text(args, 'id'))],
    ['memory_write', (store, args) => store.write(noteToWrite(args))],
    ['memory_delete', (store, args) => store.delete(text(args, 'id'), optionalText(args, 'expected_revision'))]
]);
/** What the tool answers when it worked. */
function run(store: MemoryStore, name: string, args: Arguments): Promise<unknown> {
    const toolRun = TOOL_RUNS.get(name);
    if (toolRun === undefined) {
        throw new MemoryStoreError('invalid', `no memory tool ${name}`);
    }
    return toolRun(store, args);
}
function noteToWrite(args: Arguments): Parameters<MemoryStore['write']>[0] {
    return {
        ...optional('id', optionalText(args, 'id')),
        title: text(args, 'title'),
        description: optionalText(args, 'description') ?? '',
        body: text(args, 'body'),
        ...optional('expectedRevision', optionalText(args, 'expected_revision'))
    };
}
function optional<K extends string>(key: K, value: string | undefined): { [key in K]?: string } {
    return (value === undefined ? {} : { [key]: value }) as { [key in K]?: string };
}
function text(args: Arguments, name: string): string {
    const value = optionalText(args, name);
    if (value === undefined) {
        throw new MemoryStoreError('invalid', `${name} is missing: it must be non-empty text.`);
    }
    return value;
}
function optionalText(args: Arguments, name: string): string | undefined {
    const value = textOrNothing(args[name], name);
    return value?.trim() === '' ? undefined : value;
}
function textOrNothing(value: unknown, name: string): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new MemoryStoreError('invalid', `${name} must be text.`);
    }
    return value;
}
function json(value: unknown): MemoryToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function failure(value: string): MemoryToolResult {
    return { content: [{ type: 'text', text: value }], isError: true };
}
export { MEMORY_TOOLS, callMemoryTool, isMemoryTool };
