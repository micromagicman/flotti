/**
 * Web Push on this browser: the service worker of the dashboard registered,
 * the person asked, and the subscription made with the public key of flotti.
 * The browser then gets the notifications even with the dashboard closed.
 */
const WORKER = '/sw.js';
/** Whether this browser can take Web Push here: it needs a secure page (localhost is one), a service worker and push. */
function pushSupported(): boolean {
    return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
    const binary = atob(base64);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}
async function registration(): Promise<ServiceWorkerRegistration> {
    await navigator.serviceWorker.register(WORKER);
    return navigator.serviceWorker.ready;
}
/** The subscription this browser has now; none when it has not subscribed. */
async function currentSubscription(): Promise<PushSubscription | null> {
    if (!pushSupported()) {
        return null;
    }
    const found = await navigator.serviceWorker.getRegistration(WORKER);
    return found === undefined ? null : found.pushManager.getSubscription();
}
/**
 * Asks the person, then subscribes this browser with the key of flotti. A
 * subscription made with another key — of an earlier flotti — is replaced.
 *
 * @throws Error, saying `refused`, when the person or the browser says no.
 */
async function subscribePush(publicKey: string, refused: string): Promise<PushSubscriptionJSON> {
    if (await Notification.requestPermission() !== 'granted') {
        throw new Error(refused);
    }
    const subscription = await subscriptionWith(await registration(), keyBytes(publicKey));
    return subscription.toJSON();
}
/** The subscription of this browser made with `key`: the one there is, or a new one in place of any other. */
async function subscriptionWith(worker: ServiceWorkerRegistration, key: Uint8Array<ArrayBuffer>): Promise<PushSubscription> {
    const existing = await worker.pushManager.getSubscription();
    if (existing !== null && hasKey(existing, key)) {
        return existing;
    }
    await existing?.unsubscribe();
    return worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}
function hasKey(subscription: PushSubscription, key: Uint8Array): boolean {
    const own = subscription.options.applicationServerKey;
    return own !== undefined && own !== null && new Uint8Array(own).join() === key.join();
}
/** Stops Web Push on this browser; the endpoint it had, for flotti to forget. */
async function unsubscribePush(): Promise<string | undefined> {
    const subscription = await currentSubscription();
    if (subscription === null) {
        return undefined;
    }
    await subscription.unsubscribe();
    return subscription.endpoint;
}
export { currentSubscription, pushSupported, subscribePush, unsubscribePush };
