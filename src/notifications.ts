/**
 * The notifications outside the browser as a whole: their settings — kept
 * under `notifications` in `~/.flotti/settings.json`, changed on the settings
 * page — the channels made of them, and the notifier that uses the channels.
 *
 * Nothing is set up at first, and then nothing is sent: flotti behaves as it
 * did before there were notifications.
 */
import type {
    NotificationEvents,
    NotificationSettings,
    NotificationSettingsChange,
    NotificationTestResponse
} from './dashboard-protocol.js';
import { ConfigurationError } from './errors.js';
import type { Environment } from './manifest.js';
import { Notifier } from './notifier.js';
import type { NoticeSource, NotificationChannel, NotifierConfig } from './notifier.js';
import { readSettingsField, writeSettings } from './settings.js';
import { TELEGRAM_API_VARIABLE, TelegramChannel, hide } from './telegram.js';
import { WebPushChannel, subscriptionOf, vapidKeys } from './web-push.js';
import type { PushSubscription, VapidKeys } from './web-push.js';
/** The notifications as the settings file keeps them, secrets and all. */
type Stored = {
    readonly events: NotificationEvents;
    readonly repeatMinutes: number;
    readonly dashboardUrl?: string;
    readonly telegram: { readonly enabled: boolean; readonly chatId?: string; readonly botToken?: string };
    readonly webPush: { readonly enabled: boolean; readonly vapid?: VapidKeys; readonly subscriptions: readonly PushSubscription[] };
};
type NotificationServiceOptions = {
    /** Environment for the settings file and {@link TELEGRAM_API_VARIABLE}; `process.env` by default. */
    readonly env?: Environment;
    /** Address of this dashboard, for the links; can be told later with {@link NotificationService.setDashboardUrl}. */
    readonly dashboardUrl?: string;
    /** Where a failed notification or unreadable settings are reported; standard error by default. */
    readonly warn?: (text: string) => void;
};
/** The settings key the notifications live under. */
const FIELD = 'notifications';
/** Longest pause between two reminders that an agent still waits: a day. */
const MAX_REPEAT_MINUTES = 24 * 60;
const DEFAULTS: Stored = {
    events: { waiting: true, error: true, connection: true },
    repeatMinutes: 0,
    telegram: { enabled: false },
    webPush: { enabled: false, subscriptions: [] }
};
type Fields = Record<string, unknown>;
function fields(value: unknown): Fields {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : {};
}
function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
function invalid(message: string): ConfigurationError {
    return new ConfigurationError('wrong-type', message);
}
/** The events part of stored or sent settings, each switch a boolean or the one it was. */
function eventsOf(value: unknown, base: NotificationEvents): NotificationEvents {
    const given = fields(value);
    const pick = (name: keyof NotificationEvents): boolean => (typeof given[name] === 'boolean' ? given[name] : base[name]);
    return { waiting: pick('waiting'), error: pick('error'), connection: pick('connection') };
}
/** The subscriptions a file keeps, dropping any that is not one. */
function storedSubscriptions(value: unknown): PushSubscription[] {
    return (Array.isArray(value) ? value : []).flatMap((one) => {
        try {
            return [subscriptionOf(one)];
        } catch {
            return [];
        }
    });
}
function storedVapid(value: unknown): VapidKeys | undefined {
    const { publicKey, privateKey } = fields(value);
    return typeof publicKey === 'string' && typeof privateKey === 'string' ? { publicKey, privateKey } : undefined;
}
/** The notifications out of what the settings file holds; what is not there, or not right, is the default. */
function parseStored(value: unknown): Stored {
    const all = fields(value);
    const telegram = fields(all['telegram']);
    const webPush = fields(all['webPush']);
    const repeat = all['repeatMinutes'];
    const dashboardUrl = text(all['dashboardUrl']);
    const chatId = text(telegram['chatId']);
    const botToken = text(telegram['botToken']);
    const vapid = storedVapid(webPush['vapid']);
    return {
        events: eventsOf(all['events'], DEFAULTS.events),
        repeatMinutes: Number.isInteger(repeat) && Number(repeat) >= 0 ? Math.min(Number(repeat), MAX_REPEAT_MINUTES) : 0,
        ...(dashboardUrl === undefined ? {} : { dashboardUrl }),
        telegram: { enabled: telegram['enabled'] === true, ...(chatId === undefined ? {} : { chatId }), ...(botToken === undefined ? {} : { botToken }) },
        webPush: { enabled: webPush['enabled'] === true, ...(vapid === undefined ? {} : { vapid }), subscriptions: storedSubscriptions(webPush['subscriptions']) }
    };
}
function checkRepeat(value: unknown, current: number): number {
    if (value === undefined) {
        return current;
    }
    if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > MAX_REPEAT_MINUTES) {
        throw invalid(`repeatMinutes must be a whole number of minutes from 0 to ${MAX_REPEAT_MINUTES}.`);
    }
    return Number(value);
}
/** The link address: absent to keep, empty to go back to this dashboard, else an http(s) address. */
function checkDashboardUrl(value: unknown, current: string | undefined): string | undefined {
    if (value === undefined) {
        return current;
    }
    if (typeof value !== 'string') {
        throw invalid('dashboardUrl must be a string.');
    }
    if (value.trim() === '') {
        return undefined;
    }
    if (!/^https?:\/\/[^\s]+$/.test(value.trim())) {
        throw invalid('dashboardUrl must be an http:// or https:// address.');
    }
    return value.trim();
}
function checkString(value: unknown, name: string, current: string | undefined): string | undefined {
    if (value === undefined) {
        return current;
    }
    if (typeof value !== 'string') {
        throw invalid(`${name} must be a string.`);
    }
    return text(value);
}
function checkBoolean(value: unknown, name: string, current: boolean): boolean {
    if (value !== undefined && typeof value !== 'boolean') {
        throw invalid(`${name} must be true or false.`);
    }
    return value ?? current;
}
function changedTelegram(value: unknown, current: Stored['telegram']): Stored['telegram'] {
    const given = fields(value);
    const enabled = checkBoolean(given['enabled'], 'telegram.enabled', current.enabled);
    const chatId = checkString(given['chatId'], 'telegram.chatId', current.chatId);
    const botToken = checkString(given['botToken'], 'telegram.botToken', current.botToken);
    if (enabled && (chatId === undefined || botToken === undefined)) {
        throw invalid('Telegram needs a bot token and a chat id before it can be switched on.');
    }
    return { enabled, ...(chatId === undefined ? {} : { chatId }), ...(botToken === undefined ? {} : { botToken }) };
}
/** The stored notifications with a change of the settings page applied; throws when the change is not right. */
function applyChange(current: Stored, body: unknown): Stored {
    const change = fields(body) as Fields & NotificationSettingsChange;
    const dashboardUrl = checkDashboardUrl(change.dashboardUrl, current.dashboardUrl);
    return {
        events: eventsOf(change.events, current.events),
        repeatMinutes: checkRepeat(change.repeatMinutes, current.repeatMinutes),
        ...(dashboardUrl === undefined ? {} : { dashboardUrl }),
        telegram: changedTelegram(change.telegram, current.telegram),
        webPush: { ...current.webPush, enabled: checkBoolean(fields(change.webPush)['enabled'], 'webPush.enabled', current.webPush.enabled) }
    };
}
/**
 * The notifications of a running flotti: settings read at the start, changed
 * and saved from the page, and a notifier that follows the fleet with the
 * channels they switch on.
 */
class NotificationService {
    private stored: Stored;
    private channels: NotificationChannel[] = [];
    private dashboardUrl: string;
    private readonly env: Environment;
    private readonly warn: (text: string) => void;
    private readonly notifier: Notifier;
    constructor(source: NoticeSource, options: NotificationServiceOptions = {}) {
        this.env = options.env ?? process.env;
        this.warn = options.warn ?? ((line) => console.error(line));
        this.dashboardUrl = options.dashboardUrl ?? 'http://127.0.0.1/';
        this.stored = this.load();
        this.rebuild();
        this.notifier = new Notifier(source, { config: () => this.config(), warn: (line) => this.warn(this.hideSecrets(line)) });
    }
    setDashboardUrl(url: string): void {
        this.dashboardUrl = url;
    }
    /** The settings as the page may see them: no secret in there. */
    view(): NotificationSettings {
        const { events, repeatMinutes, dashboardUrl, telegram, webPush } = this.stored;
        return {
            events,
            repeatMinutes,
            ...(dashboardUrl === undefined ? {} : { dashboardUrl }),
            telegram: { enabled: telegram.enabled, ...(telegram.chatId === undefined ? {} : { chatId: telegram.chatId }), botTokenSet: telegram.botToken !== undefined },
            webPush: { enabled: webPush.enabled, publicKey: this.vapid().publicKey, subscriptions: webPush.subscriptions.length }
        };
    }
    /**
     * Applies a change of the settings page and saves it.
     *
     * @throws ConfigurationError when the change is not right, or cannot be saved.
     */
    change(body: unknown): NotificationSettings {
        this.save(applyChange(this.stored, body));
        return this.view();
    }
    /** A browser subscribes to Web Push: it is kept, and Web Push is switched on. */
    subscribe(body: unknown): NotificationSettings {
        const subscription = this.subscription(body);
        const others = this.stored.webPush.subscriptions.filter((one) => one.endpoint !== subscription.endpoint);
        this.save({ ...this.stored, webPush: { ...this.stored.webPush, enabled: true, vapid: this.vapid(), subscriptions: [...others, subscription] } });
        return this.view();
    }
    /** A browser stops: its subscription is forgotten. */
    unsubscribe(body: unknown): NotificationSettings {
        const { endpoint } = fields(body);
        this.forget(typeof endpoint === 'string' ? endpoint : '');
        return this.view();
    }
    /** Sends a test notification over every channel switched on, and says how each went. */
    async test(): Promise<NotificationTestResponse> {
        const notice = { key: `test-${Date.now()}`, kind: 'test' as const, agentId: '', title: 'flotti', body: 'Notifications reach you here.', url: this.linkBase() };
        const results = await Promise.all(this.channels.map((channel) => channel.notify(notice).then(
            () => ({ channel: channel.name, ok: true }),
            (error: unknown) => ({ channel: channel.name, ok: false, error: this.hideSecrets(error instanceof Error ? error.message : String(error)) })
        )));
        return { results };
    }
    close(): void {
        this.notifier.close();
    }
    private subscription(body: unknown): PushSubscription {
        try {
            return subscriptionOf(body);
        } catch (error) {
            throw invalid(error instanceof Error ? error.message : String(error));
        }
    }
    private forget(endpoint: string): void {
        const subscriptions = this.stored.webPush.subscriptions.filter((one) => one.endpoint !== endpoint);
        if (subscriptions.length !== this.stored.webPush.subscriptions.length) {
            this.save({ ...this.stored, webPush: { ...this.stored.webPush, subscriptions } });
        }
    }
    private config(): NotifierConfig {
        return { events: this.stored.events, repeatMinutes: this.stored.repeatMinutes, dashboardUrl: this.linkBase(), channels: this.channels };
    }
    /** Address the links lead to, with the trailing slash. */
    private linkBase(): string {
        const base = this.stored.dashboardUrl ?? this.dashboardUrl;
        return base.endsWith('/') ? base : `${base}/`;
    }
    /**
     * The VAPID keys; made the first time they are needed, and saved with the
     * first subscription — a page that only looks writes nothing.
     */
    private vapid(): VapidKeys {
        if (this.stored.webPush.vapid === undefined) {
            this.stored = { ...this.stored, webPush: { ...this.stored.webPush, vapid: vapidKeys() } };
        }
        return this.stored.webPush.vapid as VapidKeys;
    }
    private load(): Stored {
        try {
            return parseStored(readSettingsField(this.env, FIELD));
        } catch (error) {
            this.warn(`flotti: notifications are off, the settings could not be read: ${error instanceof Error ? error.message : String(error)}`);
            return DEFAULTS;
        }
    }
    /** Saves the notifications to the settings file, and puts them to work once they are saved. */
    private save(next: Stored): void {
        writeSettings(this.env, { [FIELD]: next });
        this.stored = next;
        this.rebuild();
    }
    /** The channels of the settings as they are now. */
    private rebuild(): void {
        const { telegram, webPush } = this.stored;
        const channels: NotificationChannel[] = [];
        if (telegram.enabled && telegram.botToken !== undefined && telegram.chatId !== undefined) {
            const apiUrl = text(this.env[TELEGRAM_API_VARIABLE]);
            channels.push(new TelegramChannel({ botToken: telegram.botToken, chatId: telegram.chatId, ...(apiUrl === undefined ? {} : { apiUrl }) }));
        }
        if (webPush.enabled && webPush.vapid !== undefined) {
            channels.push(new WebPushChannel({
                keys: webPush.vapid,
                subscriptions: () => this.stored.webPush.subscriptions,
                onGone: (endpoint) => this.forget(endpoint)
            }));
        }
        this.channels = channels;
    }
    /** The text with every secret of the settings cut out: nothing secret goes to a log or to the page. */
    private hideSecrets(line: string): string {
        return [this.stored.telegram.botToken ?? '', this.stored.webPush.vapid?.privateKey ?? ''].reduce(hide, line);
    }
}
export { NotificationService, parseStored };
export type { NotificationServiceOptions };
