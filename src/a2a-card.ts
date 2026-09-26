import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import type { AgentCard } from '@a2a-js/sdk';
import { FLEET_EXTENSION, HARNESS_EXTENSION, INBOX_EXTENSION, RESTART_EXTENSION } from './a2a-protocol.js';
/** What the agent card told about the agent, for the dashboard. */
type A2AAgentInfo = {
    readonly name: string;
    readonly description: string;
    /** Version of the agent itself, as its card states it. */
    readonly version: string;
    /** A2A version flotti speaks to it, sent in the `A2A-Version` header. */
    readonly protocolVersion: string;
    /** Whether answers arrive as a stream; otherwise flotti asks for the task every so often. */
    readonly streaming: boolean;
    /** Whether the agent can restart itself when asked (the flotti restart extension). */
    readonly restart: boolean;
    /** Whether the agent says things of its own through the flotti inbox extension. */
    readonly inbox: boolean;
    /** Whether the agent wants the roster of the fleet through the flotti fleet extension. */
    readonly fleet: boolean;
    /** The program that runs the agent, as the harness extension of the card names it. */
    readonly harness?: string;
    /** Whether the card carries a signature. It is not verified: see README, "Talking to a remote agent". */
    readonly signed: boolean;
    /** Names of the security schemes the card declares. */
    readonly security: readonly string[];
    readonly skills: readonly { readonly id: string; readonly name: string; readonly description: string }[];
};
/** An agent card kept between reads. */
type CachedCard = { body: string; etag: string | null; freshUntil: number };
type Extension = NonNullable<AgentCard['capabilities']>['extensions'][number];
/**
 * Where the card is: `<url>/.well-known/agent-card.json`, or the url itself
 * when it names a `.json` file — for agents that keep their card elsewhere.
 */
function cardLocation(url: string): { readonly base: string; readonly path: string } {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('.json')) {
        return { base: parsed.href, path: '' };
    }
    if (!parsed.pathname.endsWith('/')) {
        parsed.pathname += '/';
    }
    return { base: parsed.href, path: AGENT_CARD_PATH };
}
/** The address of the card itself, for an agent at `url`. */
function cardUrl(url: string): string {
    const location = cardLocation(url);
    return location.path === '' ? location.base : new URL(location.path, location.base).href;
}
/**
 * Keeps the agent card between reads: while `Cache-Control: max-age` says it
 * is fresh it is not asked for at all, and after that it is asked for with
 * `If-None-Match`, so an unchanged card costs a `304`.
 */
function cachingCardFetch(base: typeof fetch): typeof fetch {
    let cached: CachedCard | undefined;
    return async (input, init) => {
        const fresh = freshCard(cached);
        if (fresh !== undefined) {
            return replayCard(fresh.body);
        }
        const response = await base(input, { ...init, headers: revalidatingHeaders(init, cached) });
        const unchanged = unchangedCard(response, cached);
        if (unchanged !== undefined) {
            return replayKept(unchanged, response);
        }
        if (!response.ok) {
            return response;
        }
        const body = await response.text();
        cached = cacheEntry(body, response.headers);
        return replayCard(body);
    };
}
/** The kept card while it is fresh: it is not asked for then. */
function freshCard(cached: CachedCard | undefined): CachedCard | undefined {
    return cached !== undefined && Date.now() < cached.freshUntil ? cached : undefined;
}
/** The kept card, when the agent answered that it has not changed. */
function unchangedCard(response: Response, cached: CachedCard | undefined): CachedCard | undefined {
    return response.status === 304 ? cached : undefined;
}
/** A kept card the agent says has not changed: fresh again for as long as the answer says. */
function replayKept(cached: CachedCard, response: Response): Response {
    cached.freshUntil = Date.now() + freshFor(response.headers.get('Cache-Control'));
    return replayCard(cached.body);
}
/** A kept card, answered as if the agent sent it. */
function replayCard(body: string): Response {
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}
/** Headers of a card request; `If-None-Match` when the kept card has an `ETag`. */
function revalidatingHeaders(init: RequestInit | undefined, cached: CachedCard | undefined): Headers {
    const headers = new Headers(init?.headers);
    if (cached?.etag != null) {
        headers.set('If-None-Match', cached.etag);
    }
    return headers;
}
/** What to keep of a card just read; nothing when its `Cache-Control` says `no-store`. */
function cacheEntry(body: string, headers: Headers): CachedCard | undefined {
    const cacheControl = headers.get('Cache-Control');
    return /\bno-store\b/i.test(cacheControl ?? '')
        ? undefined
        : { body, etag: headers.get('ETag'), freshUntil: Date.now() + freshFor(cacheControl) };
}
/** Milliseconds a response stays fresh by its `Cache-Control`; 0 means "check every time". */
function freshFor(cacheControl: string | null): number {
    if (cacheControl === null || /\bno-cache\b/i.test(cacheControl)) {
        return 0;
    }
    const maxAge = /\bmax-age=(\d+)/i.exec(cacheControl);
    return maxAge === null ? 0 : Number(maxAge[1]) * 1_000;
}
function describeCard(card: AgentCard, protocolVersion: string): A2AAgentInfo {
    return {
        name: card.name,
        description: card.description,
        version: card.version,
        protocolVersion,
        ...cardAbilities(card),
        signed: (card.signatures ?? []).length > 0,
        security: Object.keys(card.securitySchemes ?? {}),
        skills: cardSkills(card)
    };
}
/** What the agent can do, by the capabilities its card declares. */
function cardAbilities(card: AgentCard): Pick<A2AAgentInfo, 'streaming' | 'restart' | 'inbox' | 'fleet' | 'harness'> {
    const uris = new Set(declaredExtensions(card).map(extension => extension.uri));
    const harness = cardHarness(card);
    return {
        streaming: card.capabilities?.streaming === true,
        restart: uris.has(RESTART_EXTENSION),
        inbox: uris.has(INBOX_EXTENSION),
        fleet: uris.has(FLEET_EXTENSION),
        ...(harness === undefined ? {} : { harness })
    };
}
function cardSkills(card: AgentCard): A2AAgentInfo['skills'] {
    return (card.skills ?? []).map(skill => ({ id: skill.id, name: skill.name, description: skill.description }));
}
/** The extensions the card declares in its capabilities. */
function declaredExtensions(card: AgentCard): readonly Extension[] {
    return card.capabilities?.extensions ?? [];
}
/** The harness the card names in the harness extension; a missing or empty name is no name. */
function cardHarness(card: AgentCard): string | undefined {
    const extension = declaredExtensions(card).find(item => item.uri === HARNESS_EXTENSION);
    return nonBlank(extension?.params?.['harness']);
}
function nonBlank(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
/** Whether the agent is told who is in the fleet: it declares the extension, and the inbox it goes with. */
function hearsFleet(card: A2AAgentInfo | undefined): boolean {
    return card?.fleet === true && card.inbox && card.streaming;
}
export { cachingCardFetch, cardLocation, cardUrl, describeCard, hearsFleet };
export type { A2AAgentInfo };
