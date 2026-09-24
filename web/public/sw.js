/**
 * The service worker of the dashboard: shows the notifications flotti pushes
 * (Web Push) while the dashboard is closed or out of sight, and takes one
 * back once the agent got its answer. A click opens the tab of the agent.
 *
 * A waiting agent's notification has the tag the page itself uses, so the
 * browser never shows one wait twice.
 */
self.addEventListener('install', () => {
    void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});
/** Whether a page of the dashboard is in front of the person: then the page says it, not a notification. */
async function inSight() {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    return pages.some((page) => page.visibilityState === 'visible' && page.focused);
}
async function receive(payload) {
    if (payload === null || typeof payload !== 'object') {
        return;
    }
    if (payload.type === 'withdraw') {
        const shown = await self.registration.getNotifications({ tag: payload.tag });
        shown.forEach((notification) => notification.close());
        return;
    }
    if (payload.type === 'show' && !(await inSight())) {
        await self.registration.showNotification(payload.title, {
            body: payload.body,
            tag: payload.tag,
            renotify: true,
            data: { url: payload.url }
        });
    }
}
self.addEventListener('push', (event) => {
    let payload = null;
    try {
        payload = event.data === null ? null : event.data.json();
    } catch {
        payload = null;
    }
    event.waitUntil(receive(payload));
});
async function openTab(url) {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = pages.find((candidate) => new URL(candidate.url).origin === self.location.origin);
    if (page === undefined) {
        await self.clients.openWindow(url);
        return;
    }
    await page.focus();
    if (typeof page.navigate === 'function') {
        await page.navigate(url).catch(() => undefined);
    }
}
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url ?? self.location.origin;
    event.waitUntil(openTab(url));
});
