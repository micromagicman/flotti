/**
 * The lint of the repository catches words of the page written into a
 * component past the strings of the languages (#86).
 */
import { deepStrictEqual } from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
// The test runs from build-test/test: the root of the repository is two levels up.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RULE = 'flotti/ui-text';
/** The lines the rule marks in a component with this code. */
async function marked(code: string, file = 'web/src/components/Probe.tsx'): Promise<number[]> {
    const eslint = new ESLint({ cwd: ROOT });
    const [result] = await eslint.lintText(code, { filePath: join(ROOT, file) });
    return (result?.messages ?? []).filter((message) => message.ruleId === RULE).map((message) => message.line);
}
describe('words of the page past the strings of the languages', () => {
    it('are caught as text, as an attribute a person reads, in an expression and in a thrown error', async () => {
        const code = [
            'export const A = () => <p>Nothing yet</p>;',
            'export const B = () => <input placeholder="Search notes…" />;',
            'export const C = ({ busy }: { busy: boolean }) => <button>{busy ? \'Sending…\' : \'Send\'}</button>;',
            'export const D = ({ n }: { n: number }) => <span aria-label={`${n} in line`} />;',
            'export const E = () => { throw new Error(\'The message did not reach the agent.\'); };',
            'export const F = () => <Field label="Adapter" hint="One per line." />;'
        ].join('\n');
        deepStrictEqual(await marked(code), [1, 2, 3, 3, 4, 5, 6, 6]);
    });
    it('let through what is not a word of the page: names, keys, marks, classes and words from the strings', async () => {
        const code = [
            'export const A = ({ t }: { t: { hi: string } }) => <p className="muted empty" data-status="idle">{t.hi}</p>;',
            'export const B = () => <span className="health-title">SSH</span>;',
            'export const C = () => <span><kbd>Shift</kbd>+<kbd>Enter</kbd> · ✕ → ↔</span>;',
            'export const D = () => <input placeholder="user@host" type="password" autoComplete="off" />;',
            'export const E = () => <option value="claude-code">Claude Code</option>;'
        ].join('\n');
        deepStrictEqual(await marked(code), []);
    });
});
