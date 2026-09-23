import { defineConfig } from '@playwright/test';
/**
 * The dashboard end to end: a real `flotti run` with pretend agents, driven
 * in a real browser. `npm run test:e2e` builds everything first.
 *
 * The browser is Playwright's Chromium (`npx playwright install chromium`);
 * FLOTTI_E2E_CHROMIUM points at another Chromium when that one is not there.
 */
const executablePath = process.env['FLOTTI_E2E_CHROMIUM'];
export default defineConfig({
    testDir: '.',
    timeout: 60_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    workers: 1,
    reporter: 'list',
    use: {
        browserName: 'chromium',
        headless: true,
        ...(executablePath === undefined || executablePath === '' ? {} : { launchOptions: { executablePath } })
    }
});
