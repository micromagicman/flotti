/**
 * Notifications through a Telegram bot of the person's own: the bot token and
 * the chat it writes to are in the settings, nothing else is needed. The
 * token is a secret — it is part of every address of the Bot API, so every
 * error that leaves here has it cut out.
 */
import type { Notice, NotificationChannel } from './notifier.js';
/** The Bot API; a local Bot API server, or a pretend one in tests, goes in its place. */
const TELEGRAM_API = 'https://api.telegram.org';
/** Environment variable that points flotti at another Bot API server. */
const TELEGRAM_API_VARIABLE = 'FLOTTI_TELEGRAM_API';
/** A request to the Bot API that takes longer has failed. */
const TIMEOUT_MS = 10_000;
type TelegramOptions = {
    readonly botToken: string;
    readonly chatId: string;
    /** Address of the Bot API; {@link TELEGRAM_API} by default. */
    readonly apiUrl?: string;
};
/** What the Bot API answers: `ok` and the result, or a description of why not. */
type BotAnswer = { readonly ok?: boolean; readonly result?: unknown; readonly description?: string };
/** Text with the secret cut out wherever it appears. */
function hide(text: string, secret: string): string {
    return secret === '' ? text : text.split(secret).join('***');
}
/** The text of a notification: who and what, the gist, and where to answer. */
function messageText(notice: Notice): string {
    return `${notice.title}\n${notice.body}\n${notice.url}`;
}
class TelegramChannel implements NotificationChannel {
    readonly name = 'telegram';
    /** Ids of the messages sent under each key, once the Bot API has told them. */
    private readonly sent = new Map<string, Promise<number | undefined>[]>();
    private readonly apiUrl: string;
    constructor(private readonly options: TelegramOptions) {
        this.apiUrl = (options.apiUrl ?? TELEGRAM_API).replace(/\/+$/, '');
    }
    async notify(notice: Notice): Promise<void> {
        const message = this.call('sendMessage', {
            chat_id: this.options.chatId,
            text: messageText(notice),
            disable_web_page_preview: true
        }).then((result) => (result as { message_id?: number } | undefined)?.message_id);
        const pending = this.sent.get(notice.key) ?? [];
        pending.push(message.catch(() => undefined));
        this.sent.set(notice.key, pending);
        await message;
    }
    /** Deletes the messages of the key; where the Bot API will not, it marks them answered instead. */
    async withdraw(key: string): Promise<void> {
        const pending = this.sent.get(key) ?? [];
        this.sent.delete(key);
        for (const id of await Promise.all(pending)) {
            if (id !== undefined) {
                await this.remove(id);
            }
        }
    }
    private async remove(messageId: number): Promise<void> {
        try {
            await this.call('deleteMessage', { chat_id: this.options.chatId, message_id: messageId });
        } catch {
            await this.call('editMessageText', { chat_id: this.options.chatId, message_id: messageId, text: 'Answered.' });
        }
    }
    /** Calls a method of the Bot API; rejects with a reason that never holds the token. */
    private async call(method: string, body: object): Promise<unknown> {
        const token = this.options.botToken;
        try {
            const response = await fetch(`${this.apiUrl}/bot${token}/${method}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
            return resultOf(response, (await response.json().catch(() => ({}))) as BotAnswer);
        } catch (error) {
            throw new Error(`${method}: ${hide(reasonOf(error), token)}`);
        }
    }
}
/** What the Bot API answered; throws when it refused. */
function resultOf(response: Response, answer: BotAnswer): unknown {
    if (!response.ok || answer.ok !== true) {
        throw new Error(`Telegram answered ${response.status}: ${answer.description ?? 'no description'}`);
    }
    return answer.result;
}
/** Why a call failed, with the cause a failed fetch hides in `cause`. */
function reasonOf(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }
    return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}
export { TELEGRAM_API, TELEGRAM_API_VARIABLE, TelegramChannel, hide };
export type { TelegramOptions };
