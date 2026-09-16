import * as fs from "node:fs";
import type { AsyncRunSummary } from "./async-status.ts";
import { readAsyncRecoveryDescriptor } from "./async-resume.ts";

export function formatAsyncReviveCommand(run: AsyncRunSummary): string | undefined {
	const step = run.steps.find((candidate) => candidate.status === "failed");
	const sessionFile = step?.sessionFile ?? (run.steps.length === 1 ? run.sessionFile : undefined);
	if (!step || !sessionFile || !fs.existsSync(sessionFile)) return undefined;
	try {
		const descriptor = readAsyncRecoveryDescriptor(run.asyncDir);
		if (!descriptor || descriptor.sourceRunId !== run.id || descriptor.agent !== step.agent) return undefined;
	} catch {
		return undefined;
	}
	const index = run.steps.length === 1 ? "" : `, index: ${step.index}`;
	return `subagent({ action: "resume", id: "${run.id}"${index}, message: "Continue from the persisted child session and report the result." })`;
}

export function formatResumeFirstFailedRunDetail(run: AsyncRunSummary): string | undefined {
	if (run.state !== "failed") return undefined;
	const command = formatAsyncReviveCommand(run);
	if (!command) return undefined;
	return `Resume-first: failed run "${run.id}" has a persisted child session. Revive the original run with ${command} before reporting failure or launching a replacement. Launch a replacement only if revive fails or the user explicitly asks for one.`;
}

export function formatResumeFirstFailedRunsNote(runs: AsyncRunSummary[]): string {
	const failedRuns = runs.filter((run) => run.state === "failed" || run.state === "partial");
	const resumable = failedRuns
		.map((run) => ({ run, command: formatAsyncReviveCommand(run) }))
		.filter((entry): entry is { run: AsyncRunSummary; command: string } => Boolean(entry.command));
	const resumeGuidance = resumable.length === 0
		? ""
		: resumable.length === 1
			? ` Resume-first: failed run "${resumable[0]!.run.id}" has a persisted child session. Revive the original run with ${resumable[0]!.command} before reporting failure or launching a replacement. Launch a replacement only if revive fails or the user explicitly asks for one.`
			: ` Resume-first: ${resumable.length} failed runs have persisted child sessions. Inspect status and revive each original run before reporting failure or launching a replacement. Launch a replacement only if revive fails or the user explicitly asks for one.`;
	return resumeGuidance;
}
