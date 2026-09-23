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
    const text = (field: string): string | undefined => {
        const item = fields[field];
        if (item === undefined) {
            return undefined;
        }
        if (typeof item !== 'string' || item.trim() === '') {
            throw new SshError(`${where}: ${field} must be a non-empty string`);
        }
        return item;
    };
    const url = text('url');
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
    const name = text('name');
    const description = text('description');
    const token = text('token');
    return {
        id,
        url,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(token === undefined ? {} : { token })
    };
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
    const said = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !/^Warning: Permanently added/.test(line));
    const last = said.at(-1) ?? (code === null ? 'ssh was stopped' : `ssh exited with code ${code}`);
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
    if (/Connection refused|timed out|No route to host|Network is unreachable|Connection closed|Connection reset/i.test(stderr)) {
        return `Cannot reach ${host} over SSH (${last})`;
    }
    if (/forwarding failed|cannot listen|Address already in use/i.test(stderr)) {
        return `The SSH tunnel to ${host} could not be set up (${last})`;
    }
    return `SSH to ${target.destination} failed: ${last}`;
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
        let exited: string | undefined;
        let failed: Error | undefined;
        child.once('error', (error: NodeJS.ErrnoException) => {
            failed = error.code === 'ENOENT'
                ? new SshError(`There is no "${options.command ?? 'ssh'}" on this machine; flotti needs the OpenSSH client for remote agents over SSH`)
                : error;
        });
        child.once('exit', (code) => {
            exited = describeFailure(target, code, this.stderr);
            if (this.child === child && !this.closing) {
                this.child = undefined;
                for (const listener of [...this.listeners]) {
                    listener(exited);
                }
            }
        });
        const deadline = Date.now() + (options.readyTimeoutMs ?? 20_000);
        for (;;) {
            if (failed !== undefined) {
                await this.close();
                throw failed;
            }
            if (exited !== undefined) {
                this.closing = true;
                throw new SshError(exited);
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
/** What a connection gives the A2A client: where to go, and how to prove itself there. */
type RemoteEndpoint = {
    /** Address of the agent, as the agent itself knows it. */
    readonly url: string;
    /** Headers that prove flotti to the agent; the manifest's own `auth` when absent. */
    readonly headers?: Readonly<Record<string, string>>;
    /** Where a request to this address really goes; `undefined` leaves it as it is. */
    readonly rewrite?: (url: URL) => URL | undefined;
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
        const local = `127.0.0.1:${tunnel.localPort}`;
        const endpoint: RemoteEndpoint = {
            url: published.url,
            ...(published.token === undefined ? {} : { headers: { Authorization: `Bearer ${published.token}` } }),
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
        this.tunnel = tunnel;
        this.endpoint = endpoint;
        return endpoint;
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
    SshConnection,
    SshError,
    SshTunnel,
    describeFailure,
    discover,
    parsePublished,
    parseTarget,
    pickPublished
};
export type { PublishedAgent, RemoteConnection, RemoteEndpoint, SshOptions, SshTarget };
