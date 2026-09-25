/**
 * Model-facing tool descriptions (M1): one short description per facade tool,
 * each at most 60 words. Depth lives in guide topics, reachable via the
 * subagent_control action:guide (e.g. tool-reference, workflows, agents).
 */

import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";

export const SUBAGENT_TOOL_PROMPT_SNIPPET = "For operator-requested delegation, use subagents; compose multi-child work in one workflow call.";
export const SUBAGENT_TOOL_PROMPT_GUIDELINES = [
	"Do not invoke subagents unless the operator requested delegation directly or through applicable instructions.",
];

export interface SubagentToolPromptMetadata {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export function buildSubagentToolPromptMetadata(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}): SubagentToolPromptMetadata {
	if (config.toolDescriptionMode !== undefined) return {};
	return {
		promptSnippet: SUBAGENT_TOOL_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_TOOL_PROMPT_GUIDELINES,
	};
}

export const SUBAGENT_DELEGATION_DESCRIPTION = "Delegate one child agent for a focused task. task states what to do or solve; prequel states current work and what led here (consumed only for fork/summary contexts). Optional: agent (installed name via subagent_control action:list), reads (files), cwd, async (background), output (durable path), worktree (isolate). Delegate only when authorized. Depth: guide topics tool-reference, agents.";

export const SUBAGENT_WORKFLOW_DESCRIPTION = "Run a multi-child workflow by named resource (workflow) or an inline script (source string) / script file (source { path }), with bounded JSON args. async backgrounds it; worktree isolates in a managed git worktree; baseRef sets the worktree base branch/ref. Depth: guide topic workflows.";

export const SUBAGENT_CONTROL_DESCRIPTION = "Manage runs by id: status, resume, steer (with message), stop, interrupt; validate lints a script; list/get/models/guide read runs and the agent registry; mission.create starts a mission. Omit action for status. Depth: guide topic tool-reference.";