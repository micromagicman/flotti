import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type {
    BroadcastResponse,
    ClientMessage,
    ErrorResponse,
    PermissionAnswer,
    SendRequest,
    ServerMessage
} from './dashboard-protocol.js';
import { ConfigurationError } from './errors.js';
import type { FleetSettings } from './fleet-settings.js';
import { UnknownAgentError } from './supervisor.js';
import type { Supervisor, SupervisorNotice } from './supervisor.js';
/** Port the dashboard listens on unless told otherwise. */
const DEFAULT_PORT = 4870;
/** Only this machine: the dashboard has no login (decision 4 of the epic). */
const DEFAULT_HOST = '127.0.0.1';
/** Where `npm run build` puts the page: `build/web`, next to the compiled server. */
const DEFAULT_WEB_ROOT = fileURLToPath(new URL('./web/', import.meta.url));
/** A message is text a person typed; a megabyte is far more than that. */
const MAX_BODY_BYTES = 1024 * 1024;
const CONTENT_TYPES: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8'
};
type DashboardOptions = {
    readonly host?: string;
    /** `0` picks a free port. */
    readonly port?: number;
    /** Directory with the built page; `build/web` by default. */
    readonly webRoot?: string;
    /**
     * `flotti stop` asks the server to go away with `POST /api/shutdown` and
     * this secret in the `x-flotti-stop` header; without one there is no such route.
     */
    readonly shutdown?: { readonly token: string; readonly onRequest: () => void };
    /** What the settings page changes; without it the page can only look at the fleet, not change it. */
    readonly settings?: FleetSettings;
};
/** A running dashboard. */
type Dashboard = {
    /** Address to open in a browser. */
    readonly url: string;
    readonly port: number;
    /** Tells the pages it is going away, closes their sockets and stops listening. */
    close(): Promise<void>;
};
/** A request that cannot be served, with the status code that says why. */
class HttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
/** What a route works with: the running fleet and, when there is one, the settings of it. */
type Context = { readonly supervisor: Supervisor; readonly settings: FleetSettings | undefined };
type Route = {
    readonly method: Method;
    readonly pattern: RegExp;
    readonly handle: (context: Context, match: string[], body: unknown) => Promise<[number, unknown]>;
};
function requireSettings(context: Context): FleetSettings {
    if (context.settings === undefined) {
        throw new HttpError(404, 'This dashboard cannot change the fleet.');
    }
    return context.settings;
}
/**
 * Every action of the page. A start or a restart answers at once: it may
 * take a minute for a remote agent, and the page follows it by the status
 * events anyway.
 */
const ROUTES: readonly Route[] = [
    {
        method: 'GET',
        pattern: /^\/api\/agents$/,
        handle: async ({ supervisor }) => [200, supervisor.agents()]
    },
    {
        method: 'POST',
        pattern: /^\/api\/agents$/,
        handle: async (context, _match, body) => [201, requireSettings(context).create(body)]
    },
    {
        method: 'GET',
        pattern: /^\/api\/agents\/([^/]+)$/,
        handle: async (context, [id]) => [200, requireSettings(context).config(id ?? '')]
    },
    {
        method: 'PUT',
        pattern: /^\/api\/agents\/([^/]+)$/,
        handle: async (context, [id], body) => [200, await requireSettings(context).update(id ?? '', body)]
    },
    {
        method: 'DELETE',
        pattern: /^\/api\/agents\/([^/]+)$/,
        handle: async (context, [id]) => {
            const trash = await requireSettings(context).remove(id ?? '');
            return [200, trash === undefined ? {} : { trash }];
        }
    },
    {
        method: 'GET',
        pattern: /^\/api\/fleet$/,
        handle: async (context) => [200, requireSettings(context).info()]
    },
    {
        method: 'PUT',
        pattern: /^\/api\/fleet$/,
        handle: async (context, _match, body) => [200, await requireSettings(context).switchTo(body)]
    },
    {
        method: 'POST',
        pattern: /^\/api\/agents\/([^/]+)\/messages$/,
        handle: async ({ supervisor }, [id], body) => [200, await supervisor.send(id ?? '', messageText(body))]
    },
    {
        method: 'POST',
        pattern: /^\/api\/broadcast$/,
        handle: async ({ supervisor }, _match, body) => {
            const deliveries = await supervisor.broadcast(messageText(body), broadcastTargets(body));
            return [200, { deliveries } satisfies BroadcastResponse];
        }
    },
    {
        method: 'POST',
        pattern: /^\/api\/agents\/([^/]+)\/cancel$/,
        handle: async ({ supervisor }, [id]) => {
            await supervisor.cancel(id ?? '');
            return [200, {}];
        }
    },
    {
        method: 'POST',
        pattern: /^\/api\/agents\/([^/]+)\/restart$/,
        handle: async ({ supervisor }, [id]) => {
            void supervisor.restart(id ?? '').catch(() => undefined);
            return [202, {}];
        }
    },
    {
        method: 'POST',
        pattern: /^\/api\/agents\/([^/]+)\/start$/,
        handle: async ({ supervisor }, [id]) => {
            void supervisor.startAgent(id ?? '').catch(() => undefined);
            return [202, {}];
        }
    },
    {
        method: 'POST',
        pattern: /^\/api\/agents\/([^/]+)\/stop$/,
        handle: async ({ supervisor }, [id]) => {
            await supervisor.stopAgent(id ?? '');
            return [200, {}];
        }
    },
    {
        method: 'POST',
        pattern: /^\/api\/agents\/([^/]+)\/permissions\/([^/]+)$/,
        handle: async ({ supervisor }, [id, requestId], body) => {
            const { optionId } = (body ?? {}) as PermissionAnswer;
            if (!supervisor.answerPermission(id ?? '', requestId ?? '', typeof optionId === 'string' ? optionId : undefined)) {
                throw new HttpError(404, 'No such permission request is waiting.');
            }
            return [200, {}];
        }
    }
];
function messageText(body: unknown): string {
    const { text } = (body ?? {}) as Partial<SendRequest>;
    if (typeof text !== 'string' || text.trim() === '') {
        throw new HttpError(400, 'The message is empty.');
    }
    return text;
}
function broadcastTargets(body: unknown): string[] | undefined {
    const { agents } = (body ?? {}) as Partial<SendRequest>;
    if (agents === undefined) {
        return undefined;
    }
    if (!Array.isArray(agents) || agents.some((id) => typeof id !== 'string')) {
        throw new HttpError(400, '"agents" must be a list of agent ids.');
    }
    if (agents.length === 0) {
        throw new HttpError(400, 'Pick at least one agent.');
    }
    return agents;
}
/**
 * Hosts the page may be reached by. Anything else is refused: a web page from
 * elsewhere could otherwise point a name of its own at 127.0.0.1 (DNS
 * rebinding) and drive the fleet, since there is no login.
 */
function allowedHosts(host: string, port: number): Set<string> {
    const names = new Set([host, '127.0.0.1', 'localhost', '[::1]']);
    return new Set([...names].map((name) => `${name}:${port}`));
}
function send(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
}
function readBody(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        request.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new HttpError(413, 'The request is too large.'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            try {
                resolve(text === '' ? undefined : JSON.parse(text));
            } catch {
                reject(new HttpError(400, 'The request body is not JSON.'));
            }
        });
        request.on('error', reject);
    });
}
async function handleApi(context: Context, request: IncomingMessage, path: string): Promise<[number, unknown]> {
    const matching = ROUTES.map((candidate) => ({ candidate, match: candidate.pattern.exec(path) }))
        .filter(({ match }) => match !== null);
    if (matching.length === 0) {
        throw new HttpError(404, `Nothing at ${path}.`);
    }
    const route = matching.find(({ candidate }) => candidate.method === request.method);
    if (route === undefined || route.match === null) {
        throw new HttpError(405, `Use ${matching.map(({ candidate }) => candidate.method).join(' or ')}.`);
    }
    // A JSON body cannot come from a plain HTML form of another site, nor
    // cross-site without a preflight this server never answers.
    if (request.method !== 'GET' && !(request.headers['content-type'] ?? '').startsWith('application/json')) {
        throw new HttpError(415, 'Send the body as application/json.');
    }
    const body = request.method === 'GET' ? undefined : await readBody(request);
    const match = route.match.slice(1).map((part) => decodeURIComponent(part));
    return route.candidate.handle(context, match, body);
}
/** Serves a file of the built page; any other path gets `index.html`, the page routes itself. */
async function serveStatic(webRoot: string, path: string, response: ServerResponse): Promise<void> {
    const relative = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    const file = join(webRoot, relative);
    const inside = file.startsWith(webRoot.endsWith(sep) ? webRoot : webRoot + sep);
    const extension = extname(file);
    const target = inside && extension !== '' ? file : join(webRoot, 'index.html');
    try {
        const contents = await readFile(target);
        const type = CONTENT_TYPES[extname(target)] ?? 'application/octet-stream';
        response.writeHead(200, { 'content-type': type });
        response.end(contents);
    } catch {
        if (extname(target) === '.html') {
            response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
            response.end(`The dashboard page is not built: ${target} is missing. Run npm run build.`);
            return;
        }
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found.');
    }
}
function errorResponse(error: unknown): [number, ErrorResponse] {
    if (error instanceof HttpError) {
        return [error.status, { error: error.message }];
    }
    if (error instanceof UnknownAgentError) {
        return [404, { error: error.message }];
    }
    if (error instanceof ConfigurationError) {
        const status = error.kind === 'duplicate-agent-id' || error.kind === 'already-running' ? 409 : 400;
        return [status, { error: error.hint === undefined ? error.message : `${error.message} ${error.hint}` }];
    }
    return [500, { error: error instanceof Error ? error.message : String(error) }];
}
/** Whether this is `flotti stop` asking, with the secret of this very run. */
function isShutdown(request: IncomingMessage, path: string, options: DashboardOptions): boolean {
    return path === '/api/shutdown'
        && request.method === 'POST'
        && options.shutdown !== undefined
        && request.headers['x-flotti-stop'] === options.shutdown.token;
}
function requestHandler(supervisor: Supervisor, hosts: Set<string>, options: DashboardOptions & { webRoot: string }) {
    const { webRoot } = options;
    return (request: IncomingMessage, response: ServerResponse): void => {
        if (!hosts.has(request.headers.host ?? '')) {
            send(response, 421, { error: 'The dashboard answers on localhost only.' });
            return;
        }
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (isShutdown(request, path, options)) {
            send(response, 202, {});
            options.shutdown?.onRequest();
            return;
        }
        if (!path.startsWith('/api/')) {
            void serveStatic(webRoot, path, response);
            return;
        }
        handleApi({ supervisor, settings: options.settings }, request, path).then(
            ([status, body]) => send(response, status, body),
            (error: unknown) => send(response, ...errorResponse(error))
        );
    };
}
function post(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(message));
    }
}
/**
 * One page on the socket: the fleet first, then — once the page says what it
 * has seen — the events it missed, then everything live. Live events that come
 * before the page asked are held back so that nothing arrives twice or out
 * of order.
 */
function attachPage(supervisor: Supervisor, socket: WebSocket): () => void {
    let caughtUp = false;
    const held: SupervisorNotice[] = [];
    const deliver = (notice: SupervisorNotice): void => post(socket, notice);
    const unsubscribe = supervisor.subscribe((notice) => (caughtUp ? deliver(notice) : held.push(notice)));
    post(socket, { type: 'fleet', agents: supervisor.agents() });
    socket.on('message', (data) => {
        let message: ClientMessage;
        try {
            message = JSON.parse(String(data)) as ClientMessage;
        } catch {
            return;
        }
        if (message.type !== 'subscribe' || caughtUp) {
            return;
        }
        const last = new Map<string, number>();
        for (const agent of supervisor.agents()) {
            const since = Number(message.since?.[agent.id] ?? 0);
            for (const event of supervisor.history(agent.id, since)) {
                post(socket, { type: 'event', event });
                last.set(agent.id, event.seq);
            }
        }
        caughtUp = true;
        for (const notice of held.splice(0)) {
            if (notice.type !== 'event' || notice.event.seq > (last.get(notice.event.agentId) ?? 0)) {
                deliver(notice);
            }
        }
    });
    socket.on('close', unsubscribe);
    return unsubscribe;
}
function hostOf(origin: string): string {
    try {
        return new URL(origin).host;
    } catch {
        return '';
    }
}
function upgradeHandler(supervisor: Supervisor, hosts: Set<string>, sockets: WebSocketServer) {
    return (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        // Browsers let any site open a socket to localhost; the Origin header is what tells them apart.
        const origin = request.headers.origin;
        if (path !== '/ws' || !hosts.has(request.headers.host ?? '') || (origin !== undefined && !hosts.has(hostOf(origin)))) {
            socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
        }
        sockets.handleUpgrade(request, socket, head, (page) => {
            attachPage(supervisor, page);
        });
    };
}
function listen(server: Server, host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.off('error', reject);
            resolve((server.address() as AddressInfo).port);
        });
    });
}
/**
 * Serves the page, its API and its socket for the supervisor's fleet, on
 * localhost and without a login.
 *
 * @throws The listen error — `EADDRINUSE` when the port is taken.
 */
async function startDashboard(supervisor: Supervisor, options: DashboardOptions = {}): Promise<Dashboard> {
    const host = options.host ?? DEFAULT_HOST;
    const webRoot = normalize(options.webRoot ?? DEFAULT_WEB_ROOT);
    const sockets = new WebSocketServer({ noServer: true });
    let hosts = new Set<string>();
    const server = createServer((request, response) =>
        requestHandler(supervisor, hosts, { ...options, webRoot })(request, response));
    server.on('upgrade', (request, socket, head) => upgradeHandler(supervisor, hosts, sockets)(request, socket, head));
    const port = await listen(server, host, options.port ?? DEFAULT_PORT);
    hosts = allowedHosts(host, port);
    return {
        url: `http://${host}:${port}/`,
        port,
        close: async () => {
            for (const page of sockets.clients) {
                post(page, { type: 'shutdown' });
                page.close(1001, 'flotti is stopping');
            }
            sockets.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    };
}
export { DEFAULT_HOST, DEFAULT_PORT, startDashboard };
export type { Dashboard, DashboardOptions };
