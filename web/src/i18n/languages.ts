/**
 * The languages of the dashboard (#86). A new one is a file of strings like
 * en.ts, and a line here.
 */
import { en } from './en.js';
import type { Messages } from './en.js';
import { formatFor } from './format.js';
import type { Format } from './format.js';
import { ru } from './ru.js';
type Language = {
    /** The code the browser says a language by: `en`, `ru`. */
    readonly code: string;
    /** The name of the language in itself, as the picker shows it. */
    readonly name: string;
    readonly messages: Messages;
    readonly format: Format;
};
const LANGUAGES: readonly Language[] = [
    { code: 'en', name: 'English', messages: en, format: formatFor('en') },
    { code: 'ru', name: 'Русский', messages: ru, format: formatFor('ru') }
];
const FALLBACK = LANGUAGES[0] as Language;
/** Whether the dashboard speaks the language of this code. */
function isLanguage(code: string | null | undefined): code is string {
    return LANGUAGES.some((language) => language.code === code);
}
/** The language of this code; English when the dashboard does not speak it. */
function languageOf(code: string | null | undefined): Language {
    return LANGUAGES.find((language) => language.code === code) ?? FALLBACK;
}
/**
 * The first language of the browser the dashboard speaks — `ru-RU` is `ru` —
 * and English when it speaks none of them.
 */
function preferredLanguage(browser: readonly string[]): Language {
    const code = browser.map((tag) => tag.toLowerCase().split('-')[0]).find(isLanguage);
    return languageOf(code);
}
export { LANGUAGES, isLanguage, languageOf, preferredLanguage };
export type { Language };
