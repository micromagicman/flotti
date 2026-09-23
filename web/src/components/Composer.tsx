import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
type ComposerProps = {
    readonly label: string;
    readonly placeholder: string;
    readonly submitLabel: string;
    readonly disabled?: boolean;
    /** Resolves with a note to show under the field, or nothing; rejects with what went wrong. */
    readonly onSend: (text: string) => Promise<string | undefined>;
};
/** A text field that sends on Enter; Shift+Enter makes a new line. */
function Composer({ label, placeholder, submitLabel, disabled = false, onSend }: ComposerProps) {
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const [note, setNote] = useState<{ readonly text: string; readonly error: boolean }>();
    const submit = (event?: FormEvent): void => {
        event?.preventDefault();
        if (text.trim() === '' || sending || disabled) {
            return;
        }
        setSending(true);
        setNote(undefined);
        onSend(text).then(
            (result) => {
                setText('');
                setNote(result === undefined ? undefined : { text: result, error: false });
            },
            (error: unknown) => setNote({ text: error instanceof Error ? error.message : String(error), error: true })
        ).finally(() => setSending(false));
    };
    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            submit();
            event.preventDefault();
        }
    };
    return (
        <form className="composer" onSubmit={submit}>
            <textarea
                aria-label={label}
                placeholder={placeholder}
                value={text}
                rows={3}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKeyDown}
            />
            <div className="composer-row">
                {note === undefined ? <span /> : <span className={note.error ? 'error' : 'note'} role={note.error ? 'alert' : 'status'}>{note.text}</span>}
                <button type="submit" className="primary" disabled={sending || disabled || text.trim() === ''}>{submitLabel}</button>
            </div>
        </form>
    );
}
export { Composer };
