import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigurationError } from './errors.js';
import { DEFAULT_HOST, DEFAULT_PORT, startDashboard } from './dashboard-server.js';
import type { DashboardOptions } from './dashboard-server.js';
import { loadFleet, prepareFleet } from './fleet.js';
import { FleetSettings } from './fleet-settings.js';
import type { LoadFleetOptions } from './fleet.js';
import { Supervisor } from './supervisor.js';
import type { SupervisorOptions } from './supervisor.js';
import type { Fleet } from './types.js';
/** Command line argument with the dashboard port. */
const PORT_ARGUMENT = '--port';
/** Environment variable with the dashboard port. */
const PORT_VARIABLE = 'FLOTTI_PORT';
/**
 * What a running flotti leaves in the fleet directory for `flotti stop` to
 * find it. The leading dot keeps it out of the fleet: such entries are skipped.
 */
const RUN_FILE = '.flotti-run.json';
/** How long `flotti stop` waits for the agents to stop before it gives up. */
const STOP_TIMEOUT_MS = 30_000;
type RunRecord = {
    readonly pid: number;
    readonly url: string;
    /** Secret `flotti stop` shows to the server; the file is readable by its owner only. */
    readonly token: string;
    readonly startedAt: string;
};
type RunOptions = LoadFleetOptions & {
    /** Where the lines for a person go; `console.log` by default. */
    readonly print?: (line: string) => void;
    readonly dashboard?: DashboardOptions;
    readonly supervisor?: SupervisorOptions;
};
/** A fleet at work with its dashboard, and the way to stop both. */
type Running = {
    readonly url: string;
    readonly supervisor: Supervisor;
    /** Resolves once the dashboard is closed, the agents stopped and the run file gone. */
    readonly stopped: Promise<void>;
    stop(): Promise<void>;
};
function runFile(fleet: Fleet): string {
    return join(fleet.location.path, RUN_FILE);
}
function writeRecord(path: string, record: RunRecord): void {
    writeFileSync(path, `${JSON.stringify(record, null, 4)}\n`, { mode: 0o600 });
}
function readRecord(path: string): RunRecord | undefined {
    try {
        const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunRecord>;
        if (typeof record.pid === 'number' && typeof record.url === 'string' && typeof record.token === 'string') {
            return record as RunRecord;
        }
    } catch {
        // No file, or not ours to understand: nothing is running as far as we can tell.
    }
    return undefined;
}
function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}
/** The port the argument or the variable names, or the default one. */
function dashboardPort(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): number {
    const index = argv.findIndex((argument) => argument === PORT_ARGUMENT || argument.startsWith(`${PORT_ARGUMENT}=`));
    const argument = argv[index];
    const fromArgument = argument === undefined
        ? undefined
        : argument.includes('=') ? argument.slice(PORT_ARGUMENT.length + 1) : argv[index + 1];
    const value = fromArgument ?? env[PORT_VARIABLE];
    if (value === undefined || value.trim() === '') {
        return DEFAULT_PORT;
    }
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new ConfigurationError(
            'invalid-argument',
            `"${value}" is not a port: ${PORT_ARGUMENT} and ${PORT_VARIABLE} take a number from 0 to 65535`
        );
    }
    return port;
}
function describeListenError(error: unknown, port: number): Error {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        return new ConfigurationError('port-in-use', `Port ${port} is taken, so the dashboard cannot start.`, {
            hint: `Pick another one: ${PORT_ARGUMENT} <port> or ${PORT_VARIABLE}=<port>.`,
            cause: error
        });
    }
    return error as Error;
}
/** Refuses a second run of one fleet: two supervisors would start every agent twice. */
function claimFleet(fleet: Fleet): string {
    const path = runFile(fleet);
    const record = readRecord(path);
    if (record !== undefined && record.pid !== process.pid && isAlive(record.pid)) {
        throw new ConfigurationError(
            'already-running',
            `flotti already runs this fleet (process ${record.pid}, dashboard ${record.url}).`,
            { hint: 'Stop it first: flotti stop.' }
        );
    }
    mkdirSync(fleet.location.path, { recursive: true });
    return path;
}
/**
 * The run file of this run. It follows the fleet: when the settings page
 * points the run at another fleet directory, the file moves there, so
 * `flotti stop` finds the run by the directory it now works with.
 */
class RunFile {
    private record: RunRecord | undefined;
    constructor(private path: string, private readonly token: string) {}
    write(record: RunRecord): void {
        this.record = record;
        writeRecord(this.path, record);
    }
    /** @throws ConfigurationError when another flotti runs that fleet. */
    move(fleet: Fleet): void {
        const target = claimFleet(fleet);
        if (this.record !== undefined) {
            writeRecord(target, this.record);
        }
        this.remove();
        this.path = target;
    }
    /** Removes the file, unless it is not ours any more. */
    remove(): void {
        if (readRecord(this.path)?.token === this.token) {
            rmSync(this.path, { force: true });
        }
    }
}
/**
 * `flotti run`: reads the fleet, starts every agent, serves the dashboard on
 * localhost and writes the run file for `flotti stop`. Returns once the
 * dashboard listens; the agents keep starting in the background.
 */
async function runFleet(options: RunOptions = {}): Promise<Running> {
    const print = options.print ?? console.log;
    const argv = options.argv ?? process.argv.slice(2);
    const fleet = loadFleet(options);
    const created = prepareFleet(fleet);
    const port = options.dashboard?.port ?? dashboardPort(argv, options.env ?? process.env);
    const token = randomBytes(24).toString('hex');
    const file = new RunFile(claimFleet(fleet), token);
    const supervisor = new Supervisor(fleet, options.supervisor);
    const settings = new FleetSettings(fleet, supervisor, {
        env: options.env ?? process.env,
        onSwitch: (next) => file.move(next)
    });
    let requestStop = (): void => undefined;
    const dashboard = await startDashboard(supervisor, {
        host: DEFAULT_HOST,
        settings,
        ...options.dashboard,
        port,
        shutdown: { token, onRequest: () => requestStop() }
    }).catch((error: unknown) => {
        throw describeListenError(error, port);
    });
    file.write({ pid: process.pid, url: dashboard.url, token, startedAt: new Date().toISOString() });
    for (const line of created) {
        print(`Created ${line}`);
    }
    print(`${fleet.agents.length} agent(s) from ${fleet.location.path}.`);
    print(`Dashboard: ${dashboard.url}`);
    print('Stop with Ctrl+C, or flotti stop from another terminal.');
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => {
        stopping ??= (async () => {
            await dashboard.close();
            await supervisor.stop();
            file.remove();
        })();
        return stopping;
    };
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
    });
    requestStop = () => void stop().then(resolveStopped);
    void supervisor.start();
    return { url: dashboard.url, supervisor, stopped, stop: () => stop().then(resolveStopped) };
}
/** Waits until the process is gone; `false` when it outlived the timeout. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (isAlive(pid)) {
        if (Date.now() > until) {
            return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return true;
}
/**
 * `flotti stop`: asks the flotti that runs the fleet to stop its agents and
 * go, and waits until it has. Asks over the dashboard first, because a signal
 * on Windows kills at once and would leave the agents running; a signal is
 * the fallback when the dashboard does not answer.
 *
 * @returns Whether flotti is not running any more.
 */
async function stopFleet(options: RunOptions = {}): Promise<boolean> {
    const print = options.print ?? console.log;
    const fleet = loadFleet(options);
    const path = runFile(fleet);
    const record = readRecord(path);
    if (record === undefined || !isAlive(record.pid)) {
        rmSync(path, { force: true });
        print(`flotti is not running for ${fleet.location.path}.`);
        return true;
    }
    const asked = await fetch(new URL('/api/shutdown', record.url), {
        method: 'POST',
        headers: { 'x-flotti-stop': record.token },
        signal: AbortSignal.timeout(5000)
    }).then((response) => response.ok, () => false);
    if (!asked) {
        process.kill(record.pid, 'SIGTERM');
    }
    print(`Stopping flotti (process ${record.pid})…`);
    if (!(await waitForExit(record.pid, STOP_TIMEOUT_MS))) {
        print(`flotti (process ${record.pid}) is still running after ${STOP_TIMEOUT_MS / 1000} s.`);
        return false;
    }
    print('Stopped.');
    return true;
}
export { PORT_ARGUMENT, PORT_VARIABLE, RUN_FILE, dashboardPort, runFleet, stopFleet };
export type { RunOptions, Running };
