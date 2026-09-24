/**
 * Draws a person to agents that wait for them: the count in the title of the
 * page, and a browser notification when an agent starts waiting while the
 * page is out of sight. Notifications only with the person's permission,
 * asked for by a button, never by itself.
 */
import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { newlyWaiting, notificationText, pageTitle, waitingAgents } from './attention.js';
import type { FleetState } from './fleet-state.js';
import type { Messages } from './i18n/en.js';
/** Not every browser has notifications: an insecure page or an old browser has none. */
type Permission = NotificationPermission | 'unsupported';
function currentPermission(): Permission {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}
/** The page is out of sight: another browser tab, another window, or the window minimised. */
function outOfSight(): boolean {
    return document.hidden || !document.hasFocus();
}
type Attention = {
    readonly permission: Permission;
    /** Asks the browser for permission to notify; call it from a click. */
    readonly askPermission: () => void;
};
type Refs = {
    readonly wasWaiting: MutableRefObject<ReadonlySet<string>>;
    readonly shown: MutableRefObject<Map<string, Notification>>;
    readonly open: MutableRefObject<(agentId: string) => void>;
    /** The words of the page as they are now: a notification speaks its language. */
    readonly t: MutableRefObject<Messages>;
};
/** The flotti mark on its plate: a notification shows it next to the text. */
const NOTIFICATION_ICON = '/icon-192.png';
/** Notifies of the agents that started waiting while the page is out of sight. */
function notifyNewlyWaiting(refs: Refs, waiting: ReturnType<typeof waitingAgents>, feeds: FleetState['feeds']): void {
    for (const agent of newlyWaiting(refs.wasWaiting.current, waiting)) {
        const { title, body } = notificationText(agent, feeds[agent.id], refs.t.current);
        const notification = new Notification(title, { body, tag: `flotti-waiting-${agent.id}`, icon: NOTIFICATION_ICON });
        notification.onclick = () => {
            window.focus();
            refs.open.current(agent.id);
            notification.close();
        };
        refs.shown.current.set(agent.id, notification);
    }
}
function updateNotifications(refs: Refs, waiting: ReturnType<typeof waitingAgents>, feeds: FleetState['feeds'], permission: Permission): void {
    const now = new Set(waiting.map((agent) => agent.id));
    if (permission === 'granted' && outOfSight()) {
        notifyNewlyWaiting(refs, waiting, feeds);
    }
    // Answered, here or elsewhere: its notification is old news.
    for (const [id, notification] of refs.shown.current) {
        if (!now.has(id)) {
            notification.close();
            refs.shown.current.delete(id);
        }
    }
    refs.wasWaiting.current = now;
}
function askPermission(setPermission: (permission: Permission) => void): void {
    if (typeof Notification !== 'undefined') {
        void Notification.requestPermission().then(setPermission);
    }
}
/** A ref that always holds the latest value: the effect reads it without running again for it. */
function useLatest<T>(value: T): MutableRefObject<T> {
    const ref = useRef(value);
    ref.current = value;
    return ref;
}
function useAttention(state: FleetState, onOpen: (agentId: string) => void, t: Messages): Attention {
    const [permission, setPermission] = useState<Permission>(currentPermission);
    const wasWaiting = useRef<ReadonlySet<string>>(new Set());
    const shown = useRef(new Map<string, Notification>());
    const open = useLatest(onOpen);
    const words = useLatest(t);
    const waiting = waitingAgents(state.agents, state.feeds);
    const waitingKey = waiting.map((agent) => agent.id).join('\n');
    useEffect(() => {
        document.title = pageTitle(waiting.length);
    }, [waiting.length]);
    useEffect(() => {
        updateNotifications({ wasWaiting, shown, open, t: words }, waiting, state.feeds, permission);
        // Only a change in who waits matters; the rest of the state changes with every event.
    }, [waitingKey, permission]);
    return {
        permission,
        askPermission: () => askPermission(setPermission)
    };
}
export { useAttention };
export type { Permission };
