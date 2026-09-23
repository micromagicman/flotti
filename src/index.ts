#!/usr/bin/env node
import { DEFAULT_PORT } from './dashboard-server.js';
import { ConfigurationError } from './errors.js';
import { DEFAULT_FLEET_PATH, FLEET_PATH_ARGUMENT, FLEET_PATH_VARIABLE } from './fleet.js';
import { MANIFEST_FILE } from './manifest.js';
import { PORT_ARGUMENT, PORT_VARIABLE, runFleet, stopFleet } from './run.js';
const HELP = `flotti — simple ai agents orchestrator for humans

Usage:
  flotti run  [${FLEET_PATH_ARGUMENT} <dir>] [${PORT_ARGUMENT} <port>]
  flotti stop [${FLEET_PATH_ARGUMENT} <dir>]

Commands:
  run    Starts the agents of the fleet and serves the dashboard on
         http://127.0.0.1:${DEFAULT_PORT}/; everything else is done there.
  stop   Stops the flotti that runs the fleet, and its agents with it.

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
explains the fields in full — JSON has no comments to explain them in place.`;
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
    if (argv.includes('--help') || argv.includes('-h') || command === undefined) {
        console.log(HELP);
        return 0;
    }
    try {
        switch (command) {
            case 'run':
                return await run(argv.slice(1));
            case 'stop':
                return (await stopFleet({ argv: argv.slice(1) })) ? 0 : 1;
            default:
                console.error(`Unknown command "${command}".\n\n${HELP}`);
                return 1;
        }
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
// Stopped agents leave no work behind, but a stray timer of a library would
// keep the process alive: once flotti is done, it is done.
process.exit(await main(process.argv.slice(2)));
