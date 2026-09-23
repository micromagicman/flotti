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
type Note = { readonly text: string; readonly error: boolean };
type Setters = {
    readonly setText: (text: string) => void;
    readonly setSending: (sending: boolean) => void;
    readonly setNote: (note: Note | undefined) => void;
};
/** Hands the text over; on success the field clears, and either outcome may leave a note. */
function deliver(text: string, onSend: ComposerProps['onSend'], { setText, setSending, setNote }: Setters): void {
    setSending(true);
    setNote(undefined);
    onSend(text).then(
        (result) => {
            setText('');
            setNote(result === undefined ? undefined : { text: result, error: false });
        },
        (error: unknown) => setNote({ text: error instanceof Error ? error.message : String(error), error: true })
    ).finally(() => setSending(false));
}
/** Enter sends; Shift+Enter and a key that finishes an IME composition do not. */
function sendOnEnter(submit: () => void) {
    return (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            submit();
            event.preventDefault();
        }
    };
}
function useComposer(onSend: ComposerProps['onSend'], disabled: boolean) {
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const [note, setNote] = useState<Note>();
    const submit = (event?: FormEvent): void => {
        event?.preventDefault();
        if (text.trim() === '' || sending || disabled) {
            return;
        }
        deliver(text, onSend, { setText, setSending, setNote });
    };
    return { text, setText, sending, note, submit, onKeyDown: sendOnEnter(submit) };
}
function ComposerRow({ note, submitLabel, disabled }: { readonly note: Note | undefined; readonly submitLabel: string; readonly disabled: boolean }) {
    return (
        <div className="composer-row">
            {note === undefined ? <span /> : <span className={note.error ? 'error' : 'note'} role={note.error ? 'alert' : 'status'}>{note.text}</span>}
            <button type="submit" className="primary" disabled={disabled}>{submitLabel}</button>
        </div>
    );
}
/** A text field that sends on Enter; Shift+Enter makes a new line. */
function Composer({ label, placeholder, submitLabel, disabled = false, onSend }: ComposerProps) {
    const { text, setText, sending, note, submit, onKeyDown } = useComposer(onSend, disabled);
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
            <ComposerRow note={note} submitLabel={submitLabel} disabled={sending || disabled || text.trim() === ''} />
        </form>
    );
}
export { Composer };
