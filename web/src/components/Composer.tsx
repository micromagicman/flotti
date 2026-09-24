import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
type ComposerProps = {
    readonly label: string;
    readonly placeholder: string;
    readonly submitLabel: string;
    readonly disabled?: boolean;
    /** Resolves with a note to show under the field, or nothing; rejects with what went wrong. */
    readonly onSend: (text: string) => Promise<string | undefined>;
    /**
     * Shown above the field: the message a reply answers. The field takes the
     * focus each time a new `key` comes.
     */
    readonly above?: { readonly key: string; readonly node: ReactNode } | undefined;
    /** Escape in the field: drops what `above` shows. */
    readonly onEscape?: () => void;
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
/** Enter sends; Shift+Enter and a key that finishes an IME composition do not. Escape calls `onEscape`. */
function sendOnEnter(submit: () => void, onEscape: (() => void) | undefined) {
    return (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            submit();
            event.preventDefault();
        } else if (event.key === 'Escape' && onEscape !== undefined) {
            onEscape();
            event.preventDefault();
        }
    };
}
function useComposer(onSend: ComposerProps['onSend'], disabled: boolean, onEscape: ComposerProps['onEscape']) {
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
    return { text, setText, sending, note, submit, onKeyDown: sendOnEnter(submit, onEscape) };
}
function ComposerRow({ note, submitLabel, disabled }: { readonly note: Note | undefined; readonly submitLabel: string; readonly disabled: boolean }) {
    return (
        <div className="composer-row">
            {note === undefined ? <span /> : <span className={note.error ? 'error' : 'note'} role={note.error ? 'alert' : 'status'}>{note.text}</span>}
            <button type="submit" className="primary" disabled={disabled}>{submitLabel}</button>
        </div>
    );
}
/** Puts the caret in the field whenever something new shows above it. */
function useFocusOn(key: string | undefined) {
    const field = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        if (key !== undefined) {
            field.current?.focus();
        }
    }, [key]);
    return field;
}
/** A text field that sends on Enter; Shift+Enter makes a new line. */
function Composer({ label, placeholder, submitLabel, disabled = false, onSend, above, onEscape }: ComposerProps) {
    const { text, setText, sending, note, submit, onKeyDown } = useComposer(onSend, disabled, onEscape);
    const field = useFocusOn(above?.key);
    return (
        <form className="composer" onSubmit={submit}>
            {above?.node}
            <textarea
                ref={field}
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
