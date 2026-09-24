import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { NotificationEvents, NotificationSettings, NotificationSettingsChange, NotificationTestResponse } from '../../../src/dashboard-protocol.js';
import { api } from '../api.js';
import { currentSubscription, pushSupported, subscribePush, unsubscribePush } from '../push.js';
import { Field } from './AgentForm.js';
/** The form as it is typed: numbers and a new token are text until saved. */
type Draft = {
    readonly events: NotificationEvents;
    readonly repeatMinutes: string;
    readonly dashboardUrl: string;
    readonly telegramEnabled: boolean;
    readonly chatId: string;
    /** A new token; empty keeps the saved one. */
    readonly botToken: string;
    readonly webPushEnabled: boolean;
};
const EVENT_LABELS: Readonly<Record<keyof NotificationEvents, string>> = {
    waiting: 'An agent waits for an answer or a permission',
    error: 'An agent fails or falls',
    connection: 'The SSH connection to an agent is lost'
};
function errorText(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
}
function draftOf(view: NotificationSettings): Draft {
    return {
        events: view.events,
        repeatMinutes: String(view.repeatMinutes),
        dashboardUrl: view.dashboardUrl ?? '',
        telegramEnabled: view.telegram.enabled,
        chatId: view.telegram.chatId ?? '',
        botToken: '',
        webPushEnabled: view.webPush.enabled
    };
}
function changeOf(draft: Draft): NotificationSettingsChange {
    const repeat = Number(draft.repeatMinutes.trim() === '' ? '0' : draft.repeatMinutes);
    return {
        events: draft.events,
        repeatMinutes: repeat,
        dashboardUrl: draft.dashboardUrl,
        telegram: { enabled: draft.telegramEnabled, chatId: draft.chatId, ...(draft.botToken.trim() === '' ? {} : { botToken: draft.botToken }) },
        webPush: { enabled: draft.webPushEnabled }
    };
}
function Check({ label, checked, onChange }: { readonly label: string; readonly checked: boolean; readonly onChange: (checked: boolean) => void }) {
    return (
        <label className="check">
            <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
            {label}
        </label>
    );
}
type DraftProps = { readonly draft: Draft; readonly setDraft: (draft: Draft) => void };
/** Which moments are told, how often a wait is told again, and where the links lead. */
function WhenFields({ draft, setDraft }: DraftProps) {
    return (
        <fieldset className="checks" aria-label="Notify when">
            {(Object.keys(EVENT_LABELS) as (keyof NotificationEvents)[]).map((name) => (
                <Check key={name} label={EVENT_LABELS[name]} checked={draft.events[name]} onChange={(checked) => setDraft({ ...draft, events: { ...draft.events, [name]: checked } })} />
            ))}
            <div className="field-row">
                <Field label="Remind every (minutes)" hint="While an agent still waits. 0: tell once.">
                    <input className="input" inputMode="numeric" value={draft.repeatMinutes} onChange={(event) => setDraft({ ...draft, repeatMinutes: event.target.value })} />
                </Field>
                <Field label="Link to the dashboard" hint="Empty: the address of this dashboard. Put the address you open it by from elsewhere here.">
                    <input className="input" value={draft.dashboardUrl} placeholder="http://127.0.0.1:4870/" onChange={(event) => setDraft({ ...draft, dashboardUrl: event.target.value })} />
                </Field>
            </div>
        </fieldset>
    );
}
/** A bot of the person's own: its token and the chat it writes to. */
function TelegramFields({ draft, setDraft, tokenSet }: DraftProps & { readonly tokenSet: boolean }) {
    return (
        <fieldset className="checks" aria-label="Telegram">
            <Check label="Telegram" checked={draft.telegramEnabled} onChange={(checked) => setDraft({ ...draft, telegramEnabled: checked })} />
            <div className="field-row">
                <Field label="Bot token" hint={tokenSet ? 'Saved; it is never shown. Type a new one to replace it.' : 'From @BotFather. Kept on this machine, never shown again.'}>
                    <input className="input" type="password" autoComplete="off" value={draft.botToken} placeholder={tokenSet ? 'saved' : '123456:ABC…'} onChange={(event) => setDraft({ ...draft, botToken: event.target.value })} />
                </Field>
                <Field label="Chat id" hint="Your id, or the id of a group the bot is in.">
                    <input className="input" value={draft.chatId} onChange={(event) => setDraft({ ...draft, chatId: event.target.value })} />
                </Field>
            </div>
        </fieldset>
    );
}
/** The settings as the server has them, and the form made of them. */
function useShown() {
    const [view, setView] = useState<NotificationSettings>();
    const [draft, setDraft] = useState<Draft>();
    const show = (next: NotificationSettings): void => {
        setView(next);
        setDraft(draftOf(next));
    };
    return { view, draft, setDraft, show };
}
function useNotificationSettings() {
    const { view, draft, setDraft, show } = useShown();
    const [error, setError] = useState<string>();
    const [saved, setSaved] = useState(false);
    useEffect(() => {
        api.notifications().then(show, (reason: unknown) => setError(errorText(reason)));
    }, []);
    const run = (action: () => Promise<NotificationSettings>): void => {
        setError(undefined);
        setSaved(false);
        action().then((next) => {
            show(next);
            setSaved(true);
        }, (reason: unknown) => setError(errorText(reason)));
    };
    return { view, draft, setDraft, error, saved, run };
}
/** Web Push on this very browser: subscribed or not, and the button to change it. */
function WebPushControl({ view, onChange }: { readonly view: NotificationSettings; readonly onChange: (next: NotificationSettings) => void }) {
    const [here, setHere] = useState<boolean>();
    const [error, setError] = useState<string>();
    useEffect(() => {
        currentSubscription().then((found) => setHere(found !== null), () => setHere(false));
    }, []);
    const act = (action: () => Promise<NotificationSettings | undefined>, subscribed: boolean): void => {
        setError(undefined);
        action().then((next) => {
            setHere(subscribed);
            if (next !== undefined) {
                onChange(next);
            }
        }, (reason: unknown) => setError(errorText(reason)));
    };
    const start = (): Promise<NotificationSettings> => subscribePush(view.webPush.publicKey).then((subscription) => api.subscribe(subscription));
    const stop = (): Promise<NotificationSettings | undefined> => unsubscribePush().then((endpoint) => (endpoint === undefined ? undefined : api.unsubscribe(endpoint)));
    return <WebPushView supported={pushSupported()} here={here} count={view.webPush.subscriptions} error={error} onStart={() => act(start, true)} onStop={() => act(stop, false)} />;
}
type WebPushViewProps = {
    readonly supported: boolean;
    readonly here: boolean | undefined;
    readonly count: number;
    readonly error: string | undefined;
    readonly onStart: () => void;
    readonly onStop: () => void;
};
function WebPushView({ supported, here, count, error, onStart, onStop }: WebPushViewProps) {
    return (
        <div className="checks" aria-label="Web Push">
            <p className="field-hint">
                Web Push: notifications on this browser even with the dashboard closed. {count === 0 ? 'No browser subscribed yet.' : `Browsers subscribed: ${count}.`}
            </p>
            {!supported
                ? <p className="note">This browser cannot take Web Push here.</p>
                : (
                    <div className="actions">
                        {here === true
                            ? <button type="button" className="btn btn-sm" onClick={onStop}>Stop on this browser</button>
                            : <button type="button" className="btn btn-sm" onClick={onStart} disabled={here === undefined}>Notify this browser</button>}
                    </div>
                )}
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </div>
    );
}
function testText(response: NotificationTestResponse): string {
    return response.results.length === 0
        ? 'No channel is switched on.'
        : response.results.map((result) => `${result.channel}: ${result.ok ? 'sent' : `failed — ${result.error ?? 'no reason'}`}`).join('; ');
}
function TestButton() {
    const [result, setResult] = useState<string>();
    const test = (): void => {
        setResult('Sending…');
        api.testNotifications().then((response) => setResult(testText(response)), (reason: unknown) => setResult(errorText(reason)));
    };
    return (
        <>
            <button type="button" className="btn btn-sm" onClick={test}>Send a test</button>
            {result === undefined ? null : <span className="note" role="status">{result}</span>}
        </>
    );
}
/**
 * Notifications outside the browser — Telegram, Web Push — for a person who
 * is not looking at the dashboard. Nothing is sent until a channel is set up.
 */
function NotificationSettingsSection() {
    const { view, draft, setDraft, error, saved, run } = useNotificationSettings();
    const submit = (event: FormEvent): void => {
        event.preventDefault();
        if (draft !== undefined) {
            run(() => api.changeNotifications(changeOf(draft)));
        }
    };
    return (
        <form className="settings-section" aria-label="Notifications" onSubmit={submit}>
            <h2>Notifications</h2>
            {view === undefined || draft === undefined
                ? <p className={error === undefined ? 'muted' : 'error'} role={error === undefined ? undefined : 'alert'}>{error ?? 'Reading the settings…'}</p>
                : <NotificationFields view={view} draft={draft} setDraft={setDraft} error={error} saved={saved} onPush={(next) => run(async () => next)} />}
        </form>
    );
}
type NotificationFieldsProps = DraftProps & {
    readonly view: NotificationSettings;
    readonly error: string | undefined;
    readonly saved: boolean;
    readonly onPush: (next: NotificationSettings) => void;
};
function NotificationFields({ view, draft, setDraft, error, saved, onPush }: NotificationFieldsProps) {
    return (
        <>
            <p className="field-hint">When you are away from the dashboard: one notification per wait, taken back once the agent has its answer.</p>
            <WhenFields draft={draft} setDraft={setDraft} />
            <TelegramFields draft={draft} setDraft={setDraft} tokenSet={view.telegram.botTokenSet} />
            <Check label="Web Push to the subscribed browsers" checked={draft.webPushEnabled} onChange={(checked) => setDraft({ ...draft, webPushEnabled: checked })} />
            <WebPushControl view={view} onChange={onPush} />
            <div className="actions">
                <button type="submit" className="btn btn-primary">Save</button>
                <TestButton />
                {saved ? <span className="note" role="status">Saved.</span> : null}
            </div>
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </>
    );
}
export { NotificationSettingsSection };
