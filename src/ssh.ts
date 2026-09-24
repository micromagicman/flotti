import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { RemoteSsh } from './types.js';
/**
 * Reaching a remote agent through SSH, with nothing but the user's key: flotti
 * asks the host which agents it publishes (docs/a2a-ssh.md), opens a tunnel to
 * the one it wants on a free local port, and keeps the tunnel up.
 *
 * Everything goes through the `ssh` of this machine, so `~/.ssh/config`, the
 * agent with the keys and the known hosts are the user's own. It never asks
 * anything: a key that is not accepted is an error with a reason, not a
 * password prompt nobody sees.
 */
/** Where a host keeps what its agents publish for flotti, relative to the home of the SSH user. */
const PUBLISH_DIRECTORY = '.flotti/a2a';
/** How a user and a host are written: `user@host`, the host alone, or either with `:port`. */
const TARGET = /^(?:([A-Za-z0-9_][A-Za-z0-9._-]*)@)?([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?$/;
/** Ids a published agent may have: the file name, and later the agent directory. */
const PUBLISHED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Separates the published files in what the host prints: ASCII record separator, never raw in JSON. */
const RECORD_SEPARATOR = '\u001e';
/** How flotti runs `ssh`; tests put a pretend one in. */
type SshOptions = {
    /** Executable; `ssh` by default. */
    readonly command?: string;
    /** Arguments put before flotti's own, e.g. the script of a pretend ssh. */
    readonly prefix?: readonly string[];
    /** Seconds to wait for the host to answer; 10 by default. */
    readonly connectTimeoutSec?: number;
    /** How long the tunnel may take to come up; 20 s by default. */
    readonly readyTimeoutMs?: number;
};
/** Where to go: the `user@host` of the manifest, taken apart. */
type SshTarget = {
    /** `user@host` or `host`, as ssh takes it. */
    readonly destination: string;
    readonly host: string;
    readonly port?: number;
};
/** One agent a host publishes, as its file says. The token never leaves memory. */
type PublishedAgent = {
    /** The file name without `.json`. */
    readonly id: string;
    readonly name?: string;
    readonly description?: string;
    /** Where the agent listens, as seen from that host. */
    readonly url: string;
    /** Bearer token the agent expects; absent when it expects none. */
    readonly token?: string;
    /** The program that runs the agent, as it says itself: `claude`, `codex` or any other name. */
    readonly harness?: string;
};
/** SSH said no, with a reason a person can act on. */
class SshError extends Error {
    override readonly name = 'SshError';
}
/**
 * Takes `user@host[:port]` apart; refuses anything else — above all, anything
 * starting with `-`, which ssh would read as an option.
 */
function parseTarget(target: string): SshTarget {
    const match = TARGET.exec(target.trim());
    const port = match?.[3] === undefined ? undefined : Number(match[3]);
    if (match === null || (port !== undefined && (port < 1 || port > 65535))) {
        throw new SshError(`"${target}" is not an SSH address: write it as user@host, or user@host:port`);
    }
    const [, user, host] = match as unknown as [string, string | undefined, string];
    return { destination: user === undefined ? host : `${user}@${host}`, host, ...(port === undefined ? {} : { port }) };
}
/** Options every call shares: never ask anything, give up on a silent host. */
function commonArguments(target: SshTarget, options: SshOptions): string[] {
    return [
        '-o', 'BatchMode=yes',
        // First contact with a host takes its key and remembers it; a key that changed later is still refused.
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `ConnectTimeout=${options.connectTimeoutSec ?? 10}`,
        ...(target.port === undefined ? [] : ['-p', String(target.port)])
    ];
}
/**
 * The command the host runs to list what is published: every file of the
 * directory, each after a record separator and its name. POSIX sh only, and no
 * single quotes inside, so it survives whatever login shell the user has.
 */
const LIST_COMMAND = `sh -c 'for f in "$HOME"/${PUBLISH_DIRECTORY}/*.json; do [ -f "$f" ] || continue; `
    + `printf "\\036%s\\n" "\${f##*/}"; cat "$f"; done; exit 0'`;
/**
 * Asks the host which agents it publishes for flotti.
 *
 * @throws SshError saying why the host could not be asked, or what is wrong with a published file.
 */
async function discover(target: SshTarget, options: SshOptions = {}, signal?: AbortSignal): Promise<PublishedAgent[]> {
    const args = [...commonArguments(target, options), '--', target.destination, LIST_COMMAND];
    const { code, stdout, stderr } = await run(options.command ?? 'ssh', [...(options.prefix ?? []), ...args], signal);
    if (code !== 0) {
        throw new SshError(describeFailure(target, code, stderr));
    }
    return parsePublished(target, stdout);
}
function parsePublished(target: SshTarget, output: string): PublishedAgent[] {
    const agents: PublishedAgent[] = [];
    for (const record of output.split(RECORD_SEPARATOR).slice(1)) {
        const newline = record.indexOf('\n');
        const file = newline === -1 ? record : record.slice(0, newline);
        const where = `~/${PUBLISH_DIRECTORY}/${file} on ${target.destination}`;
        const id = file.replace(/\.json$/, '');
        if (!PUBLISHED_ID.test(id)) {
            throw new SshError(`${where}: the file name cannot be an agent id — use letters, digits, ".", "_" and "-"`);
        }
        let value: unknown;
        try {
            value = JSON.parse(newline === -1 ? '' : record.slice(newline + 1));
        } catch {
            throw new SshError(`${where} is not JSON`);
        }
        agents.push(publishedAgent(id, value, where));
    }
    return agents;
}
function publishedAgent(id: string, value: unknown, where: string): PublishedAgent {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new SshError(`${where} must be a JSON object`);
    }
    const fields = value as Record<string, unknown>;
    const url = publishedUrl(fields, where);
    const name = publishedText(fields, 'name', where);
    const description = publishedText(fields, 'description', where);
    const token = publishedText(fields, 'token', where);
    const harness = publishedText(fields, 'harness', where);
    return {
        id,
        url,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(token === undefined ? {} : { token }),
        ...(harness === undefined ? {} : { harness })
    };
}
/** A text field of a published file; `undefined` when it is absent. */
function publishedText(fields: Record<string, unknown>, field: string, where: string): string | undefined {
    const item = fields[field];
    if (item === undefined) {
        return undefined;
    }
    if (typeof item !== 'string' || item.trim() === '') {
        throw new SshError(`${where}: ${field} must be a non-empty string`);
    }
    return item;
}
/** The address a published file says its agent listens on: required, and http: or https:. */
function publishedUrl(fields: Record<string, unknown>, where: string): string {
    const url = publishedText(fields, 'url', where);
    if (url === undefined) {
        throw new SshError(`${where}: url is missing — the address the agent listens on, e.g. http://127.0.0.1:18741/`);
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new SshError(`${where}: url must be an http: address, got "${url}"`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new SshError(`${where}: url must be an http: address, got "${url}"`);
    }
    return url;
}
/**
 * Picks the agent the manifest means: the named one, or the only one there is.
 *
 * @throws SshError when there is no such agent, or several and none is named.
 */
function pickPublished(target: SshTarget, published: readonly PublishedAgent[], wanted?: string): PublishedAgent {
    const names = published.map((agent) => agent.id).join(', ');
    if (published.length === 0) {
        throw new SshError(
            `${target.destination} publishes no agent: ~/${PUBLISH_DIRECTORY}/ has no .json file. `
            + 'The A2A adapter of the agent writes one there when it starts (docs/a2a-ssh.md)'
        );
    }
    if (wanted !== undefined) {
        const found = published.find((agent) => agent.id === wanted);
        if (found === undefined) {
            throw new SshError(`${target.destination} does not publish "${wanted}"; it publishes ${names}`);
        }
        return found;
    }
    if (published.length > 1) {
        throw new SshError(`${target.destination} publishes several agents (${names}); name one in ssh.agent`);
    }
    return published[0] as PublishedAgent;
}
/** What `ssh` printed on failure, said so a person knows what to do. */
function describeFailure(target: SshTarget, code: number | null, stderr: string): string {
    const last = lastSaid(code, stderr);
    const host = target.host;
    const access = describeAccessFailure(target, stderr, last);
    if (access !== undefined) {
        return access;
    }
    if (/Connection refused|timed out|No route to host|Network is unreachable|Connection closed|Connection reset/i.test(stderr)) {
        return `Cannot reach ${host} over SSH (${last})`;
    }
    if (/forwarding failed|cannot listen|Address already in use/i.test(stderr)) {
        return `The SSH tunnel to ${host} could not be set up (${last})`;
    }
    return `SSH to ${target.destination} failed: ${last}`;
}
/** The last thing `ssh` said that is not a routine warning, or how it ended. */
function lastSaid(code: number | null, stderr: string): string {
    const said = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !/^Warning: Permanently added/.test(line));
    return said.at(-1) ?? (code === null ? 'ssh was stopped' : `ssh exited with code ${code}`);
}
/** A failure about which host it is and whether it lets the user in; `undefined` for any other. */
function describeAccessFailure(target: SshTarget, stderr: string, last: string): string | undefined {
    const host = target.host;
    if (/Permission denied/i.test(stderr)) {
        return `${target.destination} did not accept the SSH key: add your public key to ~/.ssh/authorized_keys `
            + `of that user on ${host} (${last})`;
    }
    if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(stderr)) {
        return `The host ${host} is not known: check the address (${last})`;
    }
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
        return `The host key of ${host} changed since the last time; if that is expected, remove the old one `
            + `with ssh-keygen -R ${host} (${last})`;
    }
    return undefined;
}
type RunResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };
function run(command: string, args: readonly string[], signal?: AbortSignal): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...(signal === undefined ? {} : { signal }) });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('error', (error: NodeJS.ErrnoException) => {
            reject(error.code === 'ENOENT'
                ? new SshError(`There is no "${command}" on this machine; flotti needs the OpenSSH client for remote agents over SSH`)
                : error);
        });
        child.on('close', (code) => resolve({
            code,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8')
        }));
    });
}
/** A port nobody listens on right now, on the loopback. */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            server.close(() => resolve(port));
        });
    });
}
function accepts(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });
}
/** `ssh -N -L` from a local port to the address the agent listens on, as the host sees it. */
function tunnelArguments(target: SshTarget, remote: URL, localPort: number, options: SshOptions): string[] {
    const remotePort = remote.port === '' ? (remote.protocol === 'https:' ? 443 : 80) : Number(remote.port);
    const remoteHost = remote.hostname.startsWith('[') ? remote.hostname.slice(1, -1) : remote.hostname;
    return [
        ...commonArguments(target, options),
        '-N',
        '-o', 'ExitOnForwardFailure=yes',
        // A host that stopped answering is noticed within 45 s, not at the next TCP timeout.
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-L', `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
        '--', target.destination
    ];
}
type TunnelListener = (reason: string) => void;
/** What became of `ssh` while the tunnel comes up: why it could not start, or why it went. */
type TunnelState = { failed?: Error; exited?: string };
/**
 * `ssh -N -L`: a local port on the loopback that leads to an address as the
 * host sees it. The tunnel says when it is gone — the host went away, the
 * network broke, ssh was killed — and does not come back by itself: that is
 * the job of whoever opened it.
 */
class SshTunnel {
    private child: ChildProcess | undefined;
    private closing = false;
    private stderr = '';
    private readonly listeners = new Set<TunnelListener>();
    private constructor(readonly localPort: number) {}
    /**
     * Opens the tunnel and resolves once the local port answers.
     *
     * @throws SshError saying why it could not be opened.
     */
    static async open(target: SshTarget, remote: URL, options: SshOptions = {}): Promise<SshTunnel> {
        const tunnel = new SshTunnel(await freePort());
        await tunnel.start(target, remote, options);
        return tunnel;
    }
    get open(): boolean {
        return this.child !== undefined && !this.closing;
    }
    /** Calls the listener once the tunnel is gone without being closed; returns the way to stop. */
    onClose(listener: TunnelListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    close(): Promise<void> {
        this.closing = true;
        this.listeners.clear();
        const child = this.child;
        this.child = undefined;
        if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            child.once('exit', () => resolve());
            child.kill();
        });
    }
    private async start(target: SshTarget, remote: URL, options: SshOptions): Promise<void> {
        const child = this.spawnSsh(target, remote, options);
        const state = this.watch(child, target, options);
        const deadline = Date.now() + (options.readyTimeoutMs ?? 20_000);
        await this.waitReady(target, deadline, state);
    }
    /** Starts `ssh -N -L` and keeps the tail of what it says. */
    private spawnSsh(target: SshTarget, remote: URL, options: SshOptions): ChildProcess {
        const args = tunnelArguments(target, remote, this.localPort, options);
        const child = spawn(options.command ?? 'ssh', [...(options.prefix ?? []), ...args], {
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true
        });
        this.child = child;
        child.stderr?.on('data', (chunk: Buffer) => {
            // The last few lines are all a reason needs.
            this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4_000);
        });
        return child;
    }
    /** Notes why ssh could not start or why it went, and tells the listeners when the tunnel is gone. */
    private watch(child: ChildProcess, target: SshTarget, options: SshOptions): TunnelState {
        const state: TunnelState = {};
        child.once('error', (error: NodeJS.ErrnoException) => {
            state.failed = error.code === 'ENOENT'
                ? new SshError(`There is no "${options.command ?? 'ssh'}" on this machine; flotti needs the OpenSSH client for remote agents over SSH`)
                : error;
        });
        child.once('exit', (code) => {
            state.exited = describeFailure(target, code, this.stderr);
            this.gone(child, state.exited);
        });
        return state;
    }
    /** Tells the listeners the tunnel is gone, unless it was closed or replaced. */
    private gone(child: ChildProcess, reason: string): void {
        if (this.child === child && !this.closing) {
            this.child = undefined;
            for (const listener of [...this.listeners]) {
                listener(reason);
            }
        }
    }
    /** Resolves once the local port answers; throws when ssh failed, went or took too long. */
    private async waitReady(target: SshTarget, deadline: number, state: TunnelState): Promise<void> {
        for (;;) {
            if (state.failed !== undefined) {
                await this.close();
                throw state.failed;
            }
            if (state.exited !== undefined) {
                this.closing = true;
                throw new SshError(state.exited);
            }
            if (await accepts(this.localPort)) {
                return;
            }
            if (Date.now() >= deadline) {
                await this.close();
                throw new SshError(`The SSH tunnel to ${target.host} did not come up in time`);
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
}
/** What a process started over SSH is: the command and how it is run on the host. */
type RemoteCommand = {
    readonly command: string;
    readonly arguments: readonly string[];
    /** Variables set for the command on the host; the environment of flotti stays here. */
    readonly env: Readonly<Record<string, string>>;
    /** Working directory on the host: absolute, relative to the home directory, or starting with `~`. */
    readonly workdir: string;
    /** A port of this machine the host gets a way back to, through a reverse tunnel. */
    readonly reversePort?: number;
};
/** Marks the line on which the host says where the command runs. */
const CWD_MARKER = `${RECORD_SEPARATOR}flotti-cwd `;
/** What ssh says once the host has given the reverse tunnel a port. */
const ALLOCATED_PORT = /^Allocated port (\d+) for remote forward/;
/** Quoted for a POSIX shell: `'…'`, with every `'` inside closed, escaped and opened again. */
function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
/** `cd` to the working directory: `~` stays the home directory of the SSH user, whatever it is called there. */
function changeDirectory(workdir: string): string {
    if (workdir === '~') {
        return 'cd "$HOME"';
    }
    if (workdir.startsWith('~/')) {
        return `cd "$HOME"/${shellQuote(workdir.slice(2))}`;
    }
    return `cd ${shellQuote(workdir)}`;
}
/**
 * The arguments of `ssh` that start a command on the host with its standard
 * streams wired to this side — no terminal, so ACP goes through untouched —
 * and, with `reversePort`, a reverse tunnel from a port the host picks to that
 * port here. Before the command, the host prints where it runs: ACP wants an
 * absolute working directory, and `~` is known only there.
 */
function remoteCommandArguments(target: SshTarget, remote: RemoteCommand, options: SshOptions = {}): string[] {
    const environment = Object.entries(remote.env).map(([name, value]) => `${name}=${value}`);
    const run = [remote.command, ...remote.arguments].map(shellQuote).join(' ');
    const script = `${changeDirectory(remote.workdir)} || exit 97; `
        + `printf "\\036flotti-cwd %s\\n" "$PWD" >&2; `
        + `exec ${environment.length === 0 ? '' : `env ${environment.map(shellQuote).join(' ')} `}${run}`;
    return [
        ...commonArguments(target, options),
        '-T',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        ...(remote.reversePort === undefined
            ? []
            : ['-o', 'ExitOnForwardFailure=yes', '-R', `0:127.0.0.1:${remote.reversePort}`]),
        '--', target.destination,
        `sh -c ${shellQuote(script)}`
    ];
}
/** Where the command runs on the host, and the port of the reverse tunnel there. */
type RemotePlace = { readonly cwd: string; readonly reversePort?: number };
/**
 * Reads what ssh and the host say on standard error while the command starts:
 * the working directory and the port of the reverse tunnel. Every other line
 * is the command's own.
 */
class RemoteStartReader {
    private buffer = '';
    private cwd: string | undefined;
    private port: number | undefined;
    constructor(private readonly wantsPort: boolean) {}
    /** Everything is known. */
    get place(): RemotePlace | undefined {
        if (this.cwd === undefined || (this.wantsPort && this.port === undefined)) {
            return undefined;
        }
        return { cwd: this.cwd, ...(this.port === undefined ? {} : { reversePort: this.port }) };
    }
    /** Takes a piece of standard error; returns the whole lines that are not about the start. */
    read(chunk: string): string[] {
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? '';
        return lines.filter((line) => !this.take(line));
    }
    private take(line: string): boolean {
        if (line.startsWith(CWD_MARKER)) {
            this.cwd = line.slice(CWD_MARKER.length);
            return true;
        }
        const allocated = ALLOCATED_PORT.exec(line);
        if (allocated !== null) {
            this.port = Number(allocated[1]);
            return true;
        }
        return false;
    }
}
/** What a connection gives the A2A client: where to go, and how to prove itself there. */
type RemoteEndpoint = {
    /** Address of the agent, as the agent itself knows it. */
    readonly url: string;
    /** Headers that prove flotti to the agent; the manifest's own `auth` when absent. */
    readonly headers?: Readonly<Record<string, string>>;
    /** Where a request to this address really goes; `undefined` leaves it as it is. */
    readonly rewrite?: (url: URL) => URL | undefined;
    /** The harness the agent published of itself; absent when it did not say. */
    readonly harness?: string;
};
/**
 * The way to a remote agent that has to be opened first and may break: the
 * A2A client opens it before it reads the card, and opens it again when it
 * says it dropped.
 */
interface RemoteConnection {
    /** Opens the way, or hands back the one that is open; rejects saying why it cannot. */
    open(signal: AbortSignal): Promise<RemoteEndpoint>;
    /** Calls the listener when an open way breaks by itself; returns the way to stop. */
    onDrop(listener: (reason: string) => void): () => void;
    close(): Promise<void>;
}
function isLoopback(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
}
/**
 * The endpoint of a published agent reached down a tunnel: its own address,
 * with every request to that address sent to the local port instead.
 */
function tunnelEndpoint(published: PublishedAgent, remote: URL, localPort: number): RemoteEndpoint {
    const local = `127.0.0.1:${localPort}`;
    return {
        url: published.url,
        ...(published.token === undefined ? {} : { headers: { Authorization: `Bearer ${published.token}` } }),
        ...(published.harness === undefined ? {} : { harness: published.harness }),
        rewrite: (url: URL) => {
            const sameHost = url.hostname === remote.hostname || (isLoopback(url.hostname) && isLoopback(remote.hostname));
            if (!sameHost || url.port !== remote.port || url.protocol !== remote.protocol) {
                return undefined;
            }
            const moved = new URL(url.href);
            moved.protocol = 'http:';
            moved.host = local;
            return moved;
        }
    };
}
/**
 * A remote agent reached over SSH: asks the host what it publishes, opens the
 * tunnel to the agent and sends every request to the agent's address — the
 * one its card names too — down the tunnel instead.
 */
class SshConnection implements RemoteConnection {
    private readonly target: SshTarget;
    private tunnel: SshTunnel | undefined;
    private endpoint: RemoteEndpoint | undefined;
    private readonly listeners = new Set<(reason: string) => void>();
    constructor(private readonly access: RemoteSsh,private readonly options: SshOptions = {}) {
        this.target = parseTarget(access.target);
    }
    async open(signal: AbortSignal): Promise<RemoteEndpoint> {
        if (this.tunnel?.open === true && this.endpoint !== undefined) {
            return this.endpoint;
        }
        await this.close();
        const published = pickPublished(this.target, await discover(this.target, this.options, signal), this.access.agent);
        const remote = new URL(published.url);
        const tunnel = await SshTunnel.open(this.target, remote, this.options);
        if (signal.aborted) {
            await tunnel.close();
            throw new Error('the connection was closed while the SSH tunnel was being opened');
        }
        const endpoint = tunnelEndpoint(published, remote, tunnel.localPort);
        this.watch(tunnel);
        this.tunnel = tunnel;
        this.endpoint = endpoint;
        return endpoint;
    }
    /** Tells the listeners when the tunnel, while it is still this connection's, drops by itself. */
    private watch(tunnel: SshTunnel): void {
        tunnel.onClose((reason: string) => {
            if (this.tunnel !== tunnel) {
                return;
            }
            this.tunnel = undefined;
            this.endpoint = undefined;
            for (const listener of [...this.listeners]) {
                listener(`the SSH tunnel dropped: ${reason}`);
            }
        });
    }
    onDrop(listener: (reason: string) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    async close(): Promise<void> {
        const tunnel = this.tunnel;
        this.tunnel = undefined;
        this.endpoint = undefined;
        await tunnel?.close();
    }
}
export {
    PUBLISH_DIRECTORY,
    RemoteStartReader,
    remoteCommandArguments,
    shellQuote,
    SshConnection,
    SshError,
    SshTunnel,
    describeFailure,
    discover,
    parsePublished,
    parseTarget,
    pickPublished
};
export type { PublishedAgent, RemoteCommand, RemoteConnection, RemoteEndpoint, RemotePlace, SshOptions, SshTarget };
