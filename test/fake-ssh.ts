/**
 * A pretend `ssh` for the tests, run as `node fake-ssh.js <config.json> <ssh arguments…>`.
 *
 * - With a command, it runs the command with `sh` in a pretend home directory,
 *   as the host would: what flotti asks the host is tested for real.
 * - With `-N -L 127.0.0.1:<port>:<host>:<port>`, it forwards the local port to
 *   the far port on this machine — whatever host is named, as if it were
 *   resolved on the far side — and writes its process id down, so a test can
 *   kill the tunnel.
 * - With `-R 0:127.0.0.1:<port>` and a command, it opens a port of its own
 *   that leads to that port, says so on stderr as ssh does — "Allocated port N
 *   for remote forward" — and runs the command with its standard streams.
 * - With `refuse` in the config, it says that on stderr and exits with 255,
 *   the way ssh fails.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
type FakeSshConfig = {
    /** Home directory of the pretend host. */
    readonly home: string;
    /** Where the tunnels write their process ids, one per line. */
    readonly pids: string;
    /** Where the tunnels write a line for every connection they forward. */
    readonly forwarded: string;
    /** What ssh says on stderr before it fails, when it should. */
    readonly refuse?: string;
};
const [configPath, ...args] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath ?? '', 'utf8')) as FakeSshConfig;
if (config.refuse !== undefined) {
    process.stderr.write(`${config.refuse}\n`);
    process.exit(255);
}
/** A port of this machine that leads to `port`: what either end of a tunnel looks like here. */
function forwarder(port: number) {
    return createServer((incoming) => {
        appendFileSync(config.forwarded, 'connection\n');
        const outgoing = connect({ host: '127.0.0.1', port });
        incoming.pipe(outgoing).pipe(incoming);
        const close = () => {
            incoming.destroy();
            outgoing.destroy();
        };
        incoming.on('error', close);
        outgoing.on('error', close);
    });
}
function runCommand(): void {
    const command = args.at(-1) ?? '';
    // Like sshd: the host has an environment of its own, and nothing of the caller's comes along.
    const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: config.home };
    const child = spawn('sh', ['-c', command], { env, stdio: 'inherit' });
    child.on('close', (code) => process.exit(code ?? 1));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
}
if (args.includes('-N')) {
    const forward = args[args.indexOf('-L') + 1] ?? '';
    const [, localPort, , remotePort] = forward.split(':');
    forwarder(Number(remotePort)).listen(Number(localPort), '127.0.0.1', () => {
        appendFileSync(config.pids, `${process.pid}\n`);
    });
    process.on('SIGTERM', () => process.exit(0));
} else if (args.includes('-R')) {
    const [, , herePort] = (args[args.indexOf('-R') + 1] ?? '').split(':');
    const server = forwarder(Number(herePort));
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        process.stderr.write(`Allocated port ${port} for remote forward to 127.0.0.1:${herePort}\n`);
        runCommand();
    });
} else {
    runCommand();
}
