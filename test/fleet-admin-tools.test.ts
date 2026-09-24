import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { AdminAction } from '../src/agent-events.js';
import type { AgentSummary, Delivery } from '../src/dashboard-protocol.js';
import type { AdminOutcome } from '../src/fleet-admin.js';
import { FleetMcpServer } from '../src/fleet-mcp.js';
import type { FleetDirectory } from '../src/fleet-mcp.js';
import { Supervisor } from '../src/supervisor.js';
import { fakeFleet } from './fake-fleet-agent.js';
const servers: FleetMcpServer[] = [];
after(async () => {
    await Promise.all(servers.map((server) => server.close()));
});
async function toolsServer(fleet: FleetDirectory): Promise<FleetMcpServer> {
    const server = await FleetMcpServer.start();
    servers.push(server);
    server.serve(fleet);
    return server;
}
async function rpc(server: FleetMcpServer, agentId: string, method: string, params: object = {}): Promise<Record<string, unknown>> {
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.access(agentId).token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    return (await response.json() as { result: Record<string, unknown> }).result;
}
async function toolNames(server: FleetMcpServer, agentId: string): Promise<string[]> {
    return ((await rpc(server, agentId, 'tools/list'))['tools'] as { name: string }[]).map((tool) => tool.name);
}
async function callTool(server: FleetMcpServer, agentId: string, name: string, args: object): Promise<{ text: string; isError: boolean }> {
    const result = await rpc(server, agentId, 'tools/call', { name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content[0]?.text ?? '', isError: result.isError === true };
}
/** A fleet as the tools see it, where `boss` administers; what it was asked to do is kept in `asked`. */
function directory(withAdmin = true): FleetDirectory & { asked: string[] } {
    const asked: string[] = [];
    const agents = (): AgentSummary[] => [
        { id: 'boss', name: 'boss', kind: 'local', status: 'working', admin: true },
        { id: 'worker', name: 'worker', kind: 'local', status: 'idle' }
    ];
    const administer = async (admin: string, action: AdminAction, target: string): Promise<AdminOutcome> => {
        asked.push(`${admin} ${action} ${target}`);
        return admin === 'boss' ? { ok: true, text: 'done' } : { ok: false, text: 'Refused: not an administrator' };
    };
    return {
        asked,
        agents,
        send: async (agentId: string): Promise<Delivery> => ({ agentId, result: 'taken' }),
        delegate: () => Promise.reject(new Error('no tasks here')),
        cancelDelegation: () => {
            throw new Error('no tasks here');
        },
        ...(withAdmin ? { administer } : {})
    };
}
describe('fleet tools of an administrator', () => {
    it('are listed to an administrator only, and list_agents marks it', async () => {
        const server = await toolsServer(directory());
        deepStrictEqual(await toolNames(server, 'boss'), ['list_agents', 'send_message', 'reply', 'delegate', 'cancel_delegation', 'forward', 'restart_agent', 'clear_context']);
        deepStrictEqual(await toolNames(server, 'worker'), ['list_agents', 'send_message', 'reply', 'delegate', 'cancel_delegation', 'forward']);
        const listed = JSON.parse((await callTool(server, 'worker', 'list_agents', {})).text) as AgentSummary[];
        deepStrictEqual(listed.map((agent) => [agent.id, agent.admin]), [['boss', true], ['worker', undefined]]);
        const initialized = await rpc(server, 'boss', 'initialize', { protocolVersion: '2025-06-18' });
        match(String(initialized['instructions']), /You are an administrator of the fleet/);
    });
    it('restart and clear through the fleet, on behalf of the caller', async () => {
        const fleet = directory();
        const server = await toolsServer(fleet);
        deepStrictEqual(await callTool(server, 'boss', 'restart_agent', { id: 'worker' }), { text: 'done', isError: false });
        deepStrictEqual(await callTool(server, 'boss', 'clear_context', { id: 'boss' }), { text: 'done', isError: false });
        deepStrictEqual(fleet.asked, ['boss restart worker', 'boss clear-context boss']);
    });
    it('refuse a caller that is not an administrator, with the reason, as an error the agent reads', async () => {
        const server = await toolsServer(directory());
        const answer = await callTool(server, 'worker', 'restart_agent', { id: 'boss' });
        strictEqual(answer.isError, true);
        match(answer.text, /Refused/);
    });
    it('want the id of the agent, and say so', async () => {
        const server = await toolsServer(directory());
        const answer = await callTool(server, 'boss', 'clear_context', {});
        strictEqual(answer.isError, true);
        match(answer.text, /id is missing/);
    });
    it('are not available when the fleet does not administer', async () => {
        const server = await toolsServer(directory(false));
        const answer = await callTool(server, 'boss', 'restart_agent', { id: 'worker' });
        strictEqual(answer.isError, true);
        match(answer.text, /not available/);
    });
    it('reach the agents of a real supervisor, and refuse its non-administrators there', async () => {
        const { fleet, fakes, createAgent } = fakeFleet('boss', 'worker');
        const agents = fleet.agents.map((agent) => (agent.id === 'boss' ? { ...agent, admin: true as const } : agent));
        const supervisor = new Supervisor({ ...fleet, agents }, { createAgent });
        await supervisor.start();
        const server = await toolsServer(supervisor);
        strictEqual((await callTool(server, 'worker', 'clear_context', { id: 'boss' })).isError, true);
        deepStrictEqual(await callTool(server, 'boss', 'clear_context', { id: 'worker' }), { text: 'The context of "worker" is cleared.', isError: false });
        deepStrictEqual(fakes.get('worker')?.calls, ['start', 'clear-context']);
        deepStrictEqual(fakes.get('boss')?.calls, ['start']);
        ok(supervisor.history('boss').some((event) => event.type === 'admin-action' && event.state === 'done'));
    });
});
