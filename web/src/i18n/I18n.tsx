/**
 * The language of the page: picked in the settings and kept in this browser;
 * until then, the first language of the browser the dashboard speaks. A change
 * shows at once, without a reload (#86).
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { isLanguage, languageOf, preferredLanguage } from './languages.js';
import type { Language } from './languages.js';
const STORAGE_KEY = 'flotti.language';
type I18n = Language & { readonly setLanguage: (code: string) => void };
/** The saved choice; nothing when there is none or the storage is shut. */
function savedCode(): string | undefined {
    try {
        const code = window.localStorage.getItem(STORAGE_KEY);
        return isLanguage(code) ? code : undefined;
    } catch {
        return undefined;
    }
}
function save(code: string): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, code);
    } catch {
        // A browser that keeps nothing still switches; the choice lasts until the page is closed.
    }
}
function initialLanguage(): Language {
    const saved = savedCode();
    return saved === undefined ? preferredLanguage(navigator.languages ?? [navigator.language]) : languageOf(saved);
}
const Context = createContext<I18n>({ ...languageOf('en'), setLanguage: () => undefined });
function I18nProvider({ children }: { readonly children: ReactNode }) {
    const [language, setLanguage] = useState(initialLanguage);
    useEffect(() => {
        document.documentElement.lang = language.code;
    }, [language]);
    const value = useMemo<I18n>(() => ({
        ...language,
        setLanguage: (code) => {
            save(code);
            setLanguage(languageOf(code));
        }
    }), [language]);
    return <Context.Provider value={value}>{children}</Context.Provider>;
}
/** The language of the page: its words (`messages`), numbers and dates (`format`), and the way to change it. */
function useI18n(): I18n {
    return useContext(Context);
}
/** The words of the page in its language. */
function useT() {
    return useI18n().messages;
}
export { I18nProvider, useI18n, useT };
