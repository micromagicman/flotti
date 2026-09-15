/**
 * Every way the configuration can refuse to be used. The kind is what code
 * branches on; the message is what a human reads.
 */
type ConfigurationErrorKind =
    /** `--config` was given without a path. */
    | 'invalid-argument'
    /** `~` cannot be expanded: the environment has no home directory. */
    | 'unresolved-home'
    /** No such file — the usual first run, not a broken configuration. */
    | 'missing-file'
    /** The file is there, but this user may not read it. */
    | 'not-readable'
    /** The file is there, and reading it failed for some other reason. */
    | 'unreadable-file'
    /** The file is not JSON. */
    | 'not-json'
    /** A required field is absent. */
    | 'missing-field'
    /** A field holds a value of the wrong type or shape. */
    | 'wrong-type'
    /** Two agents share one name. */
    | 'duplicate-agent-name'
    /** The agents list is empty, so there is nothing to supervise. */
    | 'empty-agent-list';

type ConfigurationErrorOptions = {
    /** Configuration file the complaint is about, when one is already known. */
    readonly path?: string;
    /** What the user can do about it, printed under the message. */
    readonly hint?: string;
    readonly cause?: unknown;
};

/**
 * A configuration problem stated in one sentence a human can act on: never a
 * stack trace, always the file and the place inside it.
 */
class ConfigurationError extends Error {
    readonly kind: ConfigurationErrorKind;
    readonly path: string | undefined;
    readonly hint: string | undefined;

    constructor(kind: ConfigurationErrorKind, message: string, options: ConfigurationErrorOptions = {}) {
        super(message, {cause: options.cause});
        this.name = 'ConfigurationError';
        this.kind = kind;
        this.path = options.path;
        this.hint = options.hint;
    }
}

export {ConfigurationError};
export type {ConfigurationErrorKind, ConfigurationErrorOptions};
