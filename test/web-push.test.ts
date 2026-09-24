import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import type { Notice } from '../src/notifier.js';
import { WebPushChannel, encrypt, subscriptionOf, vapidAuthorization, vapidKeys } from '../src/web-push.js';
import type { PushSubscription } from '../src/web-push.js';
/** A browser: its key pair and auth secret, and the subscription it hands out. */
function browser() {
    const ecdh = createECDH('prime256v1');
    const publicKey = ecdh.generateKeys();
    const auth = randomBytes(16);
    const subscription = (endpoint: string): PushSubscription => ({
        endpoint,
        keys: { p256dh: publicKey.toString('base64url'), auth: auth.toString('base64url') }
    });
    return { ecdh, publicKey, auth, subscription };
}
/** What the browser does with a push: RFC 8291 read backwards. */
function decrypt(body: Buffer, reader: ReturnType<typeof browser>): string {
    const salt = body.subarray(0, 16);
    strictEqual(body.readUInt32BE(16), 4096);
    const idLength = body[20] ?? 0;
    const senderKey = body.subarray(21, 21 + idLength);
    const shared = reader.ecdh.computeSecret(senderKey);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), reader.publicKey, senderKey]);
    const ikm = Buffer.from(hkdfSync('sha256', shared, reader.auth, info, 32));
    const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const record = body.subarray(21 + idLength);
    const decipher = createDecipheriv('aes-128-gcm', key, nonce);
    decipher.setAuthTag(record.subarray(record.length - 16));
    const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
    strictEqual(plain.at(-1), 2, 'the last record ends with the delimiter 2');
    return plain.subarray(0, plain.length - 1).toString();
}
/** A pretend push service: keeps what it got, answers with the status it is told. */
const received: { path: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];
let answer = 201;
const service = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
        received.push({ path: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks) });
        response.writeHead(answer);
        response.end();
    });
});
await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
after(() => new Promise<void>((resolve) => service.close(() => resolve())));
const notice: Notice = {
    key: 'reviewer-waiting-1',
    kind: 'waiting',
    agentId: 'reviewer',
    title: 'Reviewer is waiting for you',
    body: 'Asks for permission: Run npm test',
    url: 'http://127.0.0.1:4870/#/reviewer'
};
test('the payload is encrypted for the browser, and only it reads it', () => {
    const reader = browser();
    const body = encrypt('{"hello":"browser"}', reader.subscription('https://push.example.org/1'));
    strictEqual(decrypt(body, reader), '{"hello":"browser"}');
    ok(!body.includes(Buffer.from('hello')), 'the text is not in the clear');
});
test('the VAPID header is a JWT for the push service, signed with the key the browser subscribed with', () => {
    const keys = vapidKeys();
    const header = vapidAuthorization('https://push.example.org/send/abc', keys, 'mailto:someone@example.org', 1_000_000);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    ok(match !== null, header);
    const [, head = '', claims = '', signature = '', key = ''] = match;
    strictEqual(key, keys.publicKey);
    deepStrictEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), {
        aud: 'https://push.example.org',
        exp: 1000 + 12 * 60 * 60,
        sub: 'mailto:someone@example.org'
    });
    const point = Buffer.from(keys.publicKey, 'base64url');
    const publicKey = createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
        format: 'jwk'
    });
    ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});
test('a notification goes to every browser; its withdrawal carries the same tag', async () => {
    received.length = 0;
    answer = 201;
    const [first, second] = [browser(), browser()];
    const subscriptions = [first.subscription(`${origin}/one`), second.subscription(`${origin}/two`)];
    const channel = new WebPushChannel({ keys: vapidKeys(), subscriptions: () => subscriptions, onGone: () => undefined });
    await channel.notify(notice);
    await channel.withdraw(notice.key);
    deepStrictEqual(received.map((push) => push.path), ['/one', '/two', '/one', '/two']);
    const [shown, , withdrawn] = received;
    strictEqual(shown?.headers['content-encoding'], 'aes128gcm');
    ok(String(shown?.headers['authorization']).startsWith('vapid t='));
    deepStrictEqual(JSON.parse(decrypt(shown?.body ?? Buffer.alloc(0), first)), {
        type: 'show',
        tag: 'flotti-waiting-reviewer',
        title: notice.title,
        body: notice.body,
        url: notice.url
    });
    deepStrictEqual(JSON.parse(decrypt(withdrawn?.body ?? Buffer.alloc(0), first)), { type: 'withdraw', tag: 'flotti-waiting-reviewer' });
});
test('a browser the push service says is gone is forgotten; with none left, the push fails', async () => {
    received.length = 0;
    answer = 410;
    const gone: string[] = [];
    const reader = browser();
    const channel = new WebPushChannel({ keys: vapidKeys(), subscriptions: () => [reader.subscription(`${origin}/old`)], onGone: (endpoint) => gone.push(endpoint) });
    await rejects(channel.notify(notice), /410/);
    deepStrictEqual(gone, [`${origin}/old`]);
    await rejects(new WebPushChannel({ keys: vapidKeys(), subscriptions: () => [], onGone: () => undefined }).notify(notice), /no browser/);
    answer = 201;
});
test('a subscription needs an http(s) endpoint and both keys', () => {
    const reader = browser();
    deepStrictEqual(subscriptionOf(reader.subscription('https://push.example.org/x')).endpoint, 'https://push.example.org/x');
    for (const wrong of [undefined, {}, { endpoint: 'javascript:alert(1)', keys: { p256dh: 'a', auth: 'b' } }, { endpoint: 'https://push.example.org/x' }]) {
        let failed = false;
        try {
            subscriptionOf(wrong);
        } catch {
            failed = true;
        }
        ok(failed, JSON.stringify(wrong));
    }
});
