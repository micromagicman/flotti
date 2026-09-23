/**
 * The colour of each agent, for the messages agents send one another: picked
 * at random the first time an agent is seen, and kept from then on. Pure, no
 * React and no browser: use-agent-colors.ts keeps the picks, the tests share it.
 */
/** How many colours there are: `.agent-color-0` … in styles.css. */
const PALETTE_SIZE = 6;
type AgentColors = Readonly<Record<string, number>>;
/**
 * Gives every agent of `ids` a colour. An agent keeps the colour it had; a new
 * one gets a random colour out of those the fewest agents of `ids` have, so a
 * small fleet has no two agents of one colour.
 *
 * @param kept Colours picked before, of these agents and of agents gone since: those are kept too, for when they come back.
 * @param random A number in [0, 1), like `Math.random`.
 */
function assignColors(ids: readonly string[], kept: AgentColors, random: () => number = Math.random): AgentColors {
    const colors: Record<string, number> = { ...kept };
    const uses = new Array<number>(PALETTE_SIZE).fill(0);
    const fresh: string[] = [];
    for (const id of ids) {
        const color = colors[id];
        if (color !== undefined && Number.isInteger(color) && color >= 0 && color < PALETTE_SIZE) {
            uses[color] = (uses[color] ?? 0) + 1;
        } else {
            fresh.push(id);
        }
    }
    for (const id of fresh) {
        const fewest = Math.min(...uses);
        const free = uses.flatMap((count, color) => (count === fewest ? [color] : []));
        const color = free[Math.min(free.length - 1, Math.floor(random() * free.length))] ?? 0;
        colors[id] = color;
        uses[color] = (uses[color] ?? 0) + 1;
    }
    return colors;
}
export { PALETTE_SIZE, assignColors };
export type { AgentColors };
