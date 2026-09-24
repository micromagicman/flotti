import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { en } from '../web/src/i18n/en.js';
import { StatusError, errorText } from '../web/src/i18n/errors.js';
import { LANGUAGES, languageOf, preferredLanguage } from '../web/src/i18n/languages.js';
/** Every key of the strings, as a path, with what is there: text, a function of so many arguments, or a group. */
function shape(value: unknown, path = ''): string[] {
    if (typeof value === 'string') {
        return [`${path}: text`];
    }
    if (typeof value === 'function') {
        return [`${path}: function/${value.length}`];
    }
    return Object.entries(value as Record<string, unknown>)
        .sort(([one], [other]) => one.localeCompare(other))
        .flatMap(([key, inner]) => shape(inner, path === '' ? key : `${path}.${key}`));
}
/** The texts of the strings that are plain text, with where they are. */
function texts(value: unknown, path = ''): [string, string][] {
    if (typeof value === 'string') {
        return [[path, value]];
    }
    if (typeof value !== 'object' || value === null) {
        return [];
    }
    return Object.entries(value).flatMap(([key, inner]) => texts(inner, path === '' ? key : `${path}.${key}`));
}
describe('the languages of the dashboard', () => {
    it('every language has the same keys as English, each of the same kind', () => {
        const english = shape(en);
        for (const language of LANGUAGES) {
            deepStrictEqual(shape(language.messages), english, language.code);
        }
    });
    it('no text of a language is left empty', () => {
        for (const language of LANGUAGES) {
            deepStrictEqual(texts(language.messages).filter(([, text]) => text.trim() === '').map(([path]) => path), [], language.code);
        }
    });
    it('opens in the first language of the browser it speaks, and in English when it speaks none', () => {
        strictEqual(preferredLanguage(['ru-RU', 'en-US']).code, 'ru');
        strictEqual(preferredLanguage(['de-DE', 'RU']).code, 'ru');
        strictEqual(preferredLanguage(['en-GB', 'ru']).code, 'en');
        strictEqual(preferredLanguage(['de-DE', 'fr']).code, 'en');
        strictEqual(preferredLanguage([]).code, 'en');
        strictEqual(languageOf('xx').code, 'en');
    });
    it('writes numbers, counts and dates the way the language does', () => {
        const ru = languageOf('ru').messages;
        deepStrictEqual([1, 2, 5, 21, 1_000].map((n) => ru.common.messages(n)), ['1 сообщение', '2 сообщения', '5 сообщений', '21 сообщение', '1 000 сообщений']);
        deepStrictEqual([1, 2].map((n) => en.common.messages(n)), ['1 message', '2 messages']);
        strictEqual(en.common.inLine(1_000), '1,000 in line');
        strictEqual(ru.health.duration(3_725_000), '1 ч 2 мин');
        const time = new Date(2026, 8, 24, 15, 30);
        ok(languageOf('ru').format.dateTime(time).startsWith('24 сент. 2026'), languageOf('ru').format.dateTime(time));
        ok(languageOf('en').format.dateTime(time).startsWith('Sep 24, 2026'), languageOf('en').format.dateTime(time));
    });
    it('says an answer of the dashboard with no reason in the language of the page, and a reason as it came', () => {
        const ru = languageOf('ru').messages;
        strictEqual(errorText(new StatusError(502), ru), 'Дашборд ответил кодом 502.');
        strictEqual(errorText(new StatusError(502), en), 'The dashboard answered 502.');
        strictEqual(errorText(new Error('No such agent.'), ru), 'No such agent.');
    });
});
