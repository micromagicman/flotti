/**
 * The colour scheme of a story. The dashboard has no theme switch: its dark
 * colours sit behind `@media (prefers-color-scheme: dark)` in styles.css. A
 * story gets a theme by rewriting that media query — to `all` for dark, to
 * `not all` for light — and `system` puts it back and follows the OS.
 */
type Scheme = 'system' | 'light' | 'dark';
const DARK_QUERY = '(prefers-color-scheme: dark)';
const MEDIA_OF: Readonly<Record<Scheme, string>> = { system: DARK_QUERY, light: 'not all', dark: 'all' };
/** The rules once behind the dark query: found by the query, then remembered, as a rewrite hides them. */
const darkRules = new Set<CSSMediaRule>();
function rulesOf(sheet: CSSStyleSheet): CSSRuleList | undefined {
    try {
        return sheet.cssRules;
    } catch {
        return undefined;
    }
}
function collectDarkRules(): void {
    for (const sheet of document.styleSheets) {
        for (const rule of rulesOf(sheet) ?? []) {
            if (rule instanceof CSSMediaRule && rule.media.mediaText.includes(DARK_QUERY)) {
                darkRules.add(rule);
            }
        }
    }
}
function applyScheme(scheme: Scheme): void {
    collectDarkRules();
    for (const rule of darkRules) {
        rule.media.mediaText = MEDIA_OF[scheme];
    }
    document.documentElement.style.colorScheme = scheme === 'system' ? '' : scheme;
}
export { applyScheme };
export type { Scheme };
