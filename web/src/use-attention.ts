/**
 * Draws a person to agents that wait for them: the count in the title of the
 * page, and a browser notification when an agent starts waiting while the
 * page is out of sight. Notifications only with the person's permission,
 * asked for by a button, never by itself.
 */
import { useEffect, useRef, useState } from 'react';
import { newlyWaiting, notificationText, pageTitle, waitingAgents } from './attention.js';
import type { FleetState } from './fleet-state.js';
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
function useAttention(state: FleetState, onOpen: (agentId: string) => void): Attention {
    const [permission, setPermission] = useState<Permission>(currentPermission);
    const wasWaiting = useRef<ReadonlySet<string>>(new Set());
    const shown = useRef(new Map<string, Notification>());
    const open = useRef(onOpen);
    open.current = onOpen;
    const waiting = waitingAgents(state.agents, state.feeds);
    const waitingKey = waiting.map((agent) => agent.id).join('\n');
    useEffect(() => {
        document.title = pageTitle(waiting.length);
    }, [waiting.length]);
    useEffect(() => {
        const now = new Set(waiting.map((agent) => agent.id));
        if (permission === 'granted' && outOfSight()) {
            for (const agent of newlyWaiting(wasWaiting.current, waiting)) {
                const { title, body } = notificationText(agent, state.feeds[agent.id]);
                const notification = new Notification(title, { body, tag: `flotti-waiting-${agent.id}` });
                notification.onclick = () => {
                    window.focus();
                    open.current(agent.id);
                    notification.close();
                };
                shown.current.set(agent.id, notification);
            }
        }
        // Answered, here or elsewhere: its notification is old news.
        for (const [id, notification] of shown.current) {
            if (!now.has(id)) {
                notification.close();
                shown.current.delete(id);
            }
        }
        wasWaiting.current = now;
        // Only a change in who waits matters; the rest of the state changes with every event.
    }, [waitingKey, permission]);
    return {
        permission,
        askPermission: () => {
            if (typeof Notification !== 'undefined') {
                void Notification.requestPermission().then(setPermission);
            }
        }
    };
}
export { useAttention };
export type { Permission };
