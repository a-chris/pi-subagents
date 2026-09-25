import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
	buildSubagentToolPromptMetadata,
	SUBAGENT_CONTROL_DESCRIPTION,
	SUBAGENT_DELEGATION_DESCRIPTION,
	SUBAGENT_TOOL_PROMPT_GUIDELINES,
	SUBAGENT_TOOL_PROMPT_SNIPPET,
	SUBAGENT_WORKFLOW_DESCRIPTION,
} from "../../src/extension/tool-description.ts";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/child-runtime-config.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

function parentToolEnv(agentDir?: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env[SUBAGENT_CHILD_ENV];
	if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
	return env;
}

describe("subagent facade tool descriptions", () => {
	it("keeps each facade description at most 60 words", () => {
		for (const [name, description] of [
			["subagent", SUBAGENT_DELEGATION_DESCRIPTION],
			["subagent_workflow", SUBAGENT_WORKFLOW_DESCRIPTION],
			["subagent_control", SUBAGENT_CONTROL_DESCRIPTION],
		]) {
			assert.ok(wordCount(description) <= 60, `${name} description should be <= 60 words, got ${wordCount(description)}`);
		}
	});

	it("points each description at guide topics for depth", () => {
		assert.match(SUBAGENT_DELEGATION_DESCRIPTION, /guide topics tool-reference, agents/);
		assert.match(SUBAGENT_DELEGATION_DESCRIPTION, /subagent_control action:list/);
		assert.match(SUBAGENT_WORKFLOW_DESCRIPTION, /guide topic workflows/);
		assert.match(SUBAGENT_CONTROL_DESCRIPTION, /guide topic tool-reference/);
	});

	it("keeps delegation authorization guidance on the delegation tool", () => {
		assert.match(SUBAGENT_DELEGATION_DESCRIPTION, /Delegate only when authorized/i);
		assert.match(SUBAGENT_DELEGATION_DESCRIPTION, /task states what to do or solve/);
		assert.match(SUBAGENT_DELEGATION_DESCRIPTION, /prequel states current work and what led here/);
	});

	it("ships no stale text from removed subsystems in any description", () => {
		for (const description of [SUBAGENT_DELEGATION_DESCRIPTION, SUBAGENT_WORKFLOW_DESCRIPTION, SUBAGENT_CONTROL_DESCRIPTION]) {
			assert.doesNotMatch(description, /workflowScriptPath/);
			assert.doesNotMatch(description, /runs\.lanes/);
			assert.doesNotMatch(description, /schedule\./);
			assert.doesNotMatch(description, /watchdog/);
		}
	});

	it("keeps prompt metadata concise and current by default", () => {
		assert.equal(SUBAGENT_TOOL_PROMPT_SNIPPET, "For operator-requested delegation, use subagents; compose multi-child work in one workflow call.");
		assert.deepEqual(SUBAGENT_TOOL_PROMPT_GUIDELINES, [
			"Do not invoke subagents unless the operator requested delegation directly or through applicable instructions.",
		]);
		const metadata = buildSubagentToolPromptMetadata();
		assert.equal(metadata.promptSnippet, SUBAGENT_TOOL_PROMPT_SNIPPET);
		assert.deepEqual(metadata.promptGuidelines, SUBAGENT_TOOL_PROMPT_GUIDELINES);
		assert.ok(Buffer.byteLength(metadata.promptGuidelines!.join("\n")) < 400);
		for (const guideline of metadata.promptGuidelines!) assert.match(guideline, /subagent/);
		for (const toolDescriptionMode of ["full", "compact", "custom"] as const) {
			assert.deepEqual(buildSubagentToolPromptMetadata({ toolDescriptionMode }), {});
		}
	});
});

function readRegisteredTools(agentDir: string): { name: string; description: string; properties: string[] }[] {
	const script = String.raw`
		import registerSubagentExtension from "./src/extension/index.ts";
		const events = { on() { return () => {}; }, emit() {} };
		const registered = [];
		const fakePi = new Proxy({
			events,
			registerTool(tool) { registered.push(tool); },
			registerCommand() {},
			registerShortcut() {},
			registerMessageRenderer() {},
			sendMessage() {},
			getSessionName() { return undefined; },
		}, {
			get(target, prop) {
				if (prop in target) return target[prop];
				return () => undefined;
			},
		});
		registerSubagentExtension(fakePi);
		const facade = registered
			.filter((tool) => tool.name && tool.name.startsWith("subagent"))
			.map((tool) => ({ name: tool.name, description: tool.description, properties: Object.keys(tool.parameters.properties) }));
		process.stdout.write(JSON.stringify(facade));
	`;
	const output = execFileSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"--import",
			"./test/support/register-loader.mjs",
			"--input-type=module",
			"--eval",
			script,
		],
		{ cwd: projectRoot, env: parentToolEnv(agentDir), encoding: "utf-8" },
	);
	// SAFETY: the inline registration script writes only the object we push for
	// each registered facade tool, so the parsed shape is guaranteed.
	return JSON.parse(output) as { name: string; description: string; properties: string[] }[];
}

describe("registered facade tools", { timeout: 120000 }, () => {
	it("registers the three facade tools with matching descriptions and params", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-facade-reg-"));
		const tools = readRegisteredTools(agentDir);
		const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
		assert.deepEqual(Object.keys(byName).sort(), ["subagent", "subagent_control", "subagent_workflow"]);
		assert.equal(byName.subagent.description, SUBAGENT_DELEGATION_DESCRIPTION);
		assert.equal(byName.subagent_workflow.description, SUBAGENT_WORKFLOW_DESCRIPTION);
		assert.equal(byName.subagent_control.description, SUBAGENT_CONTROL_DESCRIPTION);
		assert.deepEqual(byName.subagent.properties.sort(), ["agent", "async", "cwd", "output", "prequel", "reads", "task", "worktree"].sort());
		assert.deepEqual(byName.subagent_workflow.properties.sort(), ["args", "async", "baseRef", "source", "workflow", "worktree"].sort());
		assert.deepEqual(byName.subagent_control.properties.sort(), ["action", "id", "message"].sort());
	});
});