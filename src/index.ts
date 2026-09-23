import { ConfigurationError } from './errors.js';
import {
    DEFAULT_FLEET_PATH,
    FLEET_PATH_ARGUMENT,
    FLEET_PATH_VARIABLE,
    loadFleet,
    prepareFleet
} from './fleet.js';
import { MANIFEST_FILE, SAMPLE_LOCAL_MANIFEST } from './manifest.js';
import type { Agent, Fleet } from './types.js';
const HELP = `flotti — simple ai agents orchestrator for humans

Usage:
  flotti [${FLEET_PATH_ARGUMENT} <dir>]

Options:
  ${FLEET_PATH_ARGUMENT} <dir>      Fleet directory to read.
  -h, --help         Print this help.

Fleet directory, in this order:
  1. ${FLEET_PATH_ARGUMENT} <dir>
  2. ${FLEET_PATH_VARIABLE}=<dir>
  3. ${DEFAULT_FLEET_PATH}

Every agent is a directory: local/<id>/ for agents flotti starts itself,
remote/<id>/ for agents it reaches over A2A. Each holds ${MANIFEST_FILE}; README.md
explains the fields in full — JSON has no comments to explain them in place.`;
function describe(agent: Agent): string {
    if (agent.kind === 'remote') {
        return `  ${agent.id} (remote, ${agent.protocol}): ${agent.url}`;
    }
    const command = [agent.command, ...agent.arguments].join(' ');
    const adapter = agent.adapter === undefined ? '' : `, ${agent.adapter}`;
    return `  ${agent.id} (local${adapter}): ${command}`;
}
function report(fleet: Fleet, created: readonly string[]): void {
    const { location } = fleet;
    if (!fleet.exists) {
        console.log(`No fleet yet: ${location.path} does not exist.`);
        console.log(`To add a local agent, create ${location.path}/local/<id>/${MANIFEST_FILE}, for example:`);
        console.log(SAMPLE_LOCAL_MANIFEST);
        return;
    }
    console.log(`Read ${fleet.agents.length} agent(s) from ${location.path} (${location.source}).`);
    for (const agent of fleet.agents) {
        console.log(describe(agent));
    }
    for (const path of created) {
        console.log(`Created ${path}`);
    }
}
function main(argv: readonly string[]): number {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(HELP);
        return 0;
    }
    try {
        const fleet = loadFleet({ argv });
        report(fleet, prepareFleet(fleet));
        return 0;
    } catch (error) {
        if (error instanceof ConfigurationError) {
            console.error(error.message);
            if (error.hint !== undefined) {
                console.error(error.hint);
            }
            return 1;
        }
        throw error;
    }
}
process.exitCode = main(process.argv.slice(2));
