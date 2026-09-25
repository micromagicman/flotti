import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentSummary } from '../../../src/dashboard-protocol.js';
import { poorText } from '../health.js';
import { useT } from '../i18n/I18n.js';
import { ConnectionHealthView } from './ConnectionHealth.js';
/**
 * What runs the agent: claude or codex from the adapter of its manifest, or
 * whatever a remote agent names itself, shown as it is. A plain ACP agent and
 * a remote one that says nothing do not tell, and the details say so in plain words.
 */
function Harness({ agent }: { readonly agent: AgentSummary }) {
    const t = useT();
    if (agent.harness !== undefined) {
        return <span className="harness" data-harness={agent.harness}>{agent.harness}</span>;
    }
    const why = agent.kind === 'remote' ? t.agent.harnessRemote : t.agent.harnessLocal;
    return <span className="harness-unknown" data-harness="unknown" title={why}>{t.agent.noHarness}</span>;
}
/**
 * Whether the agent has memory (#101), as flotti delivered it: on with the
 * version of the policy, unsupported, or unavailable — with why in the hint.
 * Nothing before a local agent was started once: flotti does not guess.
 */
function Memory({ memory }: { readonly memory: NonNullable<AgentSummary['memory']> }) {
    const t = useT();
    if (memory.state === 'on') {
        const skill = memory.skill === 'user' ? t.agent.memorySkillUser : memory.skill === 'missing' ? t.agent.memorySkillMissing : '';
        return (
            <span className="memory-badge" data-memory="on" data-skill={memory.skill} title={`${t.agent.memoryOnHint}${skill === '' ? '' : ` ${skill}`}`}>
                {t.agent.memoryOn(memory.policy)}
            </span>
        );
    }
    const label = memory.state === 'unsupported' ? t.agent.memoryUnsupported : t.agent.memoryUnavailable;
    return <span className="memory-badge memory-badge-off" data-memory={memory.state} title={memory.reason}>{label}</span>;
}
/** The agent itself: what it is for, its type, its harness, its memory, its role. */
function AboutAgent({ agent }: { readonly agent: AgentSummary }) {
    const t = useT();
    return (
        <section className="details-section" aria-label={t.agent.about}>
            <h3>{t.agent.about}</h3>
            {agent.description === undefined ? null : <p className="description">{agent.description}</p>}
            <dl className="facts">
                <dt>{t.agent.kind}</dt>
                <dd>{agent.kind === 'local' ? t.common.localKind : t.common.remoteKind}</dd>
                <dt>{t.agent.harness}</dt>
                <dd><Harness agent={agent} /></dd>
                {agent.memory === undefined ? null : <><dt>{t.agent.memory}</dt><dd><Memory memory={agent.memory} /></dd></>}
                {agent.admin === true
                    ? <><dt>{t.agent.role}</dt><dd><span className="admin-badge" title={t.agent.adminHint}>{t.agent.admin}</span></dd></>
                    : null}
            </dl>
        </section>
    );
}
/** The SSH connection of a remote agent, in a column; its trouble on top. */
function AboutConnection({ agent }: { readonly agent: AgentSummary }) {
    const t = useT();
    if (agent.health === undefined) {
        return null;
    }
    const fine = poorText(agent.health, t) === undefined;
    return (
        <section className="details-section" aria-label={t.agent.connection}>
            <h3><span className="health-title">SSH</span> {t.agent.connection}{fine ? <span className="health-fine"> · {t.health.fine}</span> : null}</h3>
            <ConnectionHealthView health={agent.health} layout="column" />
        </section>
    );
}
/**
 * What left the header (#102): the description, the type, the harness, the
 * memory (#101), the role, and the connection of a remote agent. A panel on the right of the
 * chat, over it on a phone; the chat stays in sight and can be written to.
 */
function AgentDetails({ agent, id, onClose }: { readonly agent: AgentSummary; readonly id: string; readonly onClose: () => void }) {
    const t = useT();
    const close = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        close.current?.focus();
    }, []);
    return (
        <aside className="agent-details" id={id} aria-label={t.agent.detailsOf(agent.name)}>
            <div className="agent-details-head">
                <h2>{t.agent.details}</h2>
                <button ref={close} type="button" className="btn btn-sm btn-ghost" onClick={onClose}>{t.agent.closeDetails}</button>
            </div>
            <AboutAgent agent={agent} />
            <AboutConnection agent={agent} />
        </aside>
    );
}
/**
 * Whether the details of the agent are open; closing them gives the focus
 * back to what opened them, and Escape closes them when no menu took it first.
 */
function useDetails() {
    const [open, setOpen] = useState(false);
    const opener = useRef<HTMLElement | null>(null);
    const show = useCallback(() => {
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOpen(true);
    }, []);
    const hide = useCallback(() => {
        setOpen(false);
        opener.current?.focus();
    }, []);
    useEffect(() => (open ? onEscape(hide) : undefined), [open, hide]);
    return { open, show, hide };
}
/** Calls `close` on an Escape nobody took before; returns the way to stop listening. */
function onEscape(close: () => void): () => void {
    const escape = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
            close();
        }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
}
export { AgentDetails, useDetails };
