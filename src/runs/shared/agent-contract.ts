import type { AgentContract, EffectsProjection, ExecutionProjection, ReviewProjection, SingleResult } from "../../shared/types.ts";
import { parseBlockedReason } from "./blocked-result.ts";

export function isAgentContract(contract: AgentContract | undefined): boolean {
	return contract?.version === 1;
}

export function buildExecutionProjection(result: Pick<SingleResult, "exitCode" | "error" | "interrupted" | "timedOut" | "stopped" | "detached" | "finalOutput">): ExecutionProjection {
	if (result.detached) {
		return { status: "detached", success: false, exitCode: result.exitCode, detached: true, ...(result.error ? { error: result.error } : {}) };
	}
	if (result.stopped) {
		return { status: "stopped", success: false, exitCode: result.exitCode, stopped: true, ...(result.error ? { error: result.error } : {}) };
	}
	if (result.interrupted) {
		return { status: "paused", success: false, exitCode: result.exitCode, interrupted: true, ...(result.error ? { error: result.error } : {}) };
	}
	const blockedReason = !result.timedOut ? parseBlockedReason(result.finalOutput) : undefined;
	if (blockedReason) {
		return {
			status: "blocked",
			success: false,
			exitCode: result.exitCode,
			blocked: true,
			error: result.error ?? `Blocked: ${blockedReason}`,
		};
	}
	const success = result.exitCode === 0 && !result.error && !result.timedOut;
	return {
		status: success ? "completed" : "failed",
		success,
		exitCode: result.exitCode,
		...(result.error ? { error: result.error } : {}),
		...(result.timedOut ? { timedOut: true } : {}),
	};
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
