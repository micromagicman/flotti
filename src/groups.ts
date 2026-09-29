import { isObject, optionalString, reject, shown, typeName } from './manifest.js';
import type { Place } from './manifest.js';
import type { Group } from './types.js';
/** Directory of the fleet with the groups of agents. */
const GROUPS_DIRECTORY = 'groups';
/** File in every group directory that describes the group. */
const GROUP_FILE = 'group.json';
/** What a member may be called: the rule of an agent id, since a member is named by id only. */
const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Group a new user can start from. */
const SAMPLE_GROUP = `{
    "name": "Release",
    "topic": "What the group is for, and what its members are expected to do there.",
    "members": ["eva", "reviewer"]
}`;
type Fields = Record<string, unknown>;
/** Where a group file lives. */
type GroupContext = {
    /** Directory name of the group. */
    readonly id: string;
    readonly directory: string;
    readonly filePath: string;
};
/**
 * Checks `group.json` the way a manifest is checked and fills in the
 * documented defaults. Fields flotti does not know are kept in the file, and a
 * member that is not in the fleet is kept: it is not an error.
 *
 * @throws ConfigurationError naming the file and the field.
 */
function parseGroup(value: unknown, context: GroupContext): Group {
    const fields = groupObject(value, context);
    const at = (field: string): Place => ({ field, path: context.filePath });
    requireSameId(optionalString(fields['id'], at('id')), context);
    const topic = optionalString(fields['topic'], at('topic'));
    return {
        id: context.id,
        name: optionalString(fields['name'], at('name')) ?? context.id,
        ...(topic === undefined ? {} : { topic }),
        members: members(fields['members'], at('members')),
        directory: context.directory,
        filePath: context.filePath
    };
}
function groupObject(value: unknown, context: GroupContext): Fields {
    if (!isObject(value)) {
        reject('wrong-type', context.filePath, `the group must be a JSON object, got ${typeName(value)}`);
    }
    return value;
}
/** An `id` in the file must be the name of the directory: the directory is what counts. */
function requireSameId(id: string | undefined, context: GroupContext): void {
    if (id !== undefined && id !== context.id) {
        reject(
            'id-mismatch',
            context.filePath,
            `id is "${id}", but the group directory is "${context.id}"; the directory name is the id — `
            + 'rename the directory or drop the field'
        );
    }
}
/** `members`: ids of agents, each once; it must be there, and may be empty. */
function members(value: unknown, place: Place): string[] {
    if (value === undefined) {
        reject('missing-field', place.path, `${place.field} is missing (expected an array of agent ids, which may be empty)`);
    }
    if (!Array.isArray(value)) {
        reject('wrong-type', place.path, `${place.field} must be an array of agent ids, got ${typeName(value)}`);
    }
    return value.map((item: unknown, index: number) => memberId(item, index, value.slice(0, index), place));
}
/** One member: an agent id, not yet in the list. */
function memberId(item: unknown, index: number, before: readonly unknown[], place: Place): string {
    if (typeof item !== 'string' || !MEMBER_ID.test(item)) {
        reject(
            'wrong-type',
            place.path,
            `${place.field}[${index}] must be an agent id — letters, digits, ".", "_" and "-", `
            + `starting with a letter or a digit — got ${shown(item)}`
        );
    }
    if (before.includes(item)) {
        reject('wrong-type', place.path, `${place.field}[${index}] repeats "${item}"; an agent is in a group once`);
    }
    return item;
}
/** The groups the agent is in, in the order of the groups. */
function groupsOf(groups: readonly Group[], agentId: string): Group[] {
    return groups.filter((group: Group) => group.members.includes(agentId));
}
/**
 * The peers of the agent: the members of every group it is in, itself
 * excluded, each once, in the order they are met. An agent in no group has
 * no peers.
 */
function peersOf(groups: readonly Group[], agentId: string): string[] {
    const peers = new Set<string>();
    for (const group of groupsOf(groups, agentId)) {
        for (const member of group.members) {
            if (member !== agentId) {
                peers.add(member);
            }
        }
    }
    return [...peers];
}
/**
 * Whether `from` may write to `to`: the two share a group. Nobody reaches
 * itself this way, and an agent in no group reaches nobody.
 */
function canReach(groups: readonly Group[], from: string, to: string): boolean {
    return peersOf(groups, from).includes(to);
}
export { GROUPS_DIRECTORY, GROUP_FILE, SAMPLE_GROUP, canReach, groupsOf, parseGroup, peersOf };
export type { GroupContext };
