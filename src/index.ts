#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from './dashboard-server.js';
import { ConfigurationError } from './errors.js';
import { DEFAULT_FLEET_PATH, FLEET_PATH_ARGUMENT, FLEET_PATH_VARIABLE } from './fleet.js';
import { MANIFEST_FILE } from './manifest.js';
import { LOG_FILE, PORT_ARGUMENT, PORT_VARIABLE, RUN_FILE, fleetStatus, runFleet, startFleet, stopFleet } from './run.js';
const HELP = `flotti — simple ai agents orchestrator for humans

Usage:
  flotti start  [${FLEET_PATH_ARGUMENT} <dir>] [${PORT_ARGUMENT} <port>]
  flotti stop   [${FLEET_PATH_ARGUMENT} <dir>]
  flotti status [${FLEET_PATH_ARGUMENT} <dir>]
  flotti run    [${FLEET_PATH_ARGUMENT} <dir>] [${PORT_ARGUMENT} <port>]

Commands:
  start   Starts the agents of the fleet and serves the dashboard on
          http://127.0.0.1:${DEFAULT_PORT}/ in the background, and gives the
          terminal back; everything else is done in the dashboard. The output
          goes to ${LOG_FILE} in the fleet directory.
  stop    Stops the flotti that runs the fleet, and its agents with it.
  status  Lists the agents of the running fleet: id, local or remote,
          harness, status; for a remote agent reached over SSH, also the
          latency, the reconnects and the uptime of its connection.
  run     Does what start does, in the foreground: Ctrl+C stops it.

Options:
  ${FLEET_PATH_ARGUMENT} <dir>      Fleet directory.
  ${PORT_ARGUMENT} <port>     Dashboard port; ${PORT_VARIABLE} does the same.
  -h, --help         Print this help.

Fleet directory, in this order:
  1. ${FLEET_PATH_ARGUMENT} <dir>
  2. ${FLEET_PATH_VARIABLE}=<dir>
  3. ${DEFAULT_FLEET_PATH}

Every agent is a directory: local/<id>/ for agents flotti starts itself,
remote/<id>/ for agents it reaches over A2A. Each holds ${MANIFEST_FILE}; README.md
explains the fields in full — JSON has no comments to explain them in place.
A running flotti is found by ${RUN_FILE} in the fleet directory.`;
/** This very script: `flotti start` runs it again, as `flotti run`, in the background. */
const ENTRY = fileURLToPath(import.meta.url);
/** Runs until the fleet is stopped: Ctrl+C, a signal, or `flotti stop`. */
async function run(argv: readonly string[]): Promise<number> {
    const running = await runFleet({ argv });
    const stop = (): void => {
        void running.stop();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await running.stopped;
    return 0;
}
async function main(argv: readonly string[]): Promise<number> {
    const [command] = argv;
    if (command === undefined || wantsHelp(argv)) {
        console.log(HELP);
        return 0;
    }
    try {
        return await runCommand(command, argv.slice(1));
    } catch (error) {
        return reportFailure(error);
    }
}
function wantsHelp(argv: readonly string[]): boolean {
    return argv.includes('--help') || argv.includes('-h');
}
function exitCode(ok: boolean): number {
    return ok ? 0 : 1;
}
/** The commands of the CLI, each with the exit code it ends with. */
const COMMANDS = new Map<string, (args: readonly string[]) => Promise<number>>([
    ['run', run],
    ['start', async (args) => exitCode(await startFleet({ argv: args, entry: ENTRY }))],
    ['stop', async (args) => exitCode(await stopFleet({ argv: args }))],
    ['status', async (args) => exitCode(await fleetStatus({ argv: args }))]
]);
/** Runs one command of the CLI with the arguments that follow it. */
async function runCommand(command: string, args: readonly string[]): Promise<number> {
    const commandRun = COMMANDS.get(command);
    if (commandRun === undefined) {
        console.error(`Unknown command "${command}".\n\n${HELP}`);
        return 1;
    }
    return await commandRun(args);
}
/** A configuration error is told to the person and ends with 1; anything else is thrown on. */
function reportFailure(error: unknown): number {
    if (error instanceof ConfigurationError) {
        console.error(error.message);
        if (error.hint !== undefined) {
            console.error(error.hint);
        }
        return 1;
    }
    throw error;
}
// Stopped agents leave no work behind, but a stray timer of a library would
// keep the process alive: once flotti is done, it is done.
process.exit(await main(process.argv.slice(2)));
