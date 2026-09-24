import { useEffect, useMemo } from 'react';
import { assignColors } from './agent-colors.js';
import type { AgentColors } from './agent-colors.js';
const STORAGE_KEY = 'flotti.agent-colors';
/** The colours picked before in this browser; none when the storage is out of reach. */
function loadColors(): AgentColors {
    try {
        const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
        return typeof parsed === 'object' && parsed !== null ? parsed as AgentColors : {};
    } catch {
        return {};
    }
}
/**
 * The colour of every agent of the fleet, kept in this browser: an agent
 * keeps its colour across reloads. A storage out of reach — a private
 * window — only means new picks on the next visit.
 */
function useAgentColors(ids: readonly string[]): AgentColors {
    const key = ids.join('\n');
    const colors = useMemo(() => assignColors(key === '' ? [] : key.split('\n'), loadColors()), [key]);
    useEffect(() => {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
        } catch {
            // The colours hold while the page is open.
        }
    }, [colors]);
    return colors;
}
export { useAgentColors };
