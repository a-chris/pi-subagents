/**
 * Fail-closed completion status.
 *
 * A child that cannot safely or legitimately complete its task stops working and
 * reports it in its final output instead of asking, waiting, or inventing work.
 * There is no parent<->child messaging channel: "blocked" is a terminal
 * completion status on par with "completed" and "failed", and the parent reacts
 * to it (re-plan, re-run differently, or surface it to the operator).
 *
 * The child expresses it with a reserved first-line marker in its final output:
 *
 *   BLOCKED: <short reason>
 *
 * The marker stays visible in the returned output (so plain-text consumers see
 * it), and the runtime additionally normalizes it onto the result as
 * `blocked: <reason>` and the execution projection status "blocked".
 */

export const BLOCKED_MARKER_PREFIX = "BLOCKED:";

/** Parse the reason from the first non-empty line of the child's final output. */
export function parseBlockedReason(output: string | undefined): string | undefined {
	if (!output) return undefined;
	const trimmed = output.trim();
	if (!trimmed) return undefined;
	const firstLine = trimmed.split(/\r?\n/, 1)[0]!.trim();
	if (!firstLine.toUpperCase().startsWith(BLOCKED_MARKER_PREFIX)) return undefined;
	const reason = firstLine.slice(BLOCKED_MARKER_PREFIX.length).trim();
	return reason || "unspecified";
}