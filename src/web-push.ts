/**
 * Web Push without a third party: the browser subscribes through the service
 * worker of the dashboard, and flotti sends to the push service of that
 * browser itself — signed with its own VAPID key (RFC 8292) and encrypted for
 * that one browser (RFC 8291, `aes128gcm` of RFC 8188). The push service sees
 * neither the text nor who the agents are.
 */
import {
    createCipheriv,
    createECDH,
    createPrivateKey,
    generateKeyPairSync,
    hkdfSync,
    randomBytes,
    sign
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { PushSubscriptionBody } from './dashboard-protocol.js';
import { describeError } from './describe-error.js';
import type { Notice, NotificationChannel } from './notifier.js';
/** The key pair flotti signs its pushes with; both halves base64url, the public one as the raw point. */
type VapidKeys = { readonly publicKey: string; readonly privateKey: string };
/** A subscription flotti can send to: an endpoint and the keys of the browser. */
type PushSubscription = Required<PushSubscriptionBody>;
/** What the service worker gets: a notification to show, or one to take back. */
type PushPayload =
    | { readonly type: 'show'; readonly tag: string; readonly title: string; readonly body: string; readonly url: string }
    | { readonly type: 'withdraw'; readonly tag: string };
type WebPushOptions = {
    readonly keys: VapidKeys;
    /** The browsers to send to, read anew every time. */
    readonly subscriptions: () => readonly PushSubscription[];
    /** Called with a subscription the push service says is gone, so it is forgotten. */
    readonly onGone: (endpoint: string) => void;
    /** Who sends, for the push service: a `mailto:` or an `https:` address. */
    readonly subject?: string;
};
/** Record size of the encrypted body; one record is all a notification needs. */
const RECORD_SIZE = 4096;
/** How long a push service keeps a push for a browser that is offline. */
const TTL_SECONDS = 24 * 60 * 60;
const TIMEOUT_MS = 10_000;
/** The protocols a push endpoint may have. */
const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:']);
const DEFAULT_SUBJECT = 'https://github.com/micromagicman/flotti';
function base64url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url');
}
/** A new VAPID key pair. */
function vapidKeys(): VapidKeys {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x ?? '', 'base64url'), Buffer.from(jwk.y ?? '', 'base64url')]);
    return { publicKey: base64url(point), privateKey: jwk.d ?? '' };
}
/** The private key of the pair as Node signs with it. */
function signingKey(keys: VapidKeys): KeyObject {
    const point = Buffer.from(keys.publicKey, 'base64url');
    return createPrivateKey({
        key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: base64url(point.subarray(1, 33)), y: base64url(point.subarray(33, 65)) },
        format: 'jwk'
    });
}
/** The `Authorization` header of a push to `endpoint`: a JWT signed with the VAPID key, and the public key. */
function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
    const header = base64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const claims = base64url(Buffer.from(JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: subject
    })));
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: signingKey(keys), dsaEncoding: 'ieee-p1363' });
    return `vapid t=${header}.${claims}.${base64url(signature)}, k=${keys.publicKey}`;
}
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
    return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}
/**
 * The payload encrypted for one browser, as RFC 8291 has it: a key agreed with
 * the browser's key and its auth secret, one `aes128gcm` record.
 */
function encrypt(payload: string, subscription: PushSubscription, salt = randomBytes(16)): Buffer {
    const browserKey = Buffer.from(subscription.keys.p256dh, 'base64url');
    const auth = Buffer.from(subscription.keys.auth, 'base64url');
    const ecdh = createECDH('prime256v1');
    const ownKey = ecdh.generateKeys();
    const shared = ecdh.computeSecret(browserKey);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), browserKey, ownKey]);
    const ikm = hkdf(auth, shared, keyInfo, 32);
    const contentKey = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
    const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
    const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(RECORD_SIZE);
    return Buffer.concat([salt, size, Buffer.from([ownKey.length]), ownKey, body]);
}
/** A subscription out of what a page sent; throws when it is not one. */
function subscriptionOf(body: unknown): PushSubscription {
    const { endpoint, keys } = (body ?? {}) as Partial<PushSubscriptionBody>;
    const url = webUrl(endpoint);
    if (url === undefined || !hasKeys(keys)) {
        throw new Error('A push subscription needs an http(s) endpoint and the p256dh and auth keys.');
    }
    return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}
/** The endpoint as an http(s) address; nothing when it is not one. */
function webUrl(endpoint: unknown): URL | undefined {
    const url = parsedUrl(String(endpoint));
    return url !== undefined && WEB_PROTOCOLS.has(url.protocol) ? url : undefined;
}
function parsedUrl(text: string): URL | undefined {
    try {
        return new URL(text);
    } catch {
        return undefined;
    }
}
function hasKeys(keys: PushSubscriptionBody['keys']): keys is PushSubscription['keys'] {
    return typeof keys?.p256dh === 'string' && typeof keys.auth === 'string';
}
class WebPushChannel implements NotificationChannel {
    readonly name = 'web-push';
    constructor(private readonly options: WebPushOptions) {}
    notify(notice: Notice): Promise<void> {
        return this.push({ type: 'show', tag: tagOf(notice), title: notice.title, body: notice.body, url: notice.url });
    }
    withdraw(key: string): Promise<void> {
        return this.push({ type: 'withdraw', tag: tagOfKey(key) });
    }
    /** Sends to every browser; rejects when none took it, saying why. */
    private async push(payload: PushPayload): Promise<void> {
        const subscriptions = this.options.subscriptions();
        if (subscriptions.length === 0) {
            throw new Error('no browser is subscribed');
        }
        const failures = (await Promise.all(subscriptions.map((one) => this.pushTo(one, payload)))).filter((why) => why !== undefined);
        if (failures.length === subscriptions.length) {
            throw new Error(failures.join('; '));
        }
    }
    /** Sends to one browser: why it failed, or nothing. */
    private async pushTo(subscription: PushSubscription, payload: PushPayload): Promise<string | undefined> {
        try {
            const response = await fetch(subscription.endpoint, {
                method: 'POST',
                headers: this.headers(subscription),
                body: new Uint8Array(encrypt(JSON.stringify(payload), subscription)),
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
            return this.answered(subscription, response);
        } catch (error) {
            return describeError(error);
        }
    }
    /** What the push service answered: why it failed, or nothing; a subscription it no longer knows is gone. */
    private answered(subscription: PushSubscription, response: Response): string | undefined {
        if (response.status === 404 || response.status === 410) {
            this.options.onGone(subscription.endpoint);
        }
        return response.ok ? undefined : `the push service answered ${response.status}`;
    }
    private headers(subscription: PushSubscription): Record<string, string> {
        return {
            authorization: vapidAuthorization(subscription.endpoint, this.options.keys, this.options.subject ?? DEFAULT_SUBJECT),
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: String(TTL_SECONDS),
            urgency: 'high'
        };
    }
}
/**
 * The tag of the browser notification. A waiting agent gets the tag the page
 * itself uses, so the two never show one wait twice.
 */
function tagOf(notice: Notice): string {
    return notice.kind === 'waiting' ? `flotti-waiting-${notice.agentId}` : tagOfKey(notice.key);
}
function tagOfKey(key: string): string {
    const waiting = /^(.*)-waiting-\d+$/.exec(key);
    return waiting === null ? `flotti-${key}` : `flotti-waiting-${waiting[1]}`;
}
export { WebPushChannel, encrypt, subscriptionOf, vapidAuthorization, vapidKeys };
export type { PushPayload, PushSubscription, VapidKeys, WebPushOptions };
