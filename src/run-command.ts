import { createInterface } from 'node:readline/promises';
import { ConfigurationError } from './errors.js';
import { FLEET_PATH_ARGUMENT, loadFleet, prepareFleet } from './fleet.js';
import { LocalAgentProcess } from './local-agent.js';
import type { AgentEvent, PermissionOption } from './agent-events.js';
import type { LocalAgent } from './types.js';

/** Answers every permission request with "allow" instead of asking. */
const YES_ARGUMENT = '--yes';

const RUN_USAGE = `Usage:
  supavisor run <agent-id> [message]  [${FLEET_PATH_ARGUMENT} <dir>] [${YES_ARGUMENT}]

Starts the local agent, sends it the message — or what comes on stdin when
there is none — prints the answer as it streams in, and stops the agent.
Permission requests are asked on the terminal; ${YES_ARGUMENT} allows them all,
and without a terminal to ask on they are rejected.`;

type RunArguments = {
    readonly id: string;
    readonly message: string | undefined;
    readonly yes: boolean;
};

/**
 * `supavisor run`: one message to one local agent, from start to stop.
 *
 * @returns Exit code: 0 when the agent ended its turn normally.
 */
async function runCommand(argv: readonly string[]): Promise<number> {
    const parsed = parseRunArguments(argv);
    if (parsed === undefined) {
        console.error(RUN_USAGE);
        return 2;
    }
    const fleet = loadFleet({ argv });
    prepareFleet(fleet);
    const agent = fleet.agents.find((candidate) => candidate.id === parsed.id);
    if (agent === undefined || agent.kind !== 'local') {
        const reason = agent === undefined ? 'there is no such agent' : 'it is a remote agent';
        throw new ConfigurationError('invalid-argument', `Cannot run "${parsed.id}": ${reason} in ${fleet.location.path}`);
    }
    const text = parsed.message ?? await readStdin();
    if (text.trim() === '') {
        console.error('Nothing to send: give a message or pipe one in.');
        return 2;
    }
    return converse(agent, text, parsed.yes, parsed.message !== undefined);
}

async function converse(agent: LocalAgent, text: string, yes: boolean, canAsk: boolean): Promise<number> {
    const running = new LocalAgentProcess(agent);
    const ask = canAsk && process.stdin.isTTY === true && !yes;
    let lastWasText = false;
    running.subscribe((event: AgentEvent) => {
        switch (event.type) {
            case 'message':
                if (event.role === 'agent') {
                    process.stdout.write(event.text);
                    lastWasText = true;
                }
                return;
            case 'tool-call':
                if (event.title !== undefined) {
                    breakLine();
                    console.error(`[tool] ${event.title}${event.status === undefined ? '' : ` (${event.status})`}`);
                }
                return;
            case 'permission':
                breakLine();
                void decide(running, event.requestId, event.title, event.options, yes, ask);
                return;
            case 'log':
                if (event.source === 'supavisor') {
                    breakLine();
                    console.error(`[supavisor] ${event.text}`);
                }
                return;
            case 'status':
                if (event.status === 'starting' && event.detail !== undefined && event.detail !== 'starting') {
                    breakLine();
                    console.error(`[${agent.id}] ${event.detail}`);
                }
                return;
            default:
                return;
        }
    });
    function breakLine(): void {
        if (lastWasText) {
            process.stdout.write('\n');
            lastWasText = false;
        }
    }
    const interrupt = (): void => {
        void running.cancel();
    };
    process.on('SIGINT', interrupt);
    try {
        await running.start();
        const reason = await running.send(text);
        breakLine();
        if (reason !== 'end_turn') {
            console.error(`[${agent.id}] stopped: ${reason}`);
        }
        return reason === 'end_turn' ? 0 : 1;
    } catch (error) {
        breakLine();
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
    } finally {
        process.off('SIGINT', interrupt);
        await running.stop();
    }
}

async function decide(
    agent: LocalAgentProcess,
    requestId: string,
    title: string,
    options: readonly PermissionOption[],
    yes: boolean,
    ask: boolean
): Promise<void> {
    const allow = options.find((option) => option.kind.startsWith('allow'));
    const reject = options.find((option) => option.kind.startsWith('reject'));
    if (yes || !ask) {
        const chosen = yes ? allow : reject;
        console.error(`[permission] ${title}: ${chosen?.name ?? 'cancelled'}${ask || yes ? '' : ' (no terminal to ask on)'}`);
        agent.answerPermission(requestId, chosen?.optionId);
        return;
    }
    const lines = options.map((option, index) => `  ${index + 1}. ${option.name}`).join('\n');
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
        for (;;) {
            const answer = await prompt.question(`[permission] ${title}\n${lines}\nChoose: `);
            const chosen = options[Number(answer.trim()) - 1];
            if (chosen !== undefined) {
                agent.answerPermission(requestId, chosen.optionId);
                return;
            }
        }
    } finally {
        prompt.close();
    }
}

function parseRunArguments(argv: readonly string[]): RunArguments | undefined {
    const positionals: string[] = [];
    let yes = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index] ?? '';
        if (argument === FLEET_PATH_ARGUMENT) {
            index += 1;
        } else if (argument.startsWith(`${FLEET_PATH_ARGUMENT}=`)) {
            continue;
        } else if (argument === YES_ARGUMENT) {
            yes = true;
        } else {
            positionals.push(argument);
        }
    }
    const [id, ...words] = positionals;
    if (id === undefined || id.startsWith('-')) {
        return undefined;
    }
    return { id, message: words.length === 0 ? undefined : words.join(' '), yes };
}

async function readStdin(): Promise<string> {
    if (process.stdin.isTTY === true) {
        return '';
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

export { RUN_USAGE, parseRunArguments, runCommand };
