import { useEffect, useId, useState } from 'react';
import type { AnswerDelivery } from '../../../src/answer-delivery.js';
import { api } from '../api.js';
import { useT } from '../i18n/I18n.js';
import { errorText } from '../i18n/errors.js';
/** The choice as the server has it: saved at once, read back from the answer. */
function useAnswerDelivery() {
    const [mode, setMode] = useState<AnswerDelivery>();
    const [error, setError] = useState<string>();
    const t = useT();
    useEffect(() => {
        api.answerDelivery().then((found) => setMode(found.mode), (reason: unknown) => setError(errorText(reason, t)));
    }, []);
    const change = (next: AnswerDelivery): void => {
        const before = mode;
        setError(undefined);
        // The choice follows the click at once; what the server saved, or the choice before, comes after.
        setMode(next);
        api.setAnswerDelivery({ mode: next }).then((found) => setMode(found.mode), (reason: unknown) => {
            setMode(before);
            setError(errorText(reason, t));
        });
    };
    return { mode, error, change };
}
type ChoiceProps = { readonly mode: AnswerDelivery; readonly hint: string; readonly change: (next: AnswerDelivery) => void };
/** The two ways, the one chosen selected. */
function DeliveryChoice({ mode, hint, change }: ChoiceProps) {
    const t = useT();
    return (
        <div className="field-inline">
            <select className="select" aria-label={t.settings.answersLabel} aria-describedby={hint} value={mode} onChange={(event) => change(event.target.value as AnswerDelivery)}>
                <option value="streamed">{t.settings.answersStreamed}</option>
                <option value="whole">{t.settings.answersWhole}</option>
            </select>
        </div>
    );
}
/**
 * How the answers of the agents reach the dashboard (#157): piece by piece as
 * they are written, or whole once complete — one rule for every agent, saved
 * on the server and applied to the next message.
 */
function AnswerDeliverySection() {
    const { mode, error, change } = useAnswerDelivery();
    const t = useT();
    const hint = useId();
    return (
        <div className="settings-section" role="group" aria-label={t.settings.answersTitle}>
            <h2>{t.settings.answersTitle}</h2>
            {/* No choice until the server has said: a select would claim one while the setting may be the other. */}
            {mode === undefined
                ? (error === undefined ? <p className="muted">{t.settings.readingAnswers}</p> : null)
                : <DeliveryChoice mode={mode} hint={hint} change={change} />}
            <p className="field-hint" id={hint}>{t.settings.answersHint}</p>
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </div>
    );
}
export { AnswerDeliverySection };
