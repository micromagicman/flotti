import type {
    AgentConfig,
    AgentSummary,
    BroadcastResponse,
    Delivery,
    ErrorResponse,
    FleetInfo,
    SendRequest,
    SshAgentsResponse
} from '../../src/dashboard-protocol.js';
async function call<T>(method: string, path: string, body?: object): Promise<T> {
    const response = await fetch(path, {
        method,
        ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    });
    const answer = (await response.json().catch(() => ({}))) as T | ErrorResponse;
    if (!response.ok) {
        const message = (answer as Partial<ErrorResponse>).error;
        throw new Error(message ?? `The dashboard answered ${response.status}.`);
    }
    return answer as T;
}
const post = <T>(path: string, body: object = {}): Promise<T> => call<T>('POST', path, body);
function agentPath(agentId: string, action?: string): string {
    return `/api/agents/${encodeURIComponent(agentId)}${action === undefined ? '' : `/${action}`}`;
}
const api = {
    /** A message to one agent; `extras` make it a reply, or a forward. */
    send: (agentId: string, text: string, extras: Omit<SendRequest, 'text' | 'agents'> = {}): Promise<Delivery> =>
        post(agentPath(agentId, 'messages'), { text, ...extras }),
    broadcast: (text: string, agents: readonly string[]): Promise<BroadcastResponse> =>
        post('/api/broadcast', { text, agents }),
    cancel: (agentId: string): Promise<object> => post(agentPath(agentId, 'cancel')),
    restart: (agentId: string): Promise<object> => post(agentPath(agentId, 'restart')),
    start: (agentId: string): Promise<object> => post(agentPath(agentId, 'start')),
    stop: (agentId: string): Promise<object> => post(agentPath(agentId, 'stop')),
    answerPermission: (agentId: string, requestId: string, optionId?: string): Promise<object> =>
        post(agentPath(agentId, `permissions/${encodeURIComponent(requestId)}`), optionId === undefined ? {} : { optionId }),
    config: (agentId: string): Promise<AgentConfig> => call('GET', agentPath(agentId)),
    addOverSsh: (target: string): Promise<SshAgentsResponse> => post('/api/ssh-agents', { target }),
    create: (config: AgentConfig): Promise<AgentSummary> => post('/api/agents', config),
    update: (config: AgentConfig): Promise<AgentSummary> => call('PUT', agentPath(config.id), config),
    remove: (agentId: string): Promise<{ readonly trash?: string }> => call('DELETE', agentPath(agentId)),
    fleet: (): Promise<FleetInfo> => call('GET', '/api/fleet'),
    switchFleet: (path: string): Promise<FleetInfo> => call('PUT', '/api/fleet', { path })
};
export { api };
