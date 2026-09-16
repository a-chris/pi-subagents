import type { AgentContract, EffectsProjection, ExecutionProjection, ReviewProjection, SingleResult } from "../../shared/types.ts";
import { parseBlockedReason } from "./blocked-result.ts";

export function isAgentContract(contract: AgentContract | undefined): boolean {
	return contract?.version === 1;
}

export function buildExecutionProjection(result: Pick<SingleResult, "exitCode" | "error" | "interrupted" | "timedOut" | "stopped" | "detached" | "finalOutput">): ExecutionProjection {
	if (result.detached) {
		const projection: ExecutionProjection = { status: "detached", success: false, exitCode: result.exitCode, detached: true };
		if (result.error) projection.error = result.error;
		return projection;
	}
	if (result.stopped) {
		const projection: ExecutionProjection = { status: "stopped", success: false, exitCode: result.exitCode, stopped: true };
		if (result.error) projection.error = result.error;
		return projection;
	}
	if (result.interrupted) {
		const projection: ExecutionProjection = { status: "paused", success: false, exitCode: result.exitCode, interrupted: true };
		if (result.error) projection.error = result.error;
		return projection;
	}
	const blockedReason = !result.timedOut ? parseBlockedReason(result.finalOutput) : undefined;
	if (blockedReason) {
		const projection: ExecutionProjection = { status: "blocked", success: false, exitCode: result.exitCode, blocked: true, error: result.error ?? `Blocked: ${blockedReason}` };
		return projection;
	}
	const success = result.exitCode === 0 && !result.error && !result.timedOut;
	const projection: ExecutionProjection = { status: success ? "completed" : "failed", success, exitCode: result.exitCode };
	if (result.error) projection.error = result.error;
	if (result.timedOut) projection.timedOut = true;
	return projection;
}

export function buildReviewProjection(result: Pick<SingleResult, "acceptance">): ReviewProjection {
	const review = result.acceptance?.reviewResult;
	if (!review) return { status: "not-requested" };
	return { status: review.status, findings: review.findings };
}

export function attachContractProjections<T extends SingleResult>(result: T): T {
	result.execution = buildExecutionProjection(result);
	result.review = buildReviewProjection(result);
	if (!result.effects) result.effects = {} satisfies EffectsProjection;
	return result;
}
