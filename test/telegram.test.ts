import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Notice } from '../src/notifier.js';
import { TelegramChannel } from '../src/telegram.js';
import { FakeTelegram } from './fake-telegram.js';
const telegram = await FakeTelegram.start();
after(() => telegram.close());
function notice(key: string): Notice {
    return {
        key,
        kind: 'waiting',
        agentId: 'reviewer',
        title: 'Reviewer is waiting for you',
        body: 'Asks for permission: Run npm test',
        url: 'http://127.0.0.1:4870/#/reviewer'
    };
}
function channel(token = telegram.token): TelegramChannel {
    return new TelegramChannel({ botToken: token, chatId: '-1001', apiUrl: telegram.url });
}
test('a notification is one message to the chat: who, the gist and the link', async () => {
    telegram.calls.length = 0;
    await channel().notify(notice('reviewer-waiting-1'));
    deepStrictEqual(telegram.of('sendMessage').map((call) => call.body), [{
        chat_id: '-1001',
        text: 'Reviewer is waiting for you\nAsks for permission: Run npm test\nhttp://127.0.0.1:4870/#/reviewer',
        disable_web_page_preview: true
    }]);
});
test('taking a notification back deletes every message sent under its key', async () => {
    telegram.calls.length = 0;
    const bot = channel();
    await bot.notify(notice('reviewer-waiting-2'));
    await bot.notify(notice('reviewer-waiting-2'));
    await bot.notify(notice('other-waiting-3'));
    await bot.withdraw('reviewer-waiting-2');
    const sent = telegram.of('sendMessage').length;
    strictEqual(sent, 3);
    deepStrictEqual(telegram.of('deleteMessage').map((call) => call.body['chat_id']), ['-1001', '-1001']);
    await bot.withdraw('reviewer-waiting-2');
    strictEqual(telegram.of('deleteMessage').length, 2, 'a key is taken back once');
});
test('a message the bot may not delete any more is marked answered', async () => {
    telegram.calls.length = 0;
    telegram.refuse.add('deleteMessage');
    try {
        const bot = channel();
        await bot.notify(notice('reviewer-waiting-4'));
        await bot.withdraw('reviewer-waiting-4');
        deepStrictEqual(telegram.of('editMessageText').map((call) => call.body['text']), ['Answered.']);
    } finally {
        telegram.refuse.delete('deleteMessage');
    }
});
test('an error of the Bot API says why and never holds the token', async () => {
    const wrong = '999999:not-the-token-of-this-bot';
    await rejects(channel(wrong).notify(notice('reviewer-waiting-5')), (error: Error) => {
        ok(error.message.includes('Unauthorized'), error.message);
        ok(!error.message.includes(wrong), error.message);
        return true;
    });
    const unreachable = new TelegramChannel({ botToken: telegram.token, chatId: '1', apiUrl: 'http://127.0.0.1:1' });
    await rejects(unreachable.notify(notice('reviewer-waiting-6')), (error: Error) => {
        ok(!error.message.includes(telegram.token), error.message);
        return true;
    });
});
