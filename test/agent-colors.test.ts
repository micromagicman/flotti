import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { PALETTE_SIZE, assignColors } from '../web/src/agent-colors.js';
test('an agent keeps the colour it was given', () => {
    const colors = assignColors(['a', 'b'], { a: 4, b: 1 }, () => 0);
    deepStrictEqual(colors, { a: 4, b: 1 });
});
test('a new agent gets a random colour no other agent has, while there are such', () => {
    const colors = assignColors(['a', 'b', 'c'], { a: 0 }, () => 0.99);
    strictEqual(colors['a'], 0);
    strictEqual(colors['b'], PALETTE_SIZE - 1, 'the pick is random among the free colours');
    strictEqual(new Set(Object.values(colors)).size, 3);
});
test('a fleet larger than the palette uses every colour before it repeats one', () => {
    const ids = Array.from({ length: PALETTE_SIZE + 2 }, (_, index) => `agent-${index}`);
    const colors = assignColors(ids, {}, Math.random);
    const uses = new Array<number>(PALETTE_SIZE).fill(0);
    for (const id of ids) {
        const color = colors[id] ?? -1;
        uses[color] = (uses[color] ?? 0) + 1;
    }
    deepStrictEqual(uses.map((count) => count >= 1 && count <= 2), new Array<boolean>(PALETTE_SIZE).fill(true));
});
test('the colour of an agent that is gone is kept for when it comes back; a broken one is picked again', () => {
    const colors = assignColors(['a'], { gone: 2, a: 17 }, () => 0);
    strictEqual(colors['gone'], 2);
    strictEqual(colors['a'], 0);
});
