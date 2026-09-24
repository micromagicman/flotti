import { useId } from 'react';
import { useI18n } from '../i18n/I18n.js';
import { LANGUAGES } from '../i18n/languages.js';
/**
 * The language of the dashboard (#86): each language named in itself, the
 * choice kept in this browser and shown at once, with no reload.
 */
function LanguageSection() {
    const { code, messages: t, setLanguage } = useI18n();
    const hint = useId();
    return (
        <div className="settings-section" role="group" aria-label={t.settings.languageTitle}>
            <h2>{t.settings.languageTitle}</h2>
            <div className="field-inline">
                <select className="select" aria-label={t.settings.languageLabel} aria-describedby={hint} value={code} onChange={(event) => setLanguage(event.target.value)}>
                    {LANGUAGES.map((language) => <option key={language.code} value={language.code} lang={language.code}>{language.name}</option>)}
                </select>
            </div>
            <p className="field-hint" id={hint}>{t.settings.languageHint}</p>
        </div>
    );
}
export { LanguageSection };
