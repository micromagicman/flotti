import { useEffect, useReducer, useRef } from 'react';
import type { Dispatch } from 'react';
import type { ClientMessage, ServerMessage } from '../../src/dashboard-protocol.js';
import { fleetReducer, initialState, seen } from './fleet-state.js';
import type { FleetAction, FleetState } from './fleet-state.js';
/** Reconnect pauses: one second, doubling, never longer than this. */
const MAX_BACKOFF_MS = 30_000;
/** A socket that has not opened by then is dropped and tried again. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
type Socket = {
    readonly state: () => FleetState;
    readonly dispatch: Dispatch<FleetAction>;
    attempt: number;
    stopped: boolean;
    socket?: WebSocket;
    timer?: ReturnType<typeof setTimeout>;
};
function socketUrl(): string {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${window.location.host}/ws`;
}
function scheduleReconnect(link: Socket): void {
    if (link.stopped || link.state().link === 'gone') {
        return;
    }
    const delay = Math.min(1000 * 2 ** link.attempt, MAX_BACKOFF_MS);
    link.attempt += 1;
    link.timer = setTimeout(() => connect(link), delay);
}
function receive(link: Socket, socket: WebSocket, message: MessageEvent<string>): void {
    const parsed = JSON.parse(message.data) as ServerMessage;
    link.dispatch({ type: 'server', message: parsed });
    if (parsed.type === 'fleet') {
        // The fleet goes first; now say what this page has seen, and get the rest.
        const subscribe: ClientMessage = { type: 'subscribe', since: seen(link.state()) };
        socket.send(JSON.stringify(subscribe));
    }
}
function connect(link: Socket): void {
    link.dispatch({ type: 'link', link: 'connecting' });
    const socket = new WebSocket(socketUrl());
    link.socket = socket;
    const handshake = setTimeout(() => socket.close(), HANDSHAKE_TIMEOUT_MS);
    socket.onopen = () => {
        clearTimeout(handshake);
        link.attempt = 0;
        link.dispatch({ type: 'link', link: 'open' });
    };
    socket.onmessage = (message: MessageEvent<string>) => receive(link, socket, message);
    socket.onclose = () => {
        clearTimeout(handshake);
        link.dispatch({ type: 'link', link: 'closed' });
        scheduleReconnect(link);
    };
}
/**
 * Keeps one socket to the dashboard server open for as long as the page is:
 * reconnects with a growing pause, and asks each time only for the events it
 * has not seen yet.
 */
function useFleet(): [FleetState, Dispatch<FleetAction>] {
    const [state, dispatch] = useReducer(fleetReducer, initialState);
    const current = useRef(state);
    current.current = state;
    useEffect(() => {
        const link: Socket = { state: () => current.current, dispatch, attempt: 0, stopped: false };
        connect(link);
        return () => {
            link.stopped = true;
            clearTimeout(link.timer);
            link.socket?.close();
        };
    }, []);
    return [state, dispatch];
}
export { useFleet };
