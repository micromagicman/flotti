import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useT } from '../i18n/I18n.js';
/** One thing that can be done to an agent: its words and the call that does it. */
type AgentAction = { readonly key: string; readonly label: string; readonly act: () => Promise<unknown> };
type ActionsProps = { readonly actions: readonly AgentAction[]; readonly run: (action: () => Promise<unknown>) => void };
function MoreIcon() {
    return (
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="currentColor">
            <circle cx="3.5" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="12.5" cy="8" r="1.4" />
        </svg>
    );
}
/** The actions as buttons: on a wide screen. */
function AgentActions({ actions, run }: ActionsProps) {
    return (
        <div className="actions">
            {actions.map((action) => (
                <button key={action.key} type="button" className="btn btn-sm" onClick={() => run(action.act)}>{action.label}</button>
            ))}
        </div>
    );
}
/** Listens to the document while `open`: a press outside `root`, and Escape before anyone else hears it. */
function listenWhileOpen(root: RefObject<HTMLElement | null>, close: () => void): () => void {
    const away = (event: PointerEvent): void => {
        if (!(event.target instanceof Node && root.current?.contains(event.target) === true)) {
            close();
        }
    };
    const escape = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
        }
    };
    document.addEventListener('pointerdown', away);
    // In the capture: the menu closes first, and the details under it stay open.
    document.addEventListener('keydown', escape, true);
    return () => {
        document.removeEventListener('pointerdown', away);
        document.removeEventListener('keydown', escape, true);
    };
}
/** Whether the menu is open; it closes on Escape and on a press outside, the focus back on its button. */
function useMenu() {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const toggle = useRef<HTMLButtonElement>(null);
    const close = useCallback(() => {
        setOpen(false);
        toggle.current?.focus();
    }, []);
    useEffect(() => (open ? listenWhileOpen(root, close) : undefined), [open, close]);
    useEffect(() => {
        if (open) {
            root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
        }
    }, [open]);
    return { open, setOpen, root, toggle, close };
}
function MenuItems({ actions, run }: ActionsProps) {
    const t = useT();
    return (
        <div className="menu" role="menu" aria-label={t.agent.actions}>
            {actions.map((action) => <button key={action.key} type="button" role="menuitem" onClick={() => run(action.act)}>{action.label}</button>)}
        </div>
    );
}
/** The actions in a menu behind «⋯»: on a phone, where the buttons do not fit the line (#102). */
function ActionsMenu({ actions, run }: ActionsProps) {
    const t = useT();
    const menu = useMenu();
    return (
        <div className="actions-menu" ref={menu.root}>
            <button ref={menu.toggle} type="button" className="btn btn-sm btn-ghost icon-btn" aria-haspopup="menu" aria-expanded={menu.open} aria-label={t.agent.actions} title={t.agent.actions} onClick={() => menu.setOpen(!menu.open)}>
                <MoreIcon />
            </button>
            {menu.open ? <MenuItems actions={actions} run={(act) => {
                menu.close();
                run(act);
            }} /> : null}
        </div>
    );
}
export { ActionsMenu, AgentActions };
export type { AgentAction };
