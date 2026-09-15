import {
    CONFIGURATION_PATH_ARGUMENT,
    CONFIGURATION_PATH_VARIABLE,
    DEFAULT_CONFIGURATION_PATH,
    DEFAULT_HEARTBEAT_TIMEOUT_SEC,
    DEFAULT_RESTART_POLICY,
    loadConfiguration
} from './config.js';
import { ConfigurationError } from './errors.js';
import type { Agent } from './types.js';
const HELP = `supavisor — simple ai agents orchestrator for humans

Usage:
  supavisor [${CONFIGURATION_PATH_ARGUMENT} <path>]

Options:
  ${CONFIGURATION_PATH_ARGUMENT} <path>   Configuration file to read.
  -h, --help        Print this help.

Configuration file, in this order:
  1. ${CONFIGURATION_PATH_ARGUMENT} <path>
  2. ${CONFIGURATION_PATH_VARIABLE}=<path>
  3. ${DEFAULT_CONFIGURATION_PATH}

Every agent needs "name", "command" and "arguments"; "workdir" (supavisor's own
directory by default), "env" (nothing added by default), "restart"
("${DEFAULT_RESTART_POLICY}" by default: "always", "on-failure" or "never") and
"heartbeatTimeoutSec" (${DEFAULT_HEARTBEAT_TIMEOUT_SEC} by default) are optional. README.md explains the
fields in full — JSON has no comments to explain them in place.`;
function describe(agent: Agent): string {
    const command = [agent.command, ...agent.arguments].join(' ');
    return `  ${agent.name}: ${command}`;
}
function main(argv: readonly string[]): number {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(HELP);
        return 0;
    }
    try {
        const { location, configuration } = loadConfiguration({ argv });
        console.log(`Read ${configuration.agents.length} agent(s) from ${location.path} (${location.source}).`);
        for (const agent of configuration.agents) {
            console.log(describe(agent));
        }
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
