/**
 * What supavisor does with an agent that stopped:
 * - `always`     — restart it whatever the exit code was;
 * - `on-failure` — restart it only after a non-zero exit code or a lost heartbeat;
 * - `never`      — leave it stopped.
 */
type RestartPolicy = 'always' | 'on-failure' | 'never';
/**
 * One agent, as supavisor sees it after the configuration file has been read
 * and checked: the optional fields of the file are already filled with the
 * documented defaults, so nobody downstream repeats that work.
 */
type Agent = {
    /** Unique name of the agent inside one configuration. */
    readonly name: string;
    /** Executable to run. */
    readonly command: string;
    /** Arguments passed to the executable. */
    readonly arguments: readonly string[];
    /** Working directory of the agent; absent means supavisor's own one. */
    readonly workdir?: string;
    /** Variables added to the agent environment; empty when the file says nothing. */
    readonly env: Readonly<Record<string, string>>;
    /** What to do when the agent stops; `on-failure` when the file says nothing. */
    readonly restart: RestartPolicy;
    /** Seconds without a heartbeat before the agent counts as lost; 60 when the file says nothing. */
    readonly heartbeatTimeoutSec: number;
};
/** Contents of the configuration file, checked and typed. */
type Configuration = {
    readonly agents: readonly Agent[];
};
/** Which of the three ways gave supavisor the path of the configuration file. */
type ConfigurationSource = 'argument' | 'environment' | 'default';
/** Configuration file supavisor decided to read, and why that one. */
type ConfigurationLocation = {
    /** Absolute path, with `~` already expanded. */
    readonly path: string;
    readonly source: ConfigurationSource;
};
/** Result of reading the configuration: nothing is started by reading it. */
type LoadedConfiguration = {
    readonly location: ConfigurationLocation;
    readonly configuration: Configuration;
};
export type {
    Agent,
    Configuration,
    ConfigurationLocation,
    ConfigurationSource,
    LoadedConfiguration,
    RestartPolicy
};
