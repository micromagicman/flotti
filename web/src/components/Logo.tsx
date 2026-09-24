/**
 * The flotti logo: three sails in a wedge over the waterline, the lead one
 * blue, and the word. Drawn inline so its colours follow the theme tokens;
 * the same drawing lives as files in assets/logo and web/public/favicon.svg.
 */
export function Logo() {
    return (
        <svg className="logo" viewBox="0 -20.9 151.65 41.81" role="img" aria-label="flotti">
            <g transform="translate(0 -19.9) scale(1.24)">
                <path className="logo-sail logo-back" d="M3 24.5V16Q8.1 19.15 9 24.5Z" />
                <path className="logo-sail logo-ink" d="M11 24.5V10.5Q17.4 15.2 18.5 24.5Z" />
                <path className="logo-sail logo-lead" d="M20.5 24.5V4Q28.2 11.2 29.5 24.5Z" />
                <path className="logo-water" d="M3 28.6H29.5" />
            </g>
            <g transform="translate(51.75 13.25)">
                <path
                    className="logo-word"
                    d="M5.8 0V-22A5 5 0 0 1 10.8 -27H13.3M1.8 -17H10.8M21.8 -27V0M30.3 -8.5a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0 -17 0M59.8 -23V-5A5 5 0 0 0 64.8 0H66.8M55.8 -17H64.8M79.3 -23V-5A5 5 0 0 0 84.3 0H86.3M75.3 -17H84.3M94.8 -17V0"
                />
                <circle className="logo-dot" cx="94.8" cy="-23" r="2.3" />
            </g>
        </svg>
    );
}
