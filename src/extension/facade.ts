/**
 * Facade normalization (M1).
 *
 * The model sees three small tools; each maps onto the existing internal
 * SubagentParams contract and hands off to the same public execution boundary
 * (executor.executePublic) the extension has always used. No bridge, preflight,
 * or extension consumer is affected: they keep using internal contracts directly.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_CONTROL_ACTIONS } from "./schemas.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { Details } from "../shared/types.ts";

export type SubagentControlAction = (typeof SUBAGENT_CONTROL_ACTIONS)[number];

export interface SubagentDelegationFacadeParams {
	task: string;
	agent?: string;
	prequel?: string;
	reads?: string[];
	cwd?: string;
	async?: boolean;
	output?: string | boolean;
	worktree?: boolean;
}

export interface SubagentWorkflowFacadeParams {
	workflow?: string;
	source?: string | { path?: string };
	args?: object;
	async?: boolean;
	worktree?: boolean;
	baseRef?: string;
}

export interface SubagentControlFacadeParams {
	id?: string;
	action?: SubagentControlAction;
	message?: string;
}

/**
 * Public execution boundary signature shared by the facade tools. The extension
 * wires this to executor.executePublic (optionally wrapped by a collapse
 * helper), never to the JSON schema.
 */
export type FacadeExecutePublic = (
	id: string,
	params: SubagentParamsLike,
	signal: AbortSignal,
	onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
	ctx: ExtensionContext,
) => Promise<AgentToolResult<Details>>;

export function normalizeDelegationParams(params: SubagentDelegationFacadeParams): SubagentParamsLike {
	// prequel is a member of the internal SubagentParamsLike contract as of M2
	// (subagent-executor.ts); the executor consumes it for fork|summary-fresolved
	// launches and ignores it otherwise.
	return {
		task: params.task,
		agent: params.agent,
		reads: params.reads,
		cwd: params.cwd,
		async: params.async,
		output: params.output,
		worktree: params.worktree,
		...(params.prequel !== undefined && { prequel: params.prequel }),
	} as SubagentParamsLike;
}

export function isWorkflowSourceObject(source: string | { path?: string }): source is { path?: string } {
	// The facade schema establishes the contract at the I/O boundary: source is
	// either a string script body or a { path } object. Mirror that discriminator.
	return typeof source === "object";
}

export function normalizeWorkflowParams(params: SubagentWorkflowFacadeParams): SubagentParamsLike {
	const scriptSource =
		params.source === undefined
			? {}
			: isWorkflowSourceObject(params.source)
				? (params.source.path !== undefined ? { workflowScriptPath: params.source.path } : {})
				: { workflowScript: params.source };
	// SAFETY: the source union maps to the internal workflowScript /
	// workflowScriptPath fields; the facade never passes `source` verbatim.
	return {
		workflow: params.workflow,
		args: params.args,
		async: params.async,
		worktree: params.worktree,
		baseRef: params.baseRef,
		...scriptSource,
	} as SubagentParamsLike;
}

export function normalizeControlParams(params: SubagentControlFacadeParams): SubagentParamsLike {
	// SAFETY: id/action/message are the only control params the facade owns and
	// action is constrained to the closed enum by the control schema.
	return {
		id: params.id,
		action: params.action,
		message: params.message,
	} as SubagentParamsLike;
}

export interface SubagentFacadeExecute {
	delegation: (
		id: string,
		params: SubagentDelegationFacadeParams,
		signal: AbortSignal,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
	workflow: (
		id: string,
		params: SubagentWorkflowFacadeParams,
		signal: AbortSignal,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
	control: (
		id: string,
		params: SubagentControlFacadeParams,
		signal: AbortSignal,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
}

export function createSubagentFacadeExecute(execute: FacadeExecutePublic): SubagentFacadeExecute {
	return {
		delegation: (id, params, signal, onUpdate, ctx) => execute(id, normalizeDelegationParams(params), signal, onUpdate, ctx),
		workflow: (id, params, signal, onUpdate, ctx) => execute(id, normalizeWorkflowParams(params), signal, onUpdate, ctx),
		control: (id, params, signal, onUpdate, ctx) => execute(id, normalizeControlParams(params), signal, onUpdate, ctx),
	};
}