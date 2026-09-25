import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { collectSessionPreview, parseBriefResponse, parseSessionEntries, wrapPrequelTask, wrapSummaryTask } from "../../src/shared/context-brief.ts";
import { resolveSubagentContext, resolveSubagentLaunchContext } from "../../src/shared/fork-context.ts";
import { contextModeLabel } from "../../src/runs/shared/context-mode.ts";
import { discoverAgentSnapshot } from "../../src/agents/agents.ts";

function writeSessionJsonl(filePath: string, entries: unknown[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
}

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `pi-subagents-${prefix}-`));
}

interface SessionEntryFixture {
	type: string;
	id: string;
	timestamp: string;
	message: { role?: string; toolCallId?: string; toolName?: string; content: unknown };
}

function entry(id: string, message: SessionEntryFixture["message"]): SessionEntryFixture {
	return { type: "message", id, timestamp: "2026-04-16T00:00:00.000Z", message };
}

describe("parseSessionEntries", () => {
	it("extracts user text, assistant text and tool-call names; skips thinking and tool results", () => {
		const dir = tempDir("brief-parse");
		try {
			const file = path.join(dir, "session.jsonl");
			writeSessionJsonl(file, [
				{ type: "session", id: "s1", timestamp: "2026-04-16T00:00:00.000Z" },
				entry("e1", { role: "user", content: [ { type: "text", text: "Refactor the client fetch" } ] }),
				entry("e2", { role: "assistant", content: [
					{ type: "thinking", thinking: "private reasoning" },
					{ type: "text", text: "I will start in src/client.ts." },
					{ type: "toolCall", id: "c1", name: "read", arguments: {"path": "src/client.ts"} },
				] }),
				entry("e3", { role: "toolResult", toolCallId: "c1", toolName: "read", content: [ { type: "text", text: "huge result body" } ] }),
			]);
			const entries = parseSessionEntries(file);
			assert.equal(entries.length, 2);
			assert.equal(entries[0]?.role, "user");
			assert.deepEqual(entries[0]?.texts, ["Refactor the client fetch"]);
			assert.equal(entries[1]?.role, "assistant");
			assert.deepEqual(entries[1]?.texts, ["I will start in src/client.ts."]);
			assert.deepEqual(entries[1]?.toolCalls, ["read"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("accepts plain string user content", () => {
		const dir = tempDir("brief-string");
		try {
			const file = path.join(dir, "session.jsonl");
			writeSessionJsonl(file, [entry("e1", { role: "user", content: "plain text" })]);
			const entries = parseSessionEntries(file);
			assert.equal(entries[0]?.texts[0], "plain text");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws with a line reference for malformed JSONL", () => {
		const dir = tempDir("brief-malformed");
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, '{"type":"session"}\n{"broken":\n', "utf-8");
			assert.throws(() => parseSessionEntries(file), /invalid JSONL on line 2/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("collectSessionPreview", () => {
	it("walks newest-first and labels role prefixes and tool calls", () => {
		const preview = collectSessionPreview([
			{ role: "assistant", texts: ["older"], toolCalls: [] },
			{ role: "user", texts: ["newest"], toolCalls: ["grep"] },
		], 100_000);
		const userIndex = preview.indexOf("User: newest");
		const toolIndex = preview.indexOf("Tool call: grep");
		const assistantIndex = preview.indexOf("Assistant: older");
		assert.ok(userIndex >= 0 && toolIndex >= 0 && assistantIndex >= 0);
		assert.ok(userIndex < assistantIndex, "newest entries come first");
	});

	it("respects the input budget", () => {
		const preview = collectSessionPreview([
			{ role: "user", texts: ["a very long message ".repeat(50)], toolCalls: [] },
		], 200);
		assert.ok(preview.length <= 220, "budget bounds the preview");
	});
});

describe("wrapSummaryTask", () => {
	it("prepends the brief before the Task label and preserves the task", () => {
		const wrapped = wrapSummaryTask("Implement X.", "Decisions: A");
		assert.match(wrapped, /^Context brief from the parent session:\nDecisions: A\n\nTask:\nImplement X\.$/);
	});
});

describe("parseBriefResponse", () => {
	it("accepts a single-key brief object", () => {
		assert.equal(parseBriefResponse('{"brief":"Do Y."}', 4096, "worker"), "Do Y.");
	});

	it("rejects invalid JSON, empty briefs, and oversized briefs", () => {
		assert.throws(() => parseBriefResponse("not json", 4096, "worker"), /invalid JSON/);
		assert.throws(() => parseBriefResponse('{"brief":"   "}', 4096, "worker"), /empty/);
		const tooLong = `{"brief":"${"x".repeat(5000)}"}`;
		assert.throws(() => parseBriefResponse(tooLong, 4096, "worker"), /exceeds the 4096-character budget/);
		assert.throws(() => parseBriefResponse('{"other":"x"}', 4096, "worker"), /empty brief/);
	});
});

describe("summary context resolution", () => {
	it("resolves explicit summary strictly even without an implicit-fork snapshot", () => {
		assert.equal(resolveSubagentLaunchContext({
			explicitContext: "summary",
			canUseImplicitFork: false,
		}), "summary");
	});

	it("falls back to fresh for an implicit summary without a persisted parent session", () => {
		assert.equal(resolveSubagentLaunchContext({
			explicitContext: undefined,
			agentDefaultContext: "summary",
			canUseImplicitFork: false,
		}), "fresh");
	});

	it("keeps an implicit summary when the snapshot is available, and lets explicit fresh win", () => {
		assert.equal(resolveSubagentLaunchContext({
			explicitContext: undefined,
			agentDefaultContext: "summary",
			canUseImplicitFork: true,
		}), "summary");
		assert.equal(resolveSubagentLaunchContext({
			explicitContext: "fresh",
			agentDefaultContext: "summary",
			canUseImplicitFork: true,
		}), "fresh");
	});

	it("resolves to fresh when the launch omits context and the agent declares none", () => {
		assert.equal(resolveSubagentLaunchContext({
			explicitContext: undefined,
			agentDefaultContext: undefined,
			canUseImplicitFork: true,
		}), "fresh");
	});

	it("uses the agent's declared defaultContext when the launch omits context", () => {
		assert.equal(resolveSubagentLaunchContext({
			explicitContext: undefined,
			agentDefaultContext: "summary",
			canUseImplicitFork: true,
		}), "summary");
		assert.equal(resolveSubagentLaunchContext({
			explicitContext: undefined,
			agentDefaultContext: "fork",
			canUseImplicitFork: true,
		}), "fork");
	});

	it("maps raw values through resolveSubagentContext with fallback-fresh", () => {
		assert.equal(resolveSubagentContext(undefined), "fresh");
		assert.equal(resolveSubagentContext("summary"), "summary");
		assert.equal(resolveSubagentContext("fork"), "fork");
	});
});

describe("wrapPrequelTask", () => {
	it("prepends a labeled prequel block before the wrapped task", () => {
		const wrapped = wrapPrequelTask("Task:\nImplement X.", "Decisions: A; files: src/a.ts");
		assert.match(wrapped, /^Prequel \(state of the work\):\nDecisions: A; files: src\/a\.ts\n\nTask:\nImplement X\.$/);
	});

	it("keeps the prequel block outside the summary brief wrapper", () => {
		const wrapped = wrapPrequelTask(wrapSummaryTask("Implement X.", "Decisions: A"), "State from the parent");
		assert.match(wrapped, /^Prequel \(state of the work\):\nState from the parent\n\nContext brief from the parent session:\nDecisions: A\n\nTask:\nImplement X\.$/);
	});

	it("prepends nothing for an omitted or empty prequel", () => {
		assert.equal(wrapPrequelTask("Task:\nImplement X.", undefined), "Task:\nImplement X.");
		assert.equal(wrapPrequelTask("Task:\nImplement X.", "   "), "Task:\nImplement X.");
	});
});

describe("context mode labels", () => {
	it("labels summary distinctly from fork and fresh", () => {
		assert.equal(contextModeLabel("summary"), "[summary]");
		assert.equal(contextModeLabel("fork"), "[fork]");
		assert.equal(contextModeLabel("fresh"), "[fresh]");
		assert.equal(contextModeLabel("mixed"), "[mixed]");
	});
});

describe("summary agent frontmatter", () => {
	it("parses defaultContext: summary and contextBrief from an agent definition", () => {
		const dir = tempDir("brief-agent");
		try {
			const cwd = path.join(dir, "repo");
			const agentsDir = path.join(cwd, ".pi", "agents");
			fs.mkdirSync(agentsDir, { recursive: true });
			fs.writeFileSync(path.join(agentsDir, "scout.md"), `---\nname: scout\ndescription: Recon fixture\ndefaultContext: summary\ncontextBrief: Focus on entry points and open questions.\n---\nScout body.\n`, "utf-8");
			const discovered = discoverAgentSnapshot(cwd, "project", undefined);
			const scout = discovered.effective.agents.find((agent) => agent.name === "scout");
			assert.ok(scout, "scout agent discovered");
			assert.equal(scout.defaultContext, "summary");
			assert.equal(scout.contextBrief, "Focus on entry points and open questions.");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});