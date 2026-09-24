import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { NotificationEvents, NotificationSettings, NotificationSettingsChange, NotificationTestResponse } from '../../../src/dashboard-protocol.js';
import { api } from '../api.js';
import { currentSubscription, pushSupported, subscribePush, unsubscribePush } from '../push.js';
import { Field } from './AgentForm.js';
import { useT } from '../i18n/I18n.js';
import { errorText } from '../i18n/errors.js';
import type { Messages } from '../i18n/en.js';
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
const EVENTS: readonly (keyof NotificationEvents)[] = ['waiting', 'error', 'connection'];
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
    const t = useT();
    return (
        <fieldset className="checks" aria-label={t.notifications.when}>
            {EVENTS.map((name) => (
                <Check key={name} label={t.notifications.events[name]} checked={draft.events[name]} onChange={(checked) => setDraft({ ...draft, events: { ...draft.events, [name]: checked } })} />
            ))}
            <div className="field-row">
                <Field label={t.notifications.remind} hint={t.notifications.remindHint}>
                    <input className="input" inputMode="numeric" value={draft.repeatMinutes} onChange={(event) => setDraft({ ...draft, repeatMinutes: event.target.value })} />
                </Field>
                <Field label={t.notifications.link} hint={t.notifications.linkHint}>
                    <input className="input" value={draft.dashboardUrl} placeholder="http://127.0.0.1:4870/" onChange={(event) => setDraft({ ...draft, dashboardUrl: event.target.value })} />
                </Field>
            </div>
        </fieldset>
    );
}
/** A bot of the person's own: its token and the chat it writes to. */
function TelegramFields({ draft, setDraft, tokenSet }: DraftProps & { readonly tokenSet: boolean }) {
    const t = useT();
    return (
        <fieldset className="checks" aria-label={t.notifications.telegram}>
            <Check label={t.notifications.telegram} checked={draft.telegramEnabled} onChange={(checked) => setDraft({ ...draft, telegramEnabled: checked })} />
            <div className="field-row">
                <Field label={t.notifications.botToken} hint={tokenSet ? t.notifications.botTokenSaved : t.notifications.botTokenNew}>
                    <input className="input" type="password" autoComplete="off" value={draft.botToken} placeholder={tokenSet ? t.notifications.savedPlaceholder : '123456:ABC…'} onChange={(event) => setDraft({ ...draft, botToken: event.target.value })} />
                </Field>
                <Field label={t.notifications.chatId} hint={t.notifications.chatIdHint}>
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
    const t = useT();
    useEffect(() => {
        api.notifications().then(show, (reason: unknown) => setError(errorText(reason, t)));
    }, []);
    const run = (action: () => Promise<NotificationSettings>): void => {
        setError(undefined);
        setSaved(false);
        action().then((next) => {
            show(next);
            setSaved(true);
        }, (reason: unknown) => setError(errorText(reason, t)));
    };
    return { view, draft, setDraft, error, saved, run };
}
/** Web Push on this very browser: subscribed or not, and the button to change it. */
function WebPushControl({ view, onChange }: { readonly view: NotificationSettings; readonly onChange: (next: NotificationSettings) => void }) {
    const [here, setHere] = useState<boolean>();
    const [error, setError] = useState<string>();
    const t = useT();
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
        }, (reason: unknown) => setError(errorText(reason, t)));
    };
    const start = (): Promise<NotificationSettings> => subscribePush(view.webPush.publicKey, t.errors.notifyRefused).then((subscription) => api.subscribe(subscription));
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
    const t = useT();
    return (
        <div className="checks" aria-label={t.notifications.webPush}>
            <p className="field-hint">
                {t.notifications.webPushLead} {count === 0 ? t.notifications.noBrowser : t.notifications.browsers(count)}
            </p>
            {!supported
                ? <p className="note">{t.notifications.unsupported}</p>
                : (
                    <div className="actions">
                        {here === true
                            ? <button type="button" className="btn btn-sm" onClick={onStop}>{t.notifications.stopHere}</button>
                            : <button type="button" className="btn btn-sm" onClick={onStart} disabled={here === undefined}>{t.notifications.notifyHere}</button>}
                    </div>
                )}
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </div>
    );
}
function testText(response: NotificationTestResponse, t: Messages): string {
    return response.results.length === 0
        ? t.notifications.noChannel
        : response.results.map((result) => `${result.channel}: ${result.ok ? t.notifications.sent : t.notifications.failed(result.error)}`).join('; ');
}
function TestButton() {
    const [result, setResult] = useState<string>();
    const t = useT();
    const test = (): void => {
        setResult(t.notifications.sending);
        api.testNotifications().then((response) => setResult(testText(response, t)), (reason: unknown) => setResult(errorText(reason, t)));
    };
    return (
        <>
            <button type="button" className="btn btn-sm" onClick={test}>{t.notifications.test}</button>
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
    const t = useT();
    const submit = (event: FormEvent): void => {
        event.preventDefault();
        if (draft !== undefined) {
            run(() => api.changeNotifications(changeOf(draft)));
        }
    };
    return (
        <form className="settings-section" aria-label={t.notifications.title} onSubmit={submit}>
            <h2>{t.notifications.title}</h2>
            {view === undefined || draft === undefined
                ? <p className={error === undefined ? 'muted' : 'error'} role={error === undefined ? undefined : 'alert'}>{error ?? t.notifications.reading}</p>
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
    const t = useT();
    return (
        <>
            <p className="field-hint">{t.notifications.lead}</p>
            <WhenFields draft={draft} setDraft={setDraft} />
            <TelegramFields draft={draft} setDraft={setDraft} tokenSet={view.telegram.botTokenSet} />
            <Check label={t.notifications.webPushEnabled} checked={draft.webPushEnabled} onChange={(checked) => setDraft({ ...draft, webPushEnabled: checked })} />
            <WebPushControl view={view} onChange={onPush} />
            <div className="actions">
                <button type="submit" className="btn btn-primary">{t.common.save}</button>
                <TestButton />
                {saved ? <span className="note" role="status">{t.notifications.saved}</span> : null}
            </div>
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </>
    );
}
export { NotificationSettingsSection };
