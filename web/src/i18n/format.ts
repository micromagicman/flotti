/**
 * Numbers, dates and plural forms in the words of one language. Each file of
 * strings makes its own with its locale; pure, so the tests use it too.
 */
/** The plural forms a language picks from; `other` is the one every language has. */
type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { readonly other: string };
/** The units of a duration: `5 s`, `3 min 20 s`, `2 h 5 min`, `3 d 4 h`. */
type DurationUnits = { readonly s: string; readonly min: string; readonly h: string; readonly d: string };
type Format = {
    readonly locale: string;
    readonly number: (n: number) => string;
    /** The form of the word that goes with `n`. */
    readonly plural: (n: number, forms: PluralForms) => string;
    /** A day, as the language writes it. */
    readonly date: (time: number | Date) => string;
    /** A day and a time of it, as the language writes them. */
    readonly dateTime: (time: number | Date) => string;
    /** A duration the way a person reads it, in whole units, the two largest. */
    readonly duration: (ms: number, units: DurationUnits) => string;
};
function duration(number: Format['number'], ms: number, units: DurationUnits): string {
    const seconds = Math.max(0, Math.floor(ms / 1_000));
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (seconds < 60) {
        return `${number(seconds)} ${units.s}`;
    }
    if (minutes < 60) {
        return `${number(minutes)} ${units.min} ${number(seconds % 60)} ${units.s}`;
    }
    if (hours < 24) {
        return `${number(hours)} ${units.h} ${number(minutes % 60)} ${units.min}`;
    }
    return `${number(Math.floor(hours / 24))} ${units.d} ${number(hours % 24)} ${units.h}`;
}
function formatFor(locale: string): Format {
    const numbers = new Intl.NumberFormat(locale);
    const plurals = new Intl.PluralRules(locale);
    const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
    const times = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
    const number = (n: number): string => numbers.format(n);
    return {
        locale,
        number,
        plural: (n, forms) => forms[plurals.select(n)] ?? forms.other,
        date: (time) => dates.format(time),
        dateTime: (time) => times.format(time),
        duration: (ms, units) => duration(number, ms, units)
    };
}
export { formatFor };
export type { DurationUnits, Format, PluralForms };
