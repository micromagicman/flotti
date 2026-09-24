import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseInline, parseMarkdown, plainText } from '../web/src/markdown.js';
import { changedAgo, firstNote, memoryTree } from '../web/src/memory.js';
import type { MemoryFolder } from '../web/src/memory.js';
import { en } from '../web/src/i18n/en.js';
import { ru } from '../web/src/i18n/ru.js';
describe('the markdown of a note', () => {
    it('cuts inline markup into pieces: code, strong, emphasis, links and wikilinks', () => {
        deepStrictEqual(parseInline('Run `npm test`, **then [[Deploy checklist|the list]]**, *carefully*: https://example.com'), [
            { kind: 'text', text: 'Run ' },
            { kind: 'code', text: 'npm test' },
            { kind: 'text', text: ', ' },
            { kind: 'strong', children: [{ kind: 'text', text: 'then ' }, { kind: 'wikilink', target: 'Deploy checklist', text: 'the list' }] },
            { kind: 'text', text: ', ' },
            { kind: 'em', children: [{ kind: 'text', text: 'carefully' }] },
            { kind: 'text', text: ': ' },
            { kind: 'link', text: 'https://example.com', href: 'https://example.com/' }
        ]);
    });
    it('keeps raw HTML as text, and markup inside code as it is', () => {
        deepStrictEqual(parseInline('<img src=x onerror=alert(1)> `**no**`'), [
            { kind: 'text', text: '<img src=x onerror=alert(1)> ' },
            { kind: 'code', text: '**no**' }
        ]);
    });
    it('does not take a snake_case word or a lone star for emphasis', () => {
        deepStrictEqual(parseInline('a snake_case_name and 2 * 3'), [{ kind: 'text', text: 'a snake_case_name and 2 * 3' }]);
    });
    it('reads headings, paragraphs, lists with tasks, quotes, code, rules and front matter', () => {
        const blocks = parseMarkdown('---\ntags: [a]\n---\n# Title\nline one\nline two\n\n- [x] done\n  - nested\n1. first\n> quoted\n```ts\nconst a = 1;\n```\n---\n');
        deepStrictEqual(blocks.map((block) => block.kind), ['code', 'heading', 'paragraph', 'list', 'list', 'quote', 'code', 'rule']);
        deepStrictEqual(blocks[0], { kind: 'code', text: 'tags: [a]', properties: true });
        deepStrictEqual(blocks[2], { kind: 'paragraph', content: [{ kind: 'text', text: 'line one' }, { kind: 'break' }, { kind: 'text', text: 'line two' }] });
        deepStrictEqual(blocks[3], { kind: 'list', ordered: false, items: [
            { depth: 0, checked: true, content: [{ kind: 'text', text: 'done' }] },
            { depth: 1, content: [{ kind: 'text', text: 'nested' }] }
        ] });
        strictEqual(blocks[4]?.kind === 'list' && blocks[4].ordered, true);
        deepStrictEqual(blocks[6], { kind: 'code', text: 'const a = 1;' });
    });
    it('gives the plain words of a heading, to compare it with the title', () => {
        strictEqual(plainText(parseInline('The **[[Release]]** `v1`')), 'The Release v1');
    });
});
describe('the notes in the Memory view', () => {
    const note = (path: string, title: string) => ({ path, title, modifiedAt: 0, size: 1, links: [] });
    it('lays the notes out in their folders, notes first, each by name', () => {
        const tree = memoryTree([note('b/z.md', 'Z'), note('index.md', 'Home'), note('b/c/d.md', 'D'), note('a/x.md', 'X')]);
        const shape = (folder: MemoryFolder): unknown => [folder.path, folder.notes.map((n) => n.title), folder.folders.map(shape)];
        deepStrictEqual(shape(tree), ['', ['Home'], [['a', ['X'], []], ['b', ['Z'], [['b/c', ['D'], []]]]]]);
    });
    it('opens the home note first, else the first note at the top', () => {
        strictEqual(firstNote([note('a/b.md', 'B'), note('top.md', 'Top'), note('README.md', 'Read me')])?.path, 'README.md');
        strictEqual(firstNote([note('a/b.md', 'B'), note('top.md', 'Top')])?.path, 'top.md');
        strictEqual(firstNote([]), undefined);
    });
    it('says in words how long ago a note changed', () => {
        const now = Date.UTC(2026, 8, 24, 12);
        const minutes = [0, 5, 180, 60 * 30, 60 * 72, 60 * 24 * 30];
        deepStrictEqual(minutes.map((ago) => changedAgo(now - ago * 60_000, now, en)), [
            'just now', '5 min ago', '3 h ago', 'yesterday', '3 days ago', 'Aug 25, 2026'
        ]);
        deepStrictEqual(minutes.map((ago) => changedAgo(now - ago * 60_000, now, ru)), [
            'только что', '5 мин назад', '3 ч назад', 'вчера', '3 дня назад', '25 авг. 2026 г.'
        ]);
    });
});
