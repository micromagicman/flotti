import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import type { AgentColors } from '../agent-colors.js';
import { useT } from '../i18n/I18n.js';
import { errorText } from '../i18n/errors.js';
import type { Messages } from '../i18n/en.js';
import { mentionQuery, offerMembers } from '../mentions.js';
import type { MentionOption } from '../mentions.js';
import { AgentMark } from './AgentMark.js';
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
    /** The members `@` offers in the field (0.7.0, #174); none: no picker. */
    readonly mentions?: readonly MentionOption[];
    /** The colour of each member, for the marks the picker shows; with `mentions`. */
    readonly colors?: AgentColors;
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
        const act = keyAction(event, submit, onEscape);
        if (act !== undefined) {
            act();
            event.preventDefault();
        }
    };
}
/** What a key does in the field: send, give up, or nothing of the composer's own. */
function keyAction(event: KeyboardEvent<HTMLTextAreaElement>, submit: () => void, onEscape: (() => void) | undefined): (() => void) | undefined {
    if (isSendKey(event)) {
        return submit;
    }
    return event.key === 'Escape' ? onEscape : undefined;
}
function isSendKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    return event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing;
}
function useComposer(onSend: ComposerProps['onSend'], disabled: boolean, onEscape: ComposerProps['onEscape']) {
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const [note, setNote] = useState<Note>();
    const t = useT();
    const canSend = text.trim() !== '' && !sending && !disabled;
    const submit = (event?: FormEvent): void => {
        event?.preventDefault();
        if (canSend) {
            deliver(text, onSend, { setText, setSending, setNote, t });
        }
    };
    return { text, setText, canSend, note, submit, onKeyDown: sendOnEnter(submit, onEscape) };
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
/**
 * The state of the `@` picker (0.7.0, #174): the member being typed, and
 * which of the offered members is picked. Pure of the field: it follows the
 * text before the caret.
 */
type PickerState = {
    /** The position of the `@` in the text. */
    readonly at: number;
    /** The text after the `@` up to the caret. */
    readonly query: string;
    readonly selected: number;
    /** Escape closed it; it opens again once the mention being typed changes. */
    readonly dismissed: boolean;
};
/** What a key does while the picker is open. */
type PickerAction = 'up' | 'down' | 'pick' | 'close';
/** The picker for the text before the caret; nothing when no `@` opens a mention, or no members are offered. */
function pickerState(text: string, caret: number, members: readonly MentionOption[] | undefined): PickerState | undefined {
    if (members === undefined || members.length === 0) {
        return undefined;
    }
    const query = mentionQuery(text.slice(0, caret));
    return query === undefined ? undefined : { at: caret - query.length - 1, query, selected: 0, dismissed: false };
}
/** The previous picker refreshed with the next one: the selection and the Escape stick while the mention typed stays. */
function refreshedPicker(last: PickerState | undefined, next: PickerState | undefined): PickerState | undefined {
    if (next === undefined) {
        return undefined;
    }
    return last !== undefined && last.query === next.query ? { ...next, selected: last.selected, dismissed: last.dismissed } : next;
}
/** The text with `@<id> ` in place of the mention being typed, and the caret after it. */
function insertMention(text: string, at: number, query: string, id: string): { readonly text: string; readonly caret: number } {
    const inserted = `@${id} `;
    return { text: text.slice(0, at) + inserted + text.slice(at + query.length + 1), caret: at + inserted.length };
}
/** The keys that move and close the picker, by key; Enter picks. */
const PICKER_KEYS: Readonly<Record<string, PickerAction>> = { ArrowUp: 'up', ArrowDown: 'down', Escape: 'close' };
/** The key a picker is open for: the arrows move, Enter picks, Escape closes; anything else is not its own. */
function pickerAction(event: KeyboardEvent<HTMLTextAreaElement>): PickerAction | undefined {
    const action = PICKER_KEYS[event.key];
    return action ?? (isSendKey(event) ? 'pick' : undefined);
}
/** The selection moved by one, wrapped to the offered members. */
function shiftedPicker(picker: PickerState, delta: number, members: readonly MentionOption[]): PickerState {
    const length = offerMembers(members, picker.query).length;
    const selected = Math.max(0, Math.min(picker.selected + delta, Math.max(0, length - 1)));
    return { ...picker, selected };
}
/** The member the picker is on, or nothing when none is offered. */
function pickedMember(members: readonly MentionOption[], picker: PickerState): MentionOption | undefined {
    return offerMembers(members, picker.query)[picker.selected];
}
/** What a key the picker eats leads to: a member picked, or the picker as it is now. */
type PickerResult = { readonly kind: 'state'; readonly state: PickerState } | { readonly kind: 'pick'; readonly id: string };
/** The member picked, or the picker unchanged when none is on. */
function pickResult(picker: PickerState, members: readonly MentionOption[]): PickerResult {
    const option = pickedMember(members, picker);
    return option === undefined ? { kind: 'state', state: picker } : { kind: 'pick', id: option.id };
}
function applyPickerAction(picker: PickerState, action: PickerAction, members: readonly MentionOption[]): PickerResult {
    if (action === 'pick') {
        return pickResult(picker, members);
    }
    if (action === 'close') {
        return { kind: 'state', state: { ...picker, dismissed: true } };
    }
    return { kind: 'state', state: shiftedPicker(picker, action === 'up' ? -1 : 1, members) };
}
/** Whether the picker is open: there is one, and Escape did not close it. */
function pickerOpen(picker: PickerState | undefined): picker is PickerState {
    return picker !== undefined && !picker.dismissed;
}
/** Puts `@<id> ` into the field in place of the mention being typed, and the caret after it. */
function placeMention(text: string, picker: PickerState, id: string, field: RefObject<HTMLTextAreaElement | null>, setText: (text: string) => void): void {
    const placed = insertMention(text, picker.at, picker.query, id);
    setText(placed.text);
    requestAnimationFrame(() => {
        field.current?.focus();
        field.current?.setSelectionRange(placed.caret, placed.caret);
    });
}
/** A key the picker handles: what to do, or nothing when the field's own keys take it. */
function pickerKeyResult(event: KeyboardEvent<HTMLTextAreaElement>, picker: PickerState | undefined, members: readonly MentionOption[] | undefined): { readonly picker: PickerState; readonly result: PickerResult } | undefined {
    if (!pickerOpen(picker)) {
        return undefined;
    }
    const action = pickerAction(event);
    if (action === undefined) {
        return undefined;
    }
    event.preventDefault();
    return { picker, result: applyPickerAction(picker, action, members ?? []) };
}
/** The `@` picker of the composer: it follows the caret, the arrows, Enter and Escape, and inserts `@<id> `. */
function useMentionPicker(field: RefObject<HTMLTextAreaElement | null>, text: string, setText: (text: string) => void, members: readonly MentionOption[] | undefined) {
    const [picker, setPicker] = useState<PickerState>();
    const refresh = (): void => setPicker((last) => refreshedPicker(last, pickerState(text, field.current?.selectionStart ?? 0, members)));
    useEffect(refresh, [text, members, field]);
    const place = (id: string): void => {
        if (picker !== undefined) {
            placeMention(text, picker, id, field, setText);
            setPicker(undefined);
        }
    };
    const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        const handled = pickerKeyResult(event, picker, members);
        if (handled !== undefined) {
            settlePicker(handled.result, place, setPicker);
        }
    };
    const select = (selected: number): void => setPicker((last) => (last === undefined ? undefined : { ...last, selected }));
    return { picker, pick: place, select, keyDown, refresh };
}
/** Carries out what a key led to: a member picked, or the picker as it is now. */
function settlePicker(result: PickerResult, place: (id: string) => void, setPicker: (picker: PickerState | undefined) => void): void {
    if (result.kind === 'pick') {
        place(result.id);
    } else {
        setPicker(result.state);
    }
}
/** One member the picker offers: the mark, the name, the id. */
function MentionOptionRow({ option, selected, color, onPick, onHover }: {
    readonly option: MentionOption;
    readonly selected: boolean;
    readonly color: number | undefined;
    readonly onPick: (id: string) => void;
    readonly onHover: () => void;
}) {
    return (
        <button type="button" role="option" aria-selected={selected} className={`mention-option agent-color-${color ?? 0}${selected ? ' selected' : ''}`}
            onMouseDown={(event) => { event.preventDefault(); onPick(option.id); }} onMouseEnter={onHover}>
            <AgentMark color={color} />
            <span className="mention-name">{option.name}</span>
            <span className="mention-id">{option.id}</span>
        </button>
    );
}
/** The list of members `@` offers, over the field: mark, name, id; Enter picks, Escape closes. */
function MentionPicker({ state, members, colors, onPick, onHover }: {
    readonly state: PickerState;
    readonly members: readonly MentionOption[];
    readonly colors: AgentColors | undefined;
    readonly onPick: (id: string) => void;
    readonly onHover: (selected: number) => void;
}) {
    const t = useT();
    const options = offerMembers(members, state.query);
    return (
        <div className="mention-picker" role="listbox" aria-label={t.composer.mentionMembers}>
            {options.length === 0 ? <div className="mention-none muted">{t.composer.noMention}</div> : null}
            {options.map((option, index) => (
                <MentionOptionRow key={option.id} option={option} selected={index === state.selected} color={colors?.[option.id]}
                    onPick={onPick} onHover={() => onHover(index)} />
            ))}
        </div>
    );
}
type FieldProps = Pick<ComposerProps, 'label' | 'placeholder'> & {
    readonly field: RefObject<HTMLTextAreaElement | null>;
    readonly hint: string;
    readonly text: string;
    readonly setText: (text: string) => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    readonly onCaret: () => void;
};
function ComposerField({ field, hint, label, placeholder, text, setText, onKeyDown, onCaret }: FieldProps) {
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
            onSelect={onCaret}
            onClick={onCaret}
        />
    );
}
/** How the last send went, when there is something to say. */
function ComposerNote({ note }: { readonly note: Note | undefined }) {
    if (note === undefined) {
        return null;
    }
    return <p className={`composer-note ${note.error ? 'error' : 'note'}`} role={note.error ? 'alert' : 'status'}>{note.text}</p>;
}
/** The picker, open: a list of the members over the field. */
function openPicker(picker: PickerState | undefined, members: readonly MentionOption[] | undefined, colors: AgentColors | undefined, pick: (id: string) => void, select: (index: number) => void) {
    return picker === undefined || picker.dismissed
        ? null
        : <MentionPicker state={picker} members={members ?? []} colors={colors} onPick={pick} onHover={select} />;
}
/** Enter sends; with a mention being typed, the picker takes the keys first. */
function composerKeys(picker: PickerState | undefined, pickerKeys: (event: KeyboardEvent<HTMLTextAreaElement>) => void, sendKeys: (event: KeyboardEvent<HTMLTextAreaElement>) => void) {
    return (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (picker !== undefined && !picker.dismissed) {
            pickerKeys(event);
            return;
        }
        sendKeys(event);
    };
}
/**
 * A card with a bar at its foot (#77): the reply above the field, the field
 * growing with the text, then the state of the agent, the keys and Send.
 * Enter sends; Shift+Enter makes a new line. With `mentions`, `@` opens a
 * picker of the members (0.7.0, #174).
 */
function Composer({ label, placeholder, submitLabel, disabled = false, onSend, above, onEscape, state, mentions, colors }: ComposerProps) {
    const { text, setText, canSend, note, submit, onKeyDown: sendKeys } = useComposer(onSend, disabled, onEscape);
    const field = useRef<HTMLTextAreaElement>(null);
    const hint = useId();
    useFocusOn(field, above?.key);
    const { picker, pick, select, keyDown, refresh } = useMentionPicker(field, text, setText, mentions);
    const onKeyDown = composerKeys(picker, keyDown, sendKeys);
    return (
        <form className="composer" onSubmit={submit}>
            <div className="composer-card">
                {above?.node}
                <ComposerField field={field} hint={hint} label={label} placeholder={placeholder} text={text} setText={setText} onKeyDown={onKeyDown} onCaret={refresh} />
                {openPicker(picker, mentions, colors, pick, select)}
                <ComposerNote note={note} />
                <ComposerBar state={state} hint={hint} submitLabel={submitLabel} disabled={!canSend} />
            </div>
        </form>
    );
}
export { Composer };
