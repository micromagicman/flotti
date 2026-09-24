import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ConfigurationError } from '../src/errors.js';
import { NotificationService } from '../src/notifications.js';
import { Supervisor } from '../src/supervisor.js';
import { fakeFleet } from './fake-fleet-agent.js';
import { FakeTelegram } from './fake-telegram.js';
const homes = mkdtempSync(join(tmpdir(), 'flotti-notify-'));
const telegram = await FakeTelegram.start();
after(async () => {
    await telegram.close();
    rmSync(homes, { recursive: true, force: true });
});
let made = 0;
/** A fleet of pretend agents and its notifications, with a home directory of its own. */
async function notified(settings?: object) {
    const home = join(homes, `home-${++made}`);
    mkdirSync(join(home, '.flotti'), { recursive: true });
    if (settings !== undefined) {
        writeFileSync(join(home, '.flotti', 'settings.json'), JSON.stringify(settings));
    }
    const { fleet, fakes, createAgent } = fakeFleet('reviewer');
    const supervisor = new Supervisor(fleet, { createAgent });
    await supervisor.start();
    const warnings: string[] = [];
    const env = { HOME: home, FLOTTI_TELEGRAM_API: telegram.url };
    const service = new NotificationService(supervisor, { env, dashboardUrl: 'http://127.0.0.1:4870/', warn: (line) => warnings.push(line) });
    const reviewer = fakes.get('reviewer');
    if (reviewer === undefined) {
        throw new Error('no fake');
    }
    const file = join(home, '.flotti', 'settings.json');
    return { service, reviewer, warnings, file, stop: async () => {
        service.close();
        await supervisor.stop();
    } };
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));
test('without settings nothing is sent and nothing is written', async () => {
    const { service, reviewer, file, stop } = await notified();
    telegram.calls.length = 0;
    const view = service.view();
    deepStrictEqual({ ...view, webPush: { ...view.webPush, publicKey: '-' } }, {
        events: { waiting: true, error: true, connection: true },
        repeatMinutes: 0,
        telegram: { enabled: false, botTokenSet: false },
        webPush: { enabled: false, publicKey: '-', subscriptions: 0 }
    });
    reviewer.askPermission('r1');
    reviewer.emit({ type: 'status', status: 'waiting' });
    await settle();
    deepStrictEqual(telegram.calls, []);
    throws(() => statSync(file), /ENOENT/);
    await stop();
});
test('with Telegram on, a wait is one message, and the answer deletes it', async () => {
    const { service, reviewer, file, stop } = await notified({ fleet: '/somewhere' });
    telegram.calls.length = 0;
    service.change({ telegram: { enabled: true, botToken: telegram.token, chatId: '42' } });
    reviewer.askPermission('r1');
    reviewer.emit({ type: 'status', status: 'waiting' });
    reviewer.emit({ type: 'status', status: 'waiting', reason: 'still' });
    const [sent] = await telegram.waitFor('sendMessage');
    strictEqual(sent?.body['text'], 'REVIEWER is waiting for you\nAsks for permission: Delete everything\nhttp://127.0.0.1:4870/#/reviewer');
    reviewer.emit({ type: 'status', status: 'working' });
    await telegram.waitFor('deleteMessage');
    strictEqual(telegram.of('sendMessage').length, 1);
    deepStrictEqual(telegram.of('deleteMessage').map((call) => call.body['chat_id']), ['42']);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { fleet: string; notifications: { telegram: { botToken: string } } };
    strictEqual(saved.fleet, '/somewhere', 'the rest of the settings is kept');
    strictEqual(saved.notifications.telegram.botToken, telegram.token);
    if (process.platform !== 'win32') {
        // Windows has no POSIX modes: stat reports 0o666 or 0o444 whatever chmod asked.
        strictEqual(statSync(file).mode & 0o777, 0o600, 'only the owner reads the file with the token');
    }
    await stop();
});
test('the page never sees the bot token, and keeps it by leaving it out', async () => {
    const { service, stop } = await notified();
    const view = service.change({ telegram: { enabled: true, botToken: telegram.token, chatId: '42' }, repeatMinutes: 15 });
    ok(!JSON.stringify(view).includes(telegram.token));
    deepStrictEqual(view.telegram, { enabled: true, chatId: '42', botTokenSet: true });
    strictEqual(service.change({ telegram: { chatId: '43' } }).telegram.botTokenSet, true);
    strictEqual(service.change({ telegram: { enabled: false, botToken: '' } }).telegram.botTokenSet, false);
    await stop();
});
test('a change that is not right is refused and changes nothing', async () => {
    const { service, stop } = await notified();
    for (const wrong of [
        { telegram: { enabled: true } },
        { repeatMinutes: -1 },
        { repeatMinutes: 1.5 },
        { dashboardUrl: 'ftp://somewhere' },
        { events: 'all' as unknown as object, telegram: { enabled: 'yes' } }
    ]) {
        throws(() => service.change(wrong), ConfigurationError, JSON.stringify(wrong));
    }
    strictEqual(service.view().telegram.enabled, false);
    strictEqual(service.change({ dashboardUrl: 'https://fleet.example.org/' }).dashboardUrl, 'https://fleet.example.org/');
    strictEqual(service.change({ dashboardUrl: '' }).dashboardUrl, undefined);
    await stop();
});
test('a failed message is reported without the token, and the test says how each channel went', async () => {
    const { service, reviewer, warnings, stop } = await notified({
        notifications: { telegram: { enabled: true, botToken: telegram.token, chatId: '42' } }
    });
    telegram.refuse.add('sendMessage');
    try {
        reviewer.emit({ type: 'status', status: 'error', reason: 'the adapter crashed' });
        await telegram.waitFor('sendMessage');
        await settle();
        strictEqual(warnings.length, 1);
        ok(warnings[0]?.startsWith('flotti: a telegram notification failed: sendMessage: Telegram answered 400'), warnings[0]);
        ok(!warnings.some((line) => line.includes(telegram.token)));
        const result = await service.test();
        deepStrictEqual(result.results.map(({ channel, ok: went }) => [channel, went]), [['telegram', false]]);
        ok(!JSON.stringify(result).includes(telegram.token));
    } finally {
        telegram.refuse.delete('sendMessage');
    }
    deepStrictEqual((await service.test()).results, [{ channel: 'telegram', ok: true }]);
    await stop();
});
test('a browser that subscribes switches Web Push on; the keys are made once and kept', async () => {
    const { service, file, stop } = await notified();
    const publicKey = service.view().webPush.publicKey;
    const subscription = { endpoint: 'https://push.example.org/abc', keys: { p256dh: 'BExample', auth: 'secret' } };
    const view = service.subscribe(subscription);
    deepStrictEqual(view.webPush, { enabled: true, publicKey, subscriptions: 1 });
    strictEqual(service.subscribe(subscription).webPush.subscriptions, 1, 'the same browser twice is one');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { notifications: { webPush: { vapid: { publicKey: string; privateKey: string } } } };
    strictEqual(saved.notifications.webPush.vapid.publicKey, publicKey);
    ok(!JSON.stringify(view).includes(saved.notifications.webPush.vapid.privateKey));
    strictEqual(service.unsubscribe({ endpoint: subscription.endpoint }).webPush.subscriptions, 0);
    throws(() => service.subscribe({ endpoint: 'https://push.example.org/abc' }), ConfigurationError);
    await stop();
});
