/**
 * The frames the stories put a component in: the grid of the page, so a
 * sidebar and a panel stand where they do in the dashboard, on a laptop and
 * on a phone alike.
 */
import type { ReactNode } from 'react';
import { Logo } from '../src/components/Logo.js';
/** The grid of the page: the top bar, then the sidebar and the main panel side by side. */
function PageFrame({ side, children }: { readonly side?: ReactNode; readonly children?: ReactNode }) {
    return (
        <div className="app">
            <header className="topbar"><Logo /></header>
            {side}
            <main className="main">{children}</main>
        </div>
    );
}
/** The main panel alone, as tall as the page. */
function MainFrame({ children }: { readonly children: ReactNode }) {
    return <main className="main" style={{ height: '100vh' }}>{children}</main>;
}
/** A column of messages, as the feed of a tab lays them out. */
function FeedFrame({ children }: { readonly children: ReactNode }) {
    return <div className="feed" style={{ minHeight: '100vh', boxSizing: 'border-box' }}>{children}</div>;
}
export { FeedFrame, MainFrame, PageFrame };
