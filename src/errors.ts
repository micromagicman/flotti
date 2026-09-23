/**
 * Every way the fleet can refuse to be used. The kind is what code branches on;
 * the message is what a human reads.
 */
type ConfigurationErrorKind =
    /** `--fleet` was given without a path, or `--port` with something that is not a port. */
    | 'invalid-argument'
    /** `~` cannot be expanded: the environment has no home directory. */
    | 'unresolved-home'
    /** The fleet directory named by `--fleet` or `FLOTTI_FLEET` does not exist. */
    | 'missing-fleet'
    /** Something that has to be a directory is not one. */
    | 'not-a-directory'
    /** An agent directory has no `agent.json`. */
    | 'missing-manifest'
    /** The file or directory is there, but this user may not read it. */
    | 'not-readable'
    /** The file or directory is there, and reading it failed for some other reason. */
    | 'unreadable-file'
    /** The manifest is not JSON. */
    | 'not-json'
    /** A required field is absent. */
    | 'missing-field'
    /** A field holds a value of the wrong type or shape. */
    | 'wrong-type'
    /** An agent directory name cannot serve as an agent id. */
    | 'invalid-agent-id'
    /** The manifest names an id other than its directory. */
    | 'id-mismatch'
    /** A local and a remote agent share one id. */
    | 'duplicate-agent-id'
    /** `flotti run` found another flotti running the same fleet. */
    | 'already-running'
    /** The dashboard port is taken by another program. */
    | 'port-in-use';
type ConfigurationErrorOptions = {
    /** File or directory the complaint is about, when one is already known. */
    readonly path?: string;
    /** What the user can do about it, printed under the message. */
    readonly hint?: string;
    readonly cause?: unknown;
};
/**
 * A fleet problem stated in one sentence a human can act on: never a stack
 * trace, always the file and the place inside it.
 */
class ConfigurationError extends Error {
    readonly kind: ConfigurationErrorKind;
    readonly path: string | undefined;
    readonly hint: string | undefined;
    constructor(kind: ConfigurationErrorKind, message: string, options: ConfigurationErrorOptions = {}) {
        super(message, { cause: options.cause });
        this.name = 'ConfigurationError';
        this.kind = kind;
        this.path = options.path;
        this.hint = options.hint;
    }
}
export { ConfigurationError };
export type { ConfigurationErrorKind, ConfigurationErrorOptions };
