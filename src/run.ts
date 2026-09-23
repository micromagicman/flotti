import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigurationError } from './errors.js';
import { DEFAULT_HOST, DEFAULT_PORT, startDashboard } from './dashboard-server.js';
import type { DashboardOptions } from './dashboard-server.js';
import type { AgentSummary } from './dashboard-protocol.js';
import { loadFleet, prepareFleet } from './fleet.js';
import { FleetMcpServer } from './fleet-mcp.js';
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
/**
 * Where the flotti that `flotti start` puts in the background writes what
 * `flotti run` would print to the terminal. Rewritten on every start.
 */
const LOG_FILE = '.flotti.log';
/** How long `flotti stop` waits for the agents to stop before it gives up. */
const STOP_TIMEOUT_MS = 30_000;
/** How long `flotti start` waits for the dashboard to listen before it gives up. */
const START_TIMEOUT_MS = 30_000;
/** How long `flotti status` and `flotti stop` wait for the dashboard to answer. */
const ASK_TIMEOUT_MS = 5000;
type RunRecord = {
    readonly pid: number;
    readonly url: string;
    /** Secret `flotti stop` shows to the server; the file is readable by its owner only. */
    readonly token: string;
    readonly startedAt: string;
};
type RunOptions = LoadFleetOptions & {
    /** The CLI script `flotti start` runs in the background as `flotti run`. */
    readonly entry?: string;
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
    const tools = await FleetMcpServer.start();
    const supervisor = new Supervisor(fleet, { persistHistory: true, fleetTools: tools, ...options.supervisor });
    tools.serve(supervisor);
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
    }).catch((error: unknown) => tools.close().then(() => {
        throw describeListenError(error, port);
    }));
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
            await tools.close();
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
        signal: AbortSignal.timeout(ASK_TIMEOUT_MS)
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
/** The flotti that runs the fleet, if one does. */
function runningRecord(fleet: Fleet): RunRecord | undefined {
    const record = readRecord(runFile(fleet));
    return record !== undefined && isAlive(record.pid) ? record : undefined;
}
function readFrom(path: string): string {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return '';
    }
}
/**
 * `flotti start`: runs `flotti run` in the background, detached from the
 * terminal, and returns once its dashboard listens. A fleet that is already
 * run is left as it is: start says so and names its dashboard.
 *
 * @returns Whether the fleet runs now.
 */
async function startFleet(options: RunOptions = {}): Promise<boolean> {
    const print = options.print ?? console.log;
    const argv = options.argv ?? process.argv.slice(2);
    const env = options.env ?? process.env;
    const fleet = loadFleet(options);
    // What `run` would refuse is refused here, in the terminal, rather than in the log.
    dashboardPort(argv, env);
    const running = runningRecord(fleet);
    if (running !== undefined) {
        print(`flotti already runs this fleet (process ${running.pid}).`);
        print(`Dashboard: ${running.url}`);
        return true;
    }
    if (options.entry === undefined) {
        throw new Error('flotti start needs the CLI script to run in the background.');
    }
    mkdirSync(fleet.location.path, { recursive: true });
    const log = join(fleet.location.path, LOG_FILE);
    const output = openSync(log, 'w');
    const child = spawn(process.execPath, [options.entry, 'run', ...argv], {
        detached: true,
        stdio: ['ignore', output, output],
        env,
        windowsHide: true
    });
    closeSync(output);
    return await waitForStart(child, fleet, log, print);
}
/** Waits for the flotti `start` put in the background to open its dashboard, and says how it went. */
async function waitForStart(child: ChildProcess, fleet: Fleet, log: string, print: (line: string) => void): Promise<boolean> {
    let exited: number | null | undefined;
    child.once('exit', (code) => (exited = code));
    child.once('error', () => (exited ??= null));
    child.unref();
    const until = Date.now() + START_TIMEOUT_MS;
    for (;;) {
        const record = readRecord(runFile(fleet));
        if (record !== undefined && record.pid === child.pid) {
            for (const line of readFrom(log).split('\n').filter((entry) => entry.startsWith('Created '))) {
                print(line);
            }
            print(`flotti runs in the background (process ${record.pid}): ${fleet.agents.length} agent(s) from ${fleet.location.path}.`);
            print(`Dashboard: ${record.url}`);
            print(`Log: ${log}`);
            print('flotti status lists the agents, flotti stop stops them.');
            return true;
        }
        if (exited !== undefined) {
            print(readFrom(log).trimEnd() || `flotti did not start (exit code ${exited}).`);
            return false;
        }
        if (Date.now() > until) {
            print(`flotti (process ${child.pid}) has not opened the dashboard in ${START_TIMEOUT_MS / 1000} s; see ${log}.`);
            return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
/** Rows of text with the columns lined up. */
function table(rows: readonly (readonly string[])[]): string[] {
    const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
    return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd());
}
/**
 * `flotti status`: lists every agent of the fleet that runs, as its dashboard
 * sees it — id, local or remote, harness, status.
 *
 * @returns Whether the fleet runs.
 */
async function fleetStatus(options: RunOptions = {}): Promise<boolean> {
    const print = options.print ?? console.log;
    const fleet = loadFleet(options);
    const record = runningRecord(fleet);
    if (record === undefined) {
        print(`flotti is not running for ${fleet.location.path}.`);
        return false;
    }
    const agents = await fetch(new URL('/api/agents', record.url), { signal: AbortSignal.timeout(ASK_TIMEOUT_MS) })
        .then((response) => (response.ok ? response.json() as Promise<AgentSummary[]> : undefined), () => undefined);
    if (agents === undefined) {
        print(`flotti runs this fleet (process ${record.pid}), but its dashboard ${record.url} does not answer.`);
        return false;
    }
    print(`flotti runs ${fleet.location.path} (process ${record.pid}), dashboard ${record.url}`);
    print('');
    if (agents.length === 0) {
        print('No agents in the fleet.');
        return true;
    }
    const rows = agents.map((agent) => [agent.id, agent.kind, agent.harness ?? '-', agent.status]);
    for (const line of table([['ID', 'TYPE', 'HARNESS', 'STATUS'], ...rows])) {
        print(line);
    }
    return true;
}
export { LOG_FILE, PORT_ARGUMENT, PORT_VARIABLE, RUN_FILE, dashboardPort, fleetStatus, runFleet, startFleet, stopFleet };
export type { RunOptions, Running };
