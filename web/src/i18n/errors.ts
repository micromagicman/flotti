/**
 * What went wrong, in words. An answer of the dashboard with no reason of its
 * own is said in the language of the page; a reason the server gives is shown
 * as it came.
 */
import type { Messages } from './en.js';
/** The dashboard answered with this status and gave no reason. */
class StatusError extends Error {
    readonly status: number;
    constructor(status: number) {
        super(`The dashboard answered ${status}.`);
        this.status = status;
    }
}
function errorText(reason: unknown, t: Messages): string {
    if (reason instanceof StatusError) {
        return t.errors.dashboardAnswered(reason.status);
    }
    return reason instanceof Error ? reason.message : String(reason);
}
export { StatusError, errorText };
