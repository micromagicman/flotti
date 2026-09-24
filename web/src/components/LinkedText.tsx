import { Fragment } from 'react';
import { linkify } from '../links.js';
/**
 * The text of a message with its links clickable (#47): each link opens in a
 * new tab. Pieces are React nodes, never HTML, so markup in the text is shown
 * as it was written and never runs.
 */
function LinkedText({ text }: { readonly text: string }) {
    return (
        <>
            {linkify(text).map((piece, index) => (piece.kind === 'text'
                ? <Fragment key={index}>{piece.text}</Fragment>
                : <a key={index} className="message-link" href={piece.href} target="_blank" rel="noopener noreferrer">{piece.text}</a>))}
        </>
    );
}
export { LinkedText };
