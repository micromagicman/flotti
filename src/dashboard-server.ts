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
    AdminAnswer,
    BroadcastResponse,
    ClientMessage,
    ErrorResponse,
    PermissionAnswer,
    SendRequest,
    ServerMessage
} from './dashboard-protocol.js';
import type { Forwarded, Quote, SendOptions } from './agent-events.js';
import { describeError } from './describe-error.js';
import { ConfigurationError } from './errors.js';
import { MemoryError, readMemoryBank, readMemoryNote } from './memory-bank.js';
import type { FleetSettings } from './fleet-settings.js';
import type { NotificationService } from './notifications.js';
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
    /** The notifications outside the browser; without them the page has no such settings. */
    readonly notifications?: NotificationService;
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
/** What a route works with: the running fleet and, when there are, the settings of it and its notifications. */
type Context = {
    readonly supervisor: Supervisor;
    readonly settings: FleetSettings | undefined;
    readonly notifications?: NotificationService | undefined;
};
type Route = {
    readonly method: Method;
    readonly pattern: RegExp;
    readonly handle: (context: Context, match: string[], body: unknown, query: URLSearchParams) => Promise<[number, unknown]>;
};
function requireSettings(context: Context): FleetSettings {
    if (context.settings === undefined) {
        throw new HttpError(404, 'This dashboard cannot change the fleet.');
    }
    return context.settings;
}
function requireNotifications(context: Context): NotificationService {
    if (context.notifications === undefined) {
        throw new HttpError(404, 'This dashboard has no notifications to set up.');
    }
    return context.notifications;
}
/** The notification settings: seen and changed, browsers subscribed, a test sent. */
const NOTIFICATION_ROUTES: readonly Route[] = [
    {
        method: 'GET',
        pattern: /^\/api\/notifications$/,
        handle: async (context) => [200, requireNotifications(context).view()]
    },
    {
        method: 'PUT',
        pattern: /^\/api\/notifications$/,
        handle: async (context, _match, body) => [200, requireNotifications(context).change(body)]
    },
    {
        method: 'POST',
        pattern: /^\/api\/notifications\/subscriptions$/,
        handle: async (context, _match, body) => [201, requireNotifications(context).subscribe(body)]
    },
    {
        method: 'DELETE',
        pattern: /^\/api\/notifications\/subscriptions$/,
        handle: async (context, _match, body) => [200, requireNotifications(context).unsubscribe(body)]
    },
    {
        method: 'POST',
        pattern: /^\/api\/notifications\/test$/,
        handle: async (context) => [200, await requireNotifications(context).test()]
    }
];
/** The memory bank of a local agent, read-only (#73): the list of its notes, and one note. */
const MEMORY_ROUTES: readonly Route[] = [
    {
        method: 'GET',
        pattern: /^\/api\/agents\/([^/]+)\/memory$/,
        handle: async ({ supervisor }, [id], _body, query) => [200, await readMemoryBank(supervisor.agent(id ?? ''), query.get('q') ?? '')]
    },
    {
        method: 'GET',
        pattern: /^\/api\/agents\/([^/]+)\/memory\/([^/]+)$/,
        handle: async ({ supervisor }, [id, path]) => [200, await readMemoryNote(supervisor.agent(id ?? ''), path ?? '')]
    }
];
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
        method: 'POST',
        pattern: /^\/api\/ssh-agents$/,
        handle: async (context, _match, body) => [201, await requireSettings(context).addOverSsh(body)]
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
        method: 'GET',
        pattern: /^\/api\/admin-settings$/,
        handle: async (context) => [200, requireSettings(context).adminSettings()]
    },
    {
        method: 'PUT',
        pattern: /^\/api\/admin-settings$/,
        handle: async (context, _match, body) => [200, requireSettings(context).setAdminSettings(body)]
    },
    {
        method: 'POST',
        pattern: /^\/api\/admin-actions\/([^/]+)$/,
        handle: async ({ supervisor }, [actionId], body) => {
            if (!supervisor.answerAdminAction(actionId ?? '', allowOf(body))) {
                throw new HttpError(404, 'No such action of an administrator is waiting.');
            }
            return [200, {}];
        }
    },
    {
        method: 'POST',
        pattern: /^\/api\/agents\/([^/]+)\/messages$/,
        handle: async ({ supervisor }, [id], body) => {
            const options = messageOptions(body);
            return [200, await supervisor.send(id ?? '', messageText(body, options.forwarded !== undefined), options)];
        }
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
        method: 'DELETE',
        pattern: /^\/api\/agents\/([^/]+)\/queue\/([^/]+)$/,
        handle: async ({ supervisor }, [id, messageId]) => {
            if (!supervisor.withdraw(id ?? '', messageId ?? '')) {
                throw new HttpError(404, 'No such message waits in line: the agent may have taken it already.');
            }
            return [200, {}];
        }
    },
    {
        method: 'POST',
        pattern: /^\/api\/agents\/([^/]+)\/permissions\/([^/]+)$/,
        handle: async ({ supervisor }, [id, requestId], body) => {
            if (!supervisor.answerPermission(id ?? '', requestId ?? '', optionIdOf(body))) {
                throw new HttpError(404, 'No such permission request is waiting.');
            }
            return [200, {}];
        }
    }
];
/** The fields of a request body; none when it has no body. */
function fieldsOf<T>(body: unknown): Partial<T> {
    return (body ?? {}) as Partial<T>;
}
/** `{ [key]: value }`, or nothing when there is no value. */
function present<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
    return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}
/** What `read` makes of a value, or nothing when the value is absent. */
function unlessAbsent<T>(value: unknown, read: (value: unknown) => T): T | undefined {
    return value === undefined ? undefined : read(value);
}
function allowOf(body: unknown): boolean {
    const { allow } = fieldsOf<AdminAnswer>(body);
    if (typeof allow !== 'boolean') {
        throw new HttpError(400, '"allow" must be true or false.');
    }
    return allow;
}
function optionIdOf(body: unknown): string | undefined {
    const { optionId } = fieldsOf<PermissionAnswer>(body);
    return typeof optionId === 'string' ? optionId : undefined;
}
/** The text of a message; a forwarded one may come without a word above it. */
function messageText(body: unknown, mayBeEmpty = false): string {
    const text = textOf(body, mayBeEmpty);
    if (!isMessageText(text, mayBeEmpty)) {
        throw new HttpError(400, 'The message is empty.');
    }
    return text;
}
/** The `text` of the body; an empty one stands for an absent text that may be empty. */
function textOf(body: unknown, mayBeEmpty: boolean): unknown {
    const { text } = fieldsOf<SendRequest>(body);
    return text === undefined && mayBeEmpty ? '' : text;
}
function isMessageText(text: unknown, mayBeEmpty: boolean): text is string {
    return typeof text === 'string' && (mayBeEmpty || text.trim() !== '');
}
function optionalString(value: unknown, name: string): string | undefined {
    if (value !== undefined && typeof value !== 'string') {
        throw new HttpError(400, `"${name}" must be text.`);
    }
    return value;
}
function requiredString(value: unknown, complaint: string): string {
    if (typeof value !== 'string') {
        throw new HttpError(400, complaint);
    }
    return value;
}
const QUOTE_NEEDS = '"replyTo" needs the "agentId", "messageId" and "text" of the message it answers.';
function quoteOf(value: unknown): Quote {
    const fields = fieldsOf<Quote>(value);
    const agentId = requiredString(fields.agentId, QUOTE_NEEDS);
    const messageId = requiredString(fields.messageId, QUOTE_NEEDS);
    const text = requiredString(fields.text, QUOTE_NEEDS);
    return { agentId, messageId, text, ...seqOf(fields.seq), ...present('author', optionalString(fields.author, 'replyTo.author')) };
}
function seqOf(seq: unknown): { seq?: number } {
    if (seq !== undefined && !Number.isInteger(seq)) {
        throw new HttpError(400, '"replyTo.seq" must be a whole number.');
    }
    return present('seq', seq as number | undefined);
}
function forwardedOf(value: unknown): Forwarded {
    const { author, text } = fieldsOf<Forwarded>(value);
    if (typeof text !== 'string' || text.trim() === '') {
        throw new HttpError(400, '"forwarded" needs the "text" of the message sent on.');
    }
    return { text, ...present('author', optionalString(author, 'forwarded.author')) };
}
/** What a message of a person answers or sends on; the sender is a person, always. */
function messageOptions(body: unknown): SendOptions {
    const request = fieldsOf<SendRequest>(body);
    return {
        ...present('replyTo', unlessAbsent(request.replyTo, quoteOf)),
        ...present('forwarded', unlessAbsent(request.forwarded, forwardedOf)),
        ...present('retryOf', optionalString(request.retryOf, 'retryOf'))
    };
}
function broadcastTargets(body: unknown): string[] | undefined {
    return unlessAbsent(fieldsOf<SendRequest>(body).agents, targetsOf);
}
function targetsOf(agents: unknown): string[] {
    if (!isIdList(agents)) {
        throw new HttpError(400, '"agents" must be a list of agent ids.');
    }
    if (agents.length === 0) {
        throw new HttpError(400, 'Pick at least one agent.');
    }
    return agents;
}
function isIdList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((id) => typeof id === 'string');
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
        const chunks = collectChunks(request, reject);
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
/** Gathers the chunks of the body as they come; one past the limit rejects the read and drops the request. */
function collectChunks(request: IncomingMessage, reject: (reason: unknown) => void): Buffer[] {
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
    return chunks;
}
/** Every route of the API, in the order they are tried. */
const ALL_ROUTES: readonly Route[] = [...ROUTES, ...NOTIFICATION_ROUTES, ...MEMORY_ROUTES];
type Found = { readonly route: Route; readonly match: RegExpExecArray };
async function handleApi(context: Context, request: IncomingMessage, url: URL): Promise<[number, unknown]> {
    const { route, match } = findRoute(request.method, url.pathname);
    requireJson(request);
    const body = request.method === 'GET' ? undefined : await readBody(request);
    return route.handle(context, match.slice(1).map((part) => decodeURIComponent(part)), body, url.searchParams);
}
/** The route of this method at this path; 404 when no route has the path, 405 when none has the method. */
function findRoute(method: string | undefined, path: string): Found {
    const matching = routesAt(path);
    if (matching.length === 0) {
        throw new HttpError(404, `Nothing at ${path}.`);
    }
    const found = matching.find(({ route }) => route.method === method);
    if (found === undefined) {
        throw new HttpError(405, `Use ${matching.map(({ route }) => route.method).join(' or ')}.`);
    }
    return found;
}
function routesAt(path: string): Found[] {
    return ALL_ROUTES.flatMap((route) => {
        const match = route.pattern.exec(path);
        return match === null ? [] : [{ route, match }];
    });
}
/**
 * A JSON body cannot come from a plain HTML form of another site, nor
 * cross-site without a preflight this server never answers.
 */
function requireJson(request: IncomingMessage): void {
    if (request.method !== 'GET' && !contentTypeOf(request).startsWith('application/json')) {
        throw new HttpError(415, 'Send the body as application/json.');
    }
}
function contentTypeOf(request: IncomingMessage): string {
    return request.headers['content-type'] ?? '';
}
/** Serves a file of the built page; any other path gets `index.html`, the page routes itself. */
async function serveStatic(webRoot: string, path: string, response: ServerResponse): Promise<void> {
    const target = staticTarget(webRoot, path);
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
/** The file a path asks for: one inside the web root with an extension, or else `index.html`. */
function staticTarget(webRoot: string, path: string): string {
    const relative = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    const file = join(webRoot, relative);
    const inside = file.startsWith(webRoot.endsWith(sep) ? webRoot : webRoot + sep);
    const extension = extname(file);
    return inside && extension !== '' ? file : join(webRoot, 'index.html');
}
function errorResponse(error: unknown): [number, ErrorResponse] {
    return [statusOf(error), { error: errorText(error) }];
}
/** The status of a configuration error by its kind; 400 for the kinds not here. */
const STATUS_OF_KIND: Readonly<Partial<Record<ConfigurationError['kind'], number>>> = {
    'duplicate-agent-id': 409,
    'already-running': 409,
    'ssh-failed': 502
};
function statusOf(error: unknown): number {
    if (error instanceof HttpError || error instanceof MemoryError) {
        return error.status;
    }
    return fleetStatus(error);
}
/** The status of an error the fleet threw: an unknown agent, a refused configuration, or else a failure. */
function fleetStatus(error: unknown): number {
    if (error instanceof UnknownAgentError) {
        return 404;
    }
    return error instanceof ConfigurationError ? STATUS_OF_KIND[error.kind] ?? 400 : 500;
}
function errorText(error: unknown): string {
    return error instanceof ConfigurationError ? configurationText(error) : describeError(error);
}
function configurationText(error: ConfigurationError): string {
    return error.hint === undefined ? error.message : `${error.message} ${error.hint}`;
}
/** Whether this is `flotti stop` asking, with the secret of this very run. */
function isShutdown(request: IncomingMessage, path: string, options: DashboardOptions): boolean {
    return path === '/api/shutdown'
        && request.method === 'POST'
        && options.shutdown !== undefined
        && request.headers['x-flotti-stop'] === options.shutdown.token;
}
function requestHandler(supervisor: Supervisor, hosts: Set<string>, options: DashboardOptions & { webRoot: string }) {
    return (request: IncomingMessage, response: ServerResponse): void => {
        if (!isAllowedHost(hosts, request)) {
            send(response, 421, { error: 'The dashboard answers on localhost only.' });
            return;
        }
        dispatch(supervisor, options, request, response);
    };
}
function isAllowedHost(hosts: Set<string>, request: IncomingMessage): boolean {
    return hosts.has(request.headers.host ?? '');
}
function requestUrl(request: IncomingMessage): URL {
    return new URL(request.url ?? '/', 'http://localhost');
}
/** Sends a request of an allowed host where it goes: the shutdown, a file of the page, or the API. */
function dispatch(supervisor: Supervisor, options: DashboardOptions & { webRoot: string }, request: IncomingMessage, response: ServerResponse): void {
    const url = requestUrl(request);
    if (isShutdown(request, url.pathname, options)) {
        send(response, 202, {});
        options.shutdown?.onRequest();
        return;
    }
    if (!url.pathname.startsWith('/api/')) {
        void serveStatic(options.webRoot, url.pathname, response);
        return;
    }
    answerApi({ supervisor, settings: options.settings, notifications: options.notifications }, request, url, response);
}
/** Answers an API request with what its route gives, or with the error it fails with. */
function answerApi(context: Context, request: IncomingMessage, url: URL, response: ServerResponse): void {
    handleApi(context, request, url).then(
        ([status, body]) => send(response, status, body),
        (error: unknown) => send(response, ...errorResponse(error))
    );
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
        const message = parseClientMessage(String(data));
        if (message === undefined || message.type !== 'subscribe' || caughtUp) {
            return;
        }
        const last = replayMissed(supervisor, socket, message);
        caughtUp = true;
        deliverHeld(held, last, deliver);
    });
    socket.on('close', unsubscribe);
    return unsubscribe;
}
/** The message of a page; nothing when it is not JSON. */
function parseClientMessage(data: string): ClientMessage | undefined {
    try {
        return JSON.parse(data) as ClientMessage;
    } catch {
        return undefined;
    }
}
/**
 * Posts the events the page has not seen yet, agent by agent.
 *
 * @returns The number of the last event posted, per agent.
 */
function replayMissed(supervisor: Supervisor, socket: WebSocket, message: ClientMessage): Map<string, number> {
    const last = new Map<string, number>();
    for (const agent of supervisor.agents()) {
        for (const event of supervisor.history(agent.id, sinceOf(message, agent.id))) {
            post(socket, { type: 'event', event });
            last.set(agent.id, event.seq);
        }
    }
    return last;
}
/** The number of the last event of the agent the page has seen; 0 when it has seen none. */
function sinceOf(message: ClientMessage, agentId: string): number {
    return Number(message.since?.[agentId] ?? 0);
}
/** Delivers what was held back while the page caught up, except the events it has already been sent. */
function deliverHeld(
    held: SupervisorNotice[],
    last: ReadonlyMap<string, number>,
    deliver: (notice: SupervisorNotice) => void
): void {
    for (const notice of held.splice(0)) {
        if (isUnseen(notice, last)) {
            deliver(notice);
        }
    }
}
/** Whether the page has not been sent this notice yet: any notice but an event it got replayed. */
function isUnseen(notice: SupervisorNotice, last: ReadonlyMap<string, number>): boolean {
    return notice.type !== 'event' || notice.event.seq > (last.get(notice.event.agentId) ?? 0);
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
        if (!mayUpgrade(request, hosts)) {
            socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
        }
        sockets.handleUpgrade(request, socket, head, (page) => {
            attachPage(supervisor, page);
        });
    };
}
/** Whether a page of an allowed host asks for the socket at `/ws`. */
function mayUpgrade(request: IncomingMessage, hosts: Set<string>): boolean {
    return requestUrl(request).pathname === '/ws' && isAllowedHost(hosts, request) && isAllowedOrigin(hosts, request.headers.origin);
}
/** Browsers let any site open a socket to localhost; the Origin header is what tells them apart. */
function isAllowedOrigin(hosts: Set<string>, origin: string | undefined): boolean {
    return origin === undefined || hosts.has(hostOf(origin));
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
    const { host, port: wanted, webRoot } = placeOf(options);
    const sockets = new WebSocketServer({ noServer: true });
    let hosts = new Set<string>();
    const server = createServer((request, response) =>
        requestHandler(supervisor, hosts, { ...options, webRoot })(request, response));
    server.on('upgrade', (request, socket, head) => upgradeHandler(supervisor, hosts, sockets)(request, socket, head));
    const port = await listen(server, host, wanted);
    hosts = allowedHosts(host, port);
    return {
        url: `http://${host}:${port}/`,
        port,
        close: async () => {
            await closeDashboard(server, sockets);
        }
    };
}
/** Where the dashboard listens and what page it serves: the options, or the defaults. */
function placeOf(options: DashboardOptions): { host: string; port: number; webRoot: string } {
    return {
        host: options.host ?? DEFAULT_HOST,
        port: options.port ?? DEFAULT_PORT,
        webRoot: normalize(options.webRoot ?? DEFAULT_WEB_ROOT)
    };
}
/** Tells the pages the dashboard is going away, closes their sockets and stops listening. */
async function closeDashboard(server: Server, sockets: WebSocketServer): Promise<void> {
    for (const page of sockets.clients) {
        post(page, { type: 'shutdown' });
        page.close(1001, 'flotti is stopping');
    }
    sockets.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}
export { DEFAULT_HOST, DEFAULT_PORT, startDashboard };
export type { Dashboard, DashboardOptions };
