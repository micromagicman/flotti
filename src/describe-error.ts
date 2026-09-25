/** What went wrong, in words: the message of an error, or the thrown value itself. */
function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
export { describeError };
