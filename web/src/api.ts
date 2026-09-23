import type { BroadcastResponse, Delivery, ErrorResponse } from '../../src/dashboard-protocol.js';
async function post<T>(path: string, body: object = {}): Promise<T> {
    const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    const answer = (await response.json().catch(() => ({}))) as T | ErrorResponse;
    if (!response.ok) {
        const message = (answer as Partial<ErrorResponse>).error;
        throw new Error(message ?? `The dashboard answered ${response.status}.`);
    }
    return answer as T;
}
function agentPath(agentId: string, action: string): string {
    return `/api/agents/${encodeURIComponent(agentId)}/${action}`;
}
const api = {
    send: (agentId: string, text: string): Promise<Delivery> => post(agentPath(agentId, 'messages'), { text }),
    broadcast: (text: string, agents: readonly string[]): Promise<BroadcastResponse> =>
        post('/api/broadcast', { text, agents }),
    cancel: (agentId: string): Promise<object> => post(agentPath(agentId, 'cancel')),
    restart: (agentId: string): Promise<object> => post(agentPath(agentId, 'restart')),
    answerPermission: (agentId: string, requestId: string, optionId?: string): Promise<object> =>
        post(agentPath(agentId, `permissions/${encodeURIComponent(requestId)}`), optionId === undefined ? {} : { optionId })
};
export { api };
