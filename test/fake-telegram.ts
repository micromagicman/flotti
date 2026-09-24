import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
/** One call the pretend Bot API got: the token of the address, the method and the body. */
type BotCall = { readonly token: string; readonly method: string; readonly body: Record<string, unknown> };
/**
 * A pretend Telegram Bot API on localhost: it takes `sendMessage`,
 * `deleteMessage` and `editMessageText` of one token, numbers the messages
 * and remembers every call. No real bot, token or chat is ever used.
 */
class FakeTelegram {
    readonly calls: BotCall[] = [];
    /** Methods answered with an error, as the Bot API answers one it refuses. */
    readonly refuse = new Set<string>();
    private nextId = 100;
    private constructor(private readonly server: Server, readonly url: string, readonly token: string) {}
    static async start(token = '123456:fake-token-for-tests'): Promise<FakeTelegram> {
        const holder: { fake?: FakeTelegram } = {};
        const server = createServer((request, response) => {
            let text = '';
            request.on('data', (chunk: Buffer) => (text += chunk.toString()));
            request.on('end', () => {
                const [status, answer] = holder.fake?.answer(request.url ?? '', text) ?? [500, {}];
                response.writeHead(status, { 'content-type': 'application/json' });
                response.end(JSON.stringify(answer));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const fake = new FakeTelegram(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token);
        holder.fake = fake;
        return fake;
    }
    /** The calls of one method. */
    of(method: string): BotCall[] {
        return this.calls.filter((call) => call.method === method);
    }
    /** Resolves once there are `count` calls of the method. */
    async waitFor(method: string, count = 1): Promise<BotCall[]> {
        for (let tries = 0; tries < 200 && this.of(method).length < count; tries++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return this.of(method);
    }
    close(): Promise<void> {
        this.server.closeAllConnections();
        return new Promise((resolve) => this.server.close(() => resolve()));
    }
    private answer(path: string, text: string): [number, object] {
        const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(path);
        if (match === null || match[1] !== this.token) {
            return [401, { ok: false, error_code: 401, description: 'Unauthorized' }];
        }
        const method = match[2] ?? '';
        this.calls.push({ token: match[1], method, body: JSON.parse(text || '{}') as Record<string, unknown> });
        if (this.refuse.has(method)) {
            return [400, { ok: false, error_code: 400, description: `Bad Request: ${method} refused` }];
        }
        return [200, { ok: true, result: method === 'sendMessage' ? { message_id: this.nextId++ } : true }];
    }
}
export { FakeTelegram };
export type { BotCall };
