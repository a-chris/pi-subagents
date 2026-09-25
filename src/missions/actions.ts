import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details } from "../shared/types.ts";
import type { MissionStoreConfig, MissionTokenBudget } from "./types.ts";
import { createMission, missionRecordPath, resolveMissionStoreLocation } from "./store.ts";

export const MISSION_ACTIONS = [
	"mission.create",
] as const;

export type MissionAction = typeof MISSION_ACTIONS[number];

export interface MissionLaunchInput {
	title: string;
	objective?: string;
	goal?: true;
	budget?: MissionTokenBudget;
	labels?: string[];
}

export interface MissionActionParams {
	mission?: unknown;
}

interface MissionActionContext {
	cwd: string;
	currentSessionId?: string;
	config?: MissionStoreConfig;
	agentDir?: string;
}

interface MissionLocationInput {
	projectRoot: string;
	config?: MissionStoreConfig;
	agentDir?: string;
}

function textResult(text: string, details: Details): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], details };
}

export function validateMissionLaunch(value: unknown): MissionLaunchInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mission must be an object");
	// SAFETY: callers pass raw tool-args JSON; the object shape is verified key-by-key below.
	const input = value as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (key !== "title" && key !== "summary" && key !== "objective" && key !== "goal" && key !== "budget" && key !== "labels") throw new Error(`mission.${key} is unknown`);
	}
	if (input.title !== undefined && input.summary !== undefined) throw new Error("mission.title and mission.summary cannot both be set");
	const title = input.title ?? input.summary;
	if (typeof title !== "string" || !title.trim()) throw new Error("mission.title or mission.summary must be a non-empty string");
	if (input.objective !== undefined && (typeof input.objective !== "string" || !input.objective.trim())) throw new Error("mission.objective must be a non-empty string");
	// SAFETY: the guard above verified objective is a non-empty string whenever it is present.
	const objective = input.objective as string | undefined;
	if (input.goal !== undefined && input.goal !== true) throw new Error("mission.goal must be true when supplied");
	const budget = input.budget;
	// SAFETY: the guards below verify budget is a non-null object and tokens a safe positive integer before the result casts read those fields.
	if (budget !== undefined && (!budget || typeof budget !== "object" || Array.isArray(budget) || !Number.isSafeInteger((budget as { tokens?: unknown }).tokens) || ((budget as { tokens: number }).tokens < 1))) {
		throw new Error("mission.budget.tokens must be a positive integer");
	}
	if (input.goal === true && budget === undefined) throw new Error("mission.budget is required when mission.goal is true");
	if (input.labels !== undefined && (!Array.isArray(input.labels) || input.labels.some((label) => typeof label !== "string" || !label.trim()))) {
		throw new Error("mission.labels must contain only non-empty strings");
	}
	// SAFETY: budget passed the tokens validation above, so the cast only re-reads the verified field.
	const launch: MissionLaunchInput = { title: title.trim() };
	if (objective !== undefined) launch.objective = objective.trim();
	if (input.goal === true) launch.goal = true;
	// SAFETY: the budget guard above verified a non-null object holding a positive safe integer tokens field before this cast.
	if (budget !== undefined) launch.budget = { tokens: (budget as { tokens: number }).tokens };
	if (input.labels !== undefined) launch.labels = input.labels.map((label) => label.trim());
	return launch;
}

export function handleMissionAction(params: MissionActionParams, ctx: MissionActionContext): AgentToolResult<Details> {
	const locationInput: MissionLocationInput = { projectRoot: ctx.cwd };
	if (ctx.config !== undefined) locationInput.config = ctx.config;
	if (ctx.agentDir !== undefined) locationInput.agentDir = ctx.agentDir;
	const location = resolveMissionStoreLocation(locationInput);
	const mission = validateMissionLaunch(params.mission);
	const createInput: Parameters<typeof createMission>[1] = {
		title: mission.title,
		objective: mission.objective ?? mission.title,
		status: "planned",
	};
	if (mission.goal === true) createInput.goal = true;
	if (mission.budget !== undefined) createInput.budget = mission.budget;
	if (mission.labels !== undefined) createInput.labels = mission.labels;
	if (ctx.currentSessionId !== undefined) createInput.ownerSessionId = ctx.currentSessionId;
	const record = createMission(location, createInput, new Date(), ctx.config?.retainTerminal);
	return textResult(`Created mission ${record.id}: ${record.title}`, { mode: "management", results: [], missionId: record.id, missionPath: pathFor(record.id), mission: record });

	function pathFor(missionId: string): string {
		return missionRecordPath(location, missionId);
	}
}
