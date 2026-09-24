import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { linkify } from '../web/src/links.js';
import type { Piece } from '../web/src/links.js';
/** The pieces as short strings: `text` for text, `[text](href)` for a link. */
function shown(text: string): string[] {
    return linkify(text).map((piece: Piece) => (piece.kind === 'text' ? piece.text : `[${piece.text}](${piece.href})`));
}
test('text without links is one piece of text', () => {
    deepStrictEqual(shown('no links here'), ['no links here']);
    deepStrictEqual(shown(''), []);
});
test('an http or https address is a link, with the text around it kept', () => {
    deepStrictEqual(shown('see https://example.com/docs?a=1&b=2#part and http://example.org'), [
        'see ',
        '[https://example.com/docs?a=1&b=2#part](https://example.com/docs?a=1&b=2#part)',
        ' and ',
        '[http://example.org](http://example.org/)'
    ]);
});
test('punctuation that ends the sentence stays out of the link', () => {
    deepStrictEqual(shown('Done: https://example.com/a.'), ['Done: ', '[https://example.com/a](https://example.com/a)', '.']);
    deepStrictEqual(shown('https://example.com/a, then'), ['[https://example.com/a](https://example.com/a)', ', then']);
    deepStrictEqual(shown('(see https://example.com/a)'), ['(see ', '[https://example.com/a](https://example.com/a)', ')']);
    deepStrictEqual(shown('really https://example.com/a?!'), ['really ', '[https://example.com/a](https://example.com/a)', '?!']);
    deepStrictEqual(shown('(at https://example.com/a).'), ['(at ', '[https://example.com/a](https://example.com/a)', ').']);
});
test('a bracket the address opened is part of it', () => {
    deepStrictEqual(shown('https://en.wikipedia.org/wiki/Link_(disambiguation).'), [
        '[https://en.wikipedia.org/wiki/Link_(disambiguation)](https://en.wikipedia.org/wiki/Link_(disambiguation))',
        '.'
    ]);
});
test('an address on a line of its own, in quotes or angle brackets ends where they do', () => {
    deepStrictEqual(shown('one\nhttps://example.com/x\ntwo'), ['one\n', '[https://example.com/x](https://example.com/x)', '\ntwo']);
    deepStrictEqual(shown('"https://example.com/x"'), ['"', '[https://example.com/x](https://example.com/x)', '"']);
    deepStrictEqual(shown('<https://example.com/x>'), ['<', '[https://example.com/x](https://example.com/x)', '>']);
});
test('a markdown link shows its label and leads to its address', () => {
    deepStrictEqual(shown('Read [the guide](https://example.com/guide), then ask.'), [
        'Read ',
        '[the guide](https://example.com/guide)',
        ', then ask.'
    ]);
    deepStrictEqual(shown('[wiki](https://en.wikipedia.org/wiki/Link_(disambiguation))'), [
        '[wiki](https://en.wikipedia.org/wiki/Link_(disambiguation))'
    ]);
});
test('only http and https lead anywhere: other schemes stay text', () => {
    deepStrictEqual(shown('[click](javascript:alert(1))'), ['[click](javascript:alert(1))']);
    deepStrictEqual(shown('ftp://example.com and mailto:someone@example.com'), ['ftp://example.com and mailto:someone@example.com']);
    deepStrictEqual(shown('just https:// and nothing'), ['just https:// and nothing']);
});
test('markup in the text is text, links included', () => {
    const text = '<img src=x onerror=alert(1)> https://example.com/"><script>alert(1)</script>';
    const pieces = linkify(text);
    strictEqual(pieces.map((piece) => piece.text).join(''), text);
    deepStrictEqual(pieces.filter((piece) => piece.kind === 'link').map((piece) => piece.href), ['https://example.com/']);
});
test('joined back, the pieces give the text of the message', () => {
    const text = 'a https://example.com/a. b [c](http://example.com/c) (https://example.com/d) e';
    strictEqual(linkify(text).map((piece) => piece.text === 'c' ? '[c](http://example.com/c)' : piece.text).join(''), text);
});
