/**
 * Tells a person, outside the browser, that an agent needs them: it waits for
 * an answer or a permission, it failed, or its SSH connection is lost. Every
 * such moment is one episode and earns one notification; an answer ends the
 * episode of a waiting agent and takes its notification back.
 *
 * Where a notification goes is a channel — Telegram, Web Push, whatever comes
 * next — and the notifier knows none of them: it only decides when to say what.
 */
import type { AgentEvent, AgentStatus } from './agent-events.js';
import type { NotificationEvents } from './dashboard-protocol.js';
import type { SupervisorNotice } from './supervisor.js';
import type { Agent } from './types.js';
/** What happened to the agent: which of the switches of {@link NotificationEvents} it falls under. */
type NoticeKind = keyof NotificationEvents;
/** One notification, as every channel gets it. */
type Notice = {
    /** Same for every notification of one episode: a repeat, and the withdrawal at its end. */
    readonly key: string;
    readonly kind: NoticeKind | 'test';
    readonly agentId: string;
    /** First line: who and what — "Reviewer is waiting for you". */
    readonly title: string;
    /** The gist: the permission asked for, the question, the error. */
    readonly body: string;
    /** Where the dashboard opens on the tab of the agent. */
    readonly url: string;
};
/** A way to reach a person. Errors of a channel are its own: a failed one does not stop the others. */
interface NotificationChannel {
    /** Short name for the settings page and the log: `telegram`, `web-push`. */
    readonly name: string;
    /** Sends the notification; rejects saying why it did not go. */
    notify(notice: Notice): Promise<void>;
    /** Takes back every notification sent with this key, where the channel can. */
    withdraw(key: string): Promise<void>;
}
/** What the notifier needs to know at the moment it decides; read anew every time, so a change applies at once. */
type NotifierConfig = {
    readonly events: NotificationEvents;
    /** Minutes before a person is told again that an agent still waits; 0 never. */
    readonly repeatMinutes: number;
    /** Address of the dashboard, with the trailing slash. */
    readonly dashboardUrl: string;
    /** The channels switched on and set up; none means nothing is sent at all. */
    readonly channels: readonly NotificationChannel[];
};
/** What the notifier listens to: the supervisor, or a stand-in in tests. */
type NoticeSource = {
    subscribe(listener: (notice: SupervisorNotice) => void): () => void;
    agent(agentId: string): Agent;
};
type NotifierOptions = {
    readonly config: () => NotifierConfig;
    /** Where a failed notification is reported; standard error by default. */
    readonly warn?: (text: string) => void;
};
/** An open episode: what it is about, and the channels its notifications went to. */
type Episode = {
    readonly key: string;
    readonly kind: NoticeKind;
    readonly channels: NotificationChannel[];
    repeat?: ReturnType<typeof setInterval>;
};
/** What is known of one agent between its events. */
type Watch = {
    status: AgentStatus;
    episode?: Episode;
    /** Title of the permission request the agent waits on, until it stops waiting. */
    permission?: string;
    /** The last message of the agent, as far as it has come: the question of an agent that waits for input. */
    message?: { id: string; text: string };
};
/** An agent ready for work: going from here to `starting` or `error` is a fall. */
const READY: ReadonlySet<AgentStatus> = new Set(['idle', 'working', 'waiting']);
/** Longest gist a notification carries; the dashboard has the rest. */
const GIST_LENGTH = 300;
function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
function gist(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > GIST_LENGTH ? `${flat.slice(0, GIST_LENGTH - 1)}…` : flat;
}
/** Whether the agent is reached over SSH: a local one started there, or a remote one through a tunnel. */
function overSsh(agent: Agent): boolean {
    return agent.ssh !== undefined;
}
/**
 * What a change of status means for the person: an agent that waits, one that
 * failed, one that lost its connection — or nothing to tell.
 */
function classify(agent: Agent, previous: AgentStatus, status: AgentStatus, reason: string | undefined): NoticeKind | undefined {
    if (status === 'waiting') {
        return 'waiting';
    }
    const fell = (status === 'starting' && READY.has(previous) && reason !== 'restarting') || status === 'error';
    if (!fell) {
        return undefined;
    }
    const connection = status === 'starting' || /reconnect|trying again|tunnel|ssh/i.test(reason ?? '');
    return overSsh(agent) && connection ? 'connection' : 'error';
}
/** The words of a notification about the agent. */
function wording(kind: NoticeKind, name: string, watch: Watch, reason: string | undefined): { title: string; body: string } {
    switch (kind) {
        case 'waiting': {
            const asked = watch.permission === undefined ? undefined : `Asks for permission: ${watch.permission}`;
            return { title: `${name} is waiting for you`, body: gist(asked ?? watch.message?.text ?? reason ?? 'Open flotti to answer.') };
        }
        case 'error':
            return { title: `${name} failed`, body: gist(reason ?? 'The agent stopped with an error.') };
        case 'connection':
            return { title: `${name} lost its SSH connection`, body: gist(reason ?? 'flotti is reconnecting.') };
    }
}
/** Address of the dashboard opened on the tab of the agent. */
function agentUrl(dashboardUrl: string, agentId: string): string {
    return `${dashboardUrl.endsWith('/') ? dashboardUrl : `${dashboardUrl}/`}#/${encodeURIComponent(agentId)}`;
}
/**
 * Watches the events of every agent and notifies over the channels of the
 * moment: one notification per episode, a repeat while an agent still waits
 * when the settings ask for it, and the notification taken back once the
 * waiting is over.
 */
class Notifier {
    private readonly watches = new Map<string, Watch>();
    private readonly warn: (text: string) => void;
    private readonly unsubscribe: () => void;
    private episodes = 0;
    constructor(private readonly source: NoticeSource, private readonly options: NotifierOptions) {
        this.warn = options.warn ?? ((text) => console.error(text));
        this.unsubscribe = source.subscribe((notice) => {
            if (notice.type === 'event') {
                this.take(notice.event);
            }
        });
    }
    /** Stops listening; the notifications already sent stay where they are. */
    close(): void {
        this.unsubscribe();
        for (const watch of this.watches.values()) {
            this.stopRepeat(watch.episode);
        }
        this.watches.clear();
    }
    private watch(agentId: string): Watch {
        let watch = this.watches.get(agentId);
        if (watch === undefined) {
            watch = { status: 'stopped' };
            this.watches.set(agentId, watch);
        }
        return watch;
    }
    private take(event: AgentEvent): void {
        const watch = this.watch(event.agentId);
        if (event.type === 'permission') {
            watch.permission = event.title;
        } else if (event.type === 'message' && event.role === 'agent') {
            const same = watch.message?.id === event.messageId && event.append;
            watch.message = { id: event.messageId, text: same ? `${watch.message?.text ?? ''}${event.text}` : event.text };
        } else if (event.type === 'status') {
            this.follow(event.agentId, watch, event.status, event.reason);
        }
    }
    /** A new status of the agent: an episode begins, goes on, or ends. */
    private follow(agentId: string, watch: Watch, status: AgentStatus, reason: string | undefined): void {
        const previous = watch.status;
        watch.status = status;
        const agent = this.agent(agentId);
        const kind = agent === undefined ? undefined : classify(agent, previous, status, reason);
        const open = watch.episode;
        if (open !== undefined && (kind === undefined ? status !== 'starting' : kind !== open.kind)) {
            if (open.kind !== 'waiting' && kind !== undefined && kind !== 'waiting') {
                return;
            }
            this.end(watch);
        }
        if (status !== 'waiting') {
            watch.permission = undefined;
        }
        if (kind !== undefined && watch.episode === undefined && agent !== undefined) {
            this.begin(agent, watch, kind, reason);
        }
    }
    private agent(agentId: string): Agent | undefined {
        try {
            return this.source.agent(agentId);
        } catch {
            return undefined;
        }
    }
    private begin(agent: Agent, watch: Watch, kind: NoticeKind, reason: string | undefined): void {
        const config = this.options.config();
        const episode: Episode = { key: `${agent.id}-${kind}-${++this.episodes}`, kind, channels: [] };
        watch.episode = episode;
        if (!config.events[kind] || config.channels.length === 0) {
            return;
        }
        const notice = (): Notice => ({
            key: episode.key,
            kind,
            agentId: agent.id,
            ...wording(kind, agent.name, watch, reason),
            url: agentUrl(this.options.config().dashboardUrl, agent.id)
        });
        episode.channels.push(...config.channels);
        this.send(episode.channels, notice());
        if (kind === 'waiting' && config.repeatMinutes > 0) {
            this.repeat(episode, notice, config.repeatMinutes);
        }
    }
    /** Tells again, every so many minutes, that the agent still waits. */
    private repeat(episode: Episode, notice: () => Notice, minutes: number): void {
        episode.repeat = setInterval(() => this.send(episode.channels, notice()), minutes * 60_000);
        episode.repeat.unref?.();
    }
    /** The episode is over: a waiting agent got its answer, and its notifications are taken back. */
    private end(watch: Watch): void {
        const episode = watch.episode;
        watch.episode = undefined;
        this.stopRepeat(episode);
        if (episode?.kind === 'waiting') {
            for (const channel of episode.channels) {
                channel.withdraw(episode.key).catch((error: unknown) => this.failed(channel, error));
            }
        }
    }
    private stopRepeat(episode: Episode | undefined): void {
        if (episode?.repeat !== undefined) {
            clearInterval(episode.repeat);
            episode.repeat = undefined;
        }
    }
    private send(channels: readonly NotificationChannel[], notice: Notice): void {
        for (const channel of channels) {
            channel.notify(notice).catch((error: unknown) => this.failed(channel, error));
        }
    }
    private failed(channel: NotificationChannel, error: unknown): void {
        this.warn(`flotti: a ${channel.name} notification failed: ${describeError(error)}`);
    }
}
export { Notifier, agentUrl, classify };
export type { Notice, NoticeKind, NoticeSource, NotificationChannel, NotifierConfig, NotifierOptions };
