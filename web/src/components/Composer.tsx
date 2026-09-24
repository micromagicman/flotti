import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import { useT } from '../i18n/I18n.js';
import { errorText } from '../i18n/errors.js';
import type { Messages } from '../i18n/en.js';
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
    /**
     * The chip at the start of the bar under the field: the status of the
     * agent and its line, or how many agents a broadcast goes to.
     */
    readonly state?: ReactNode;
};
type Note = { readonly text: string; readonly error: boolean };
type Setters = {
    readonly setText: (text: string) => void;
    readonly setSending: (sending: boolean) => void;
    readonly setNote: (note: Note | undefined) => void;
    readonly t: Messages;
};
/** Hands the text over; on success the field clears, and either outcome may leave a note. */
function deliver(text: string, onSend: ComposerProps['onSend'], { setText, setSending, setNote, t }: Setters): void {
    setSending(true);
    setNote(undefined);
    onSend(text).then(
        (result) => {
            setText('');
            setNote(result === undefined ? undefined : { text: result, error: false });
        },
        (error: unknown) => setNote({ text: errorText(error, t), error: true })
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
    const t = useT();
    const submit = (event?: FormEvent): void => {
        event?.preventDefault();
        if (text.trim() === '' || sending || disabled) {
            return;
        }
        deliver(text, onSend, { setText, setSending, setNote, t });
    };
    return { text, setText, sending, note, submit, onKeyDown: sendOnEnter(submit, onEscape) };
}
/** Puts the caret in the field whenever something new shows above it. */
function useFocusOn(field: RefObject<HTMLTextAreaElement | null>, key: string | undefined) {
    useEffect(() => {
        if (key !== undefined) {
            field.current?.focus();
        }
    }, [field, key]);
}
/**
 * The field grows with its text, up to the height the stylesheet allows;
 * past it, it scrolls.
 */
function useGrow(field: RefObject<HTMLTextAreaElement | null>, text: string) {
    useLayoutEffect(() => {
        const element = field.current;
        if (element === null) {
            return;
        }
        element.style.height = 'auto';
        element.style.height = `${element.scrollHeight}px`;
    }, [field, text]);
}
function SendIcon() {
    return (
        <svg className="composer-send-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}
/** The keys, always in sight: the field says the same to a screen reader. */
function KeysHint({ id }: { readonly id: string }) {
    const t = useT();
    return (
        <span className="composer-hint" id={id}>
            <span><kbd>Enter</kbd> {t.composer.toSend}</span>
            <span aria-hidden="true"> · </span>
            <span><kbd>Shift</kbd>+<kbd>Enter</kbd> {t.composer.newLine}</span>
        </span>
    );
}
function ComposerBar({ state, hint, submitLabel, disabled }: { readonly state: ReactNode; readonly hint: string; readonly submitLabel: string; readonly disabled: boolean }) {
    return (
        <div className="composer-bar">
            {state === undefined ? null : <span className="composer-state">{state}</span>}
            <KeysHint id={hint} />
            <button type="submit" className="btn btn-primary btn-sm composer-send" disabled={disabled}><SendIcon />{submitLabel}</button>
        </div>
    );
}
type FieldProps = Pick<ComposerProps, 'label' | 'placeholder'> & {
    readonly field: RefObject<HTMLTextAreaElement | null>;
    readonly hint: string;
    readonly text: string;
    readonly setText: (text: string) => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
};
function ComposerField({ field, hint, label, placeholder, text, setText, onKeyDown }: FieldProps) {
    useGrow(field, text);
    return (
        <textarea
            ref={field}
            className="composer-field"
            aria-label={label}
            aria-describedby={hint}
            placeholder={placeholder}
            value={text}
            rows={2}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
        />
    );
}
/**
 * A card with a bar at its foot (#77): the reply above the field, the field
 * growing with the text, then the state of the agent, the keys and Send.
 * Enter sends; Shift+Enter makes a new line.
 */
function Composer({ label, placeholder, submitLabel, disabled = false, onSend, above, onEscape, state }: ComposerProps) {
    const { text, setText, sending, note, submit, onKeyDown } = useComposer(onSend, disabled, onEscape);
    const field = useRef<HTMLTextAreaElement>(null);
    const hint = useId();
    useFocusOn(field, above?.key);
    return (
        <form className="composer" onSubmit={submit}>
            <div className="composer-card">
                {above?.node}
                <ComposerField field={field} hint={hint} label={label} placeholder={placeholder} text={text} setText={setText} onKeyDown={onKeyDown} />
                {note === undefined ? null : <p className={`composer-note ${note.error ? 'error' : 'note'}`} role={note.error ? 'alert' : 'status'}>{note.text}</p>}
                <ComposerBar state={state} hint={hint} submitLabel={submitLabel} disabled={sending || disabled || text.trim() === ''} />
            </div>
        </form>
    );
}
export { Composer };
