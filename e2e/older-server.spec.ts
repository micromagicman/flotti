/**
 * The page of this version on the socket of a server older than it (#167).
 * `npm install -g flotti` puts the new files under a `flotti run` that is
 * still going: it serves the new page from disk, but speaks as it did — the
 * `fleet` of a 0.5.x names no groups. The page shows the fleet and does not die.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { WebSocketServer } from 'ws';
// The page as `npm run build` puts it next to the server that serves it.
const WEB = fileURLToPath(new URL('../build/web', import.meta.url));
const TYPES: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png'
};
/** The fleet as a server of 0.5.x posts it once a page connects: the agents, and nothing of groups. */
const FLEET_OF_0_5 = { type: 'fleet', agents: [{ id: 'scout', name: 'scout', kind: 'local', status: 'idle' }] };
let server: Server | undefined;
let sockets: WebSocketServer | undefined;
let url = '';
/** The file of the page a path asks for; `index.html` for the page itself. */
async function serveFile(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url ?? '/';
    const target = join(WEB, extname(path) === '' ? 'index.html' : path);
    try {
        const body = await readFile(target);
        response.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' });
        response.end(body);
    } catch {
        response.writeHead(404);
        response.end();
    }
}
test.beforeAll(async () => {
    const http = createServer((request, response) => void serveFile(request, response));
    sockets = new WebSocketServer({ server: http, path: '/ws' });
    sockets.on('connection', (socket) => socket.send(JSON.stringify(FLEET_OF_0_5)));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
    server = http;
});
test.afterAll(async () => {
    sockets?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
});
test('the page shows the fleet of a server older than it, whose fleet names no groups, and does not die (#167)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await expect.soft(page.locator('.sidebar').getByRole('tab', { name: /^scout/ })).toBeVisible();
    expect(errors).toEqual([]);
});
