import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { nestedRunScope } from "../../src/runs/shared/nested-events.ts";
import { updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { writeAsyncResultFile } from "../../src/runs/background/result-files.ts";
import { createRunFanoutBudget } from "../../src/runs/shared/run-fanout-budget.ts";
import { WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV, WAIT_TOOL_ENABLED_ENV, resolveWaitToolConfig, waitForSubagents, type SubagentWaitDeps } from "../../src/runs/background/subagent-wait.ts";
import { recordWaitCompletion } from "../../src/runs/background/wait-completions.ts";
import type { AsyncStatus, SubagentState } from "../../src/shared/types.ts";

function writeStatus(asyncRoot: string, runId: string, state: AsyncStatus["state"], extra: object = {}): void {
	const dir = path.join(asyncRoot, runId);
	fs.mkdirSync(dir, { recursive: true });
	// Use a recent timestamp so the stale-run reconciler doesn't mark a live
	// "running" fixture as failed for having a stale heartbeat.
	const nowMs = Date.now();
	fs.writeFileSync(
		path.join(dir, "status.json"),
		JSON.stringify({
			runId,
			mode: "single",
			state,
			startedAt: nowMs,
			lastUpdate: nowMs,
			steps: [{ agent: "worker", status: state }],
			...extra,
		}),
		"utf-8",
	);
	updateActiveRunIndex(dir, state);
}

function writeRecoveryDescriptor(asyncRoot: string, runId: string, agent: string, sessionFile: string, cwd: string): void {
	fs.writeFileSync(path.join(asyncRoot, runId, "recovery-descriptor.json"), JSON.stringify({
		version: 1,
		sourceRunId: runId,
		agent,
		sessionFile,
		cwd,
		systemPromptMode: "append",
		outputMode: "inline",
		inheritGlobalContext: false,
		inheritProjectContext: false,
		inheritSkills: false,
		maxSubagentDepth: 0,
		share: false,
		runFanoutBudget: createRunFanoutBudget(runId, 64),
	}), "utf-8");
}

function makeState(sessionId: string | null): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as SubagentState;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("");
}

function assertSupervisorYield(
	result: Awaited<ReturnType<typeof waitForSubagents>>,
	activeRunIds: string[],
	activeProviderItems: Array<{ provider: string; id: string }> = [],
): void {
	assert.equal(result.isError, undefined);
	assert.deepEqual(result.details.wait, { reason: "supervisor_request", timedOut: false, activeRunIds, activeProviderItems });
	assert.match(textOf(result), /yielded for a pending supervisor request/i);
	assert.doesNotMatch(textOf(result), /(?:done|complete|window elapsed)/i);
	assert.equal(result.details.completions, undefined);
}

function baseDeps(root: string, state: SubagentState, overrides: Partial<SubagentWaitDeps> = {}): SubagentWaitDeps {
	return {
		state,
		asyncDirRoot: path.join(root, "runs"),
		resultsDir: path.join(root, "results"),
		// Never probe real PIDs in tests — treat every recorded pid as alive so
		// reconciliation doesn't flip a "running" fixture to failed.
		kill: () => true,
		pollIntervalMs: 250,
		...overrides,
	};
}

describe("bg_wait tool", () => {
	for (const alreadyTerminal of [false, true]) {
		for (const prefix of [false, true]) {
			it(`collects nested results by ${prefix ? "prefix" : "exact id"} ${alreadyTerminal ? "after early completion" : "across active-to-terminal transition"}`, async (t) => {
				const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-nested-"));
				const nestedRootRunId = randomUUID();
				const scope = nestedRunScope(nestedRootRunId);
				t.after(() => {
					for (const dir of [root, scope.asyncDirRoot, scope.resultsDir]) fs.rmSync(dir, { recursive: true, force: true });
				});
				const runId = randomUUID();
				const resultPath = path.join(scope.resultsDir, `${runId}.json`);
				const outputPath = path.join(root, "persona.md");
				fs.writeFileSync(outputPath, "PERSONA_EVIDENCE");
				const finish = () => {
					writeAsyncResultFile(resultPath, { runId, sessionId: "owner", success: true, results: [{ agent: "persona", output: "PERSONA_EVIDENCE", artifactPaths: { outputPath } }] });
					writeStatus(scope.asyncDirRoot, runId, "complete", { sessionId: "owner" });
				};
				if (alreadyTerminal) finish();
				else writeStatus(scope.asyncDirRoot, runId, "running", { sessionId: "owner" });
				let polls = 0;
				const result = await waitForSubagents({ id: prefix ? runId.slice(0, 8) : runId }, undefined, baseDeps(root, makeState("owner"), {
					nestedRootRunId, sleep: async () => { polls++; finish(); },
				}));
				assert.equal(result.isError, undefined, textOf(result));
				assert.equal(polls, alreadyTerminal ? 0 : 1);
				assert.equal(result.details.completions?.[0]?.runId, runId);
				assert.equal(result.details.completions?.[0]?.results?.[0]?.artifactPaths?.outputPath, outputPath);
				assert.ok(textOf(result).includes(resultPath));
				assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf8")).results[0].output, "PERSONA_EVIDENCE");
			});
		}
	}

	it("all:true collects ordinary workflow and nested results but excludes siblings and other roots", async (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-mixed-"));
		const nestedRootRunId = randomUUID();
		const nested = nestedRunScope(nestedRootRunId);
		const otherRoot = nestedRunScope(randomUUID());
		const ordinary = { asyncDirRoot: path.join(root, "runs"), resultsDir: path.join(root, "results") };
		t.after(() => { for (const dir of [root, nested.asyncDirRoot, nested.resultsDir, otherRoot.asyncDirRoot]) fs.rmSync(dir, { recursive: true, force: true }); });
		const owned = [[ordinary, "workflow-owned"], [nested, "persona-one"], [nested, "persona-two"]] as const;
		for (const [scope, id] of owned) writeStatus(scope.asyncDirRoot, id, "running", { sessionId: "owner" });
		writeStatus(nested.asyncDirRoot, "sibling-persona", "running", { sessionId: "sibling-coordinator" });
		writeStatus(ordinary.asyncDirRoot, "foreign-workflow", "running", { sessionId: "other-session" });
		writeStatus(otherRoot.asyncDirRoot, "outside-route", "running", { sessionId: "owner" });
		const state = makeState("owner");
		let polls = 0;
		const deps = baseDeps(root, state, { nestedRootRunId, sleep: async () => {
			const [scope, id] = owned[polls++]!;
			writeAsyncResultFile(path.join(scope.resultsDir, `${id}.json`), { runId: id, sessionId: "owner", results: [{ structuredOutput: { finding: id } }] });
			writeStatus(scope.asyncDirRoot, id, "complete", { sessionId: "owner" });
		} });
		const result = await waitForSubagents({ all: true }, undefined, deps);
		assert.equal(polls, 3);
		assert.match(textOf(result), /3 complete/);
		assert.deepEqual(new Set(result.details.completions?.map((c) => c.runId)), new Set(owned.map(([, id]) => id)));
		for (const completion of result.details.completions ?? []) assert.deepEqual(completion.results?.[0]?.structuredOutput, { finding: completion.runId });
		for (const id of ["sibling-persona", "sibling-", "foreign-workflow", "outside-route"]) {
			assert.match(textOf(await waitForSubagents({ id }, undefined, deps)), /No active run matched/);
		}
		writeStatus(nested.asyncDirRoot, "sibling-persona", "complete", { sessionId: "sibling-coordinator" });
		assert.match(textOf(await waitForSubagents({ id: "sibling-persona" }, undefined, deps)), /No active run matched/);
	});

	it("does not reconcile a sibling coordinator's nested runs during aggregate discovery", async (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-sibling-reconcile-"));
		const nestedRootRunId = randomUUID();
		const scope = nestedRunScope(nestedRootRunId);
		t.after(() => { for (const dir of [root, scope.asyncDirRoot]) fs.rmSync(dir, { recursive: true, force: true }); });
		writeStatus(scope.asyncDirRoot, "foreign-persona", "running", { sessionId: "sibling", pid: 987654, lastUpdate: 1, startedAt: 1 });
		const statusPath = path.join(scope.asyncDirRoot, "foreign-persona", "status.json");
		const before = fs.readFileSync(statusPath, "utf8");
		let probes = 0;
		const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, makeState("owner"), {
			nestedRootRunId, kill: () => { probes++; return false; },
		}));
		assert.equal(probes, 0, "sharing a root does not authorize probing or reconciling sibling processes");
		assert.match(textOf(result), /Nothing to wait for/);
		assert.equal(fs.readFileSync(statusPath, "utf8"), before);
	});

	it("resolves prefix ambiguity across scopes and prefers an exact already-terminal id", async (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-prefix-scopes-"));
		const nestedRootRunId = randomUUID();
		const scope = nestedRunScope(nestedRootRunId);
		t.after(() => { for (const dir of [root, scope.asyncDirRoot]) fs.rmSync(dir, { recursive: true, force: true }); });
		const deps = baseDeps(root, makeState("owner"), { nestedRootRunId });
		writeStatus(deps.asyncDirRoot!, "shared-prefix-active", "running", { sessionId: "owner" });
		writeStatus(scope.asyncDirRoot, "shared-prefix", "complete", { sessionId: "owner" });
		const ambiguous = await waitForSubagents({ id: "shared-p" }, undefined, deps);
		assert.equal(ambiguous.isError, true);
		assert.match(textOf(ambiguous), /Ambiguous.*2 runs/);
		const exact = await waitForSubagents({ id: "shared-prefix" }, undefined, deps);
		assert.equal(exact.isError, undefined);
		assert.match(textOf(exact), /is terminal.*1 complete/);
	});


	it("resolves waitTool config and environment overrides strictly", () => {
		assert.deepEqual(resolveWaitToolConfig(undefined, {}), { enabled: true });
		assert.deepEqual(resolveWaitToolConfig(false, {}), { enabled: false });
		assert.deepEqual(resolveWaitToolConfig({ enabled: false }, {}), { enabled: false });
		assert.deepEqual(resolveWaitToolConfig({ defaultTimeoutMs: 120_000 }, {}), { enabled: true, defaultTimeoutMs: 120_000 });
		assert.deepEqual(resolveWaitToolConfig({ defaultTimeoutMs: 120_000 }, { [WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV]: "3000" }), { enabled: true, defaultTimeoutMs: 3_000 });
		assert.deepEqual(resolveWaitToolConfig({ enabled: false }, { [WAIT_TOOL_ENABLED_ENV]: "true" }), { enabled: true });
		assert.deepEqual(resolveWaitToolConfig(true, { [WAIT_TOOL_ENABLED_ENV]: "off" }), { enabled: false });
		assert.throws(() => resolveWaitToolConfig("false" as never, {}), /config\.waitTool/);
		assert.throws(() => resolveWaitToolConfig({ enabled: "false" } as never, {}), /config\.waitTool\.enabled/);
		assert.throws(() => resolveWaitToolConfig({ defaultTimeoutMs: 0 }, {}), /config\.waitTool\.defaultTimeoutMs/);
		assert.throws(() => resolveWaitToolConfig({ defaultTimeoutMs: 1.5 }, {}), /config\.waitTool\.defaultTimeoutMs/);
		assert.throws(() => resolveWaitToolConfig(undefined, { [WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV]: "0" }), /PI_SUBAGENT_WAIT_TOOL_DEFAULT_TIMEOUT_MS/);
		assert.throws(() => resolveWaitToolConfig(undefined, { [WAIT_TOOL_ENABLED_ENV]: "maybe" }), /PI_SUBAGENT_WAIT_TOOL_ENABLED/);
	});

	it("returns immediately without polling when waitTool is disabled", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-disabled-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			let slept = false;
			const result = await waitForSubagents({}, undefined, baseDeps(root, state, {
				enabled: false,
				sleep: async () => {
					slept = true;
					throw new Error("disabled bg_wait should not sleep");
				},
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /disabled/i);
			assert.match(textOf(result), /without blocking/i);
			assert.equal(slept, false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns immediately when there is nothing to wait for", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-empty-"));
		try {
			const state = makeState("sess-1");
			const result = await waitForSubagents({}, undefined, baseDeps(root, state));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /nothing to wait for/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("with all:true, resolves once every active run reaches a terminal state", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-resolve-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "run-b", "queued", { sessionId: "sess-1", pid: 999998 });

			// Flip one run terminal on the first poll, the other on the second — so
			// all:true must keep waiting past the first completion.
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
				if (polls === 2) writeStatus(asyncRoot, "run-b", "failed", { sessionId: "sess-1" });
			};

			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /done/i);
			assert.match(text, /1 complete/);
			assert.match(text, /1 failed/);
			assert.ok(polls >= 2, "all:true should wait for both completions");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("streams active async run status while waiting", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-progress-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-live", "running", {
				sessionId: "sess-1",
				pid: 999999,
				steps: [{
					agent: "worker",
					status: "running",
					currentTool: "edit",
					currentPath: "src/render.ts",
					turnCount: 2,
					toolCount: 4,
				}],
			});
			const updates: string[] = [];
			const result = await waitForSubagents({}, undefined, baseDeps(root, state, {
				onUpdate: (update) => updates.push(textOf(update)),
				sleep: async () => writeStatus(asyncRoot, "run-live", "complete", { sessionId: "sess-1" }),
			}));

			assert.equal(result.isError, undefined);
			assert.equal(updates.length, 1);
			assert.match(updates[0]!, /Waiting .* for 1 async run/);
			assert.match(updates[0]!.split("\n")[0]!, /worker: edit .*src\/render\.ts/);
			assert.match(updates[0]!, /run-live/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("surfaces failed terminal runs as errors only for internal auto-drain", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-drain-failure-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-failed", "running", { sessionId: "sess-1", pid: 999999 });
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				failOnFailedRuns: true,
				sleep: async () => writeStatus(asyncRoot, "run-failed", "failed", { sessionId: "sess-1" }),
			}));
			assert.equal(result.isError, true);
			assert.match(textOf(result), /1 failed/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("tells blocking callers to revive resumable failed runs before replacing them", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-revive-first-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "worker-session.jsonl");
			fs.writeFileSync(sessionFile, "{}\n", "utf-8");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-revive", "running", { sessionId: "sess-1", pid: 999999 });
			writeRecoveryDescriptor(asyncRoot, "run-revive", "worker", sessionFile, root);
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				sleep: async () => writeStatus(asyncRoot, "run-revive", "failed", {
					sessionId: "sess-1",
					steps: [{ agent: "worker", status: "failed", sessionFile }],
				}),
			}));

			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /1 failed/);
			assert.match(text, /Resume-first/);
			assert.match(text, /subagent\(\{ action: "resume", id: "run-revive", message:/);
			assert.match(text, /before reporting failure or launching a replacement/);
			assert.match(text, /only if revive fails or the user explicitly asks/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not advertise resume-first when the recovery descriptor is missing", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-no-recovery-descriptor-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "worker-session.jsonl");
			fs.writeFileSync(sessionFile, "{}\n", "utf-8");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-no-descriptor", "running", { sessionId: "sess-1", pid: 999999 });
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				sleep: async () => writeStatus(asyncRoot, "run-no-descriptor", "failed", {
					sessionId: "sess-1",
					steps: [{ agent: "worker", status: "failed", sessionFile }],
				}),
			}));

			assert.equal(result.isError, undefined);
			assert.doesNotMatch(textOf(result), /Resume-first/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the single-child run session fallback with a matching recovery descriptor", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-run-session-fallback-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "worker-session.jsonl");
			fs.writeFileSync(sessionFile, "{}\n", "utf-8");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-session-fallback", "running", { sessionId: "sess-1", pid: 999999 });
			writeRecoveryDescriptor(asyncRoot, "run-session-fallback", "worker", sessionFile, root);
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				sleep: async () => writeStatus(asyncRoot, "run-session-fallback", "failed", {
					sessionId: "sess-1",
					sessionFile,
					steps: [{ agent: "worker", status: "failed" }],
				}),
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /Resume-first/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});



	it("rejects ambiguous id prefixes but lets exact ids win", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-ambiguous-id-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "prefix-aa-1", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "prefix-aa-2", "running", { sessionId: "sess-1", pid: 999998 });
			writeStatus(asyncRoot, "run", "running", { sessionId: "sess-1", pid: 999997 });

			const ambiguous = await waitForSubagents({ id: "prefix-aa" }, undefined, baseDeps(root, state));
			assert.equal(ambiguous.isError, true);
			assert.match(textOf(ambiguous), /Ambiguous subagent run id prefix "prefix-aa"/);
			assert.match(textOf(ambiguous), /prefix-aa-2/);

			let polls = 0;
			const exact = await waitForSubagents({ id: "run" }, undefined, baseDeps(root, state, {
				sleep: async () => {
					polls += 1;
					writeStatus(asyncRoot, "run", "complete", { sessionId: "sess-1" });
				},
			}));

			assert.equal(exact.isError, undefined);
			assert.match(textOf(exact), /run "run".*done/is);
			assert.equal(polls, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not reconcile unrelated runs when waiting for an exact id", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-exact-id-scan-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "target-run", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "other-run-a", "running", { sessionId: "sess-1", pid: 999998 });
			writeStatus(asyncRoot, "other-run-b", "running", { sessionId: "sess-1", pid: 999997 });

			let probes = 0;
			const result = await waitForSubagents({ id: "target-run" }, undefined, baseDeps(root, state, {
				kill: () => {
					probes++;
					return true;
				},
				sleep: async () => writeStatus(asyncRoot, "target-run", "complete", { sessionId: "sess-1" }),
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /run "target-run".*done/is);
			assert.equal(probes, 1, "exact-id waits should reconcile only the selected run");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects dot-segment ids before probing outside the async root", async () => {
		for (const id of [".", ".."]) {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-dot-id-"));
			try {
				const asyncRoot = path.join(root, "runs");
				const state = makeState("sess-1");
				fs.writeFileSync(path.join(root, "status.json"), JSON.stringify({
					runId: id,
					mode: "single",
					state: "running",
					startedAt: Date.now(),
					lastUpdate: Date.now(),
					sessionId: "sess-1",
					steps: [{ agent: "outside", status: "running" }],
				}), "utf-8");

				const result = await waitForSubagents({ id }, undefined, baseDeps(root, state));

				assert.equal(result.isError, undefined);
				assert.ok(textOf(result).includes(`No active run matched "${id}"`));
				assert.equal(fs.existsSync(path.join(asyncRoot, "status.json")), false);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it("times out while runs are still active and reports them", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-timeout-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-stuck", "running", { sessionId: "sess-1", pid: 999999 });

			// Virtual clock that jumps past the timeout on the first sleep.
			let clock = 0;
			const now = () => clock;
			const sleep = async (ms: number) => {
				clock += ms + 10_000;
			};

			const result = await waitForSubagents({ timeoutMs: 5_000 }, undefined, baseDeps(root, state, { now, sleep, defaultTimeoutMs: 1_000 }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /window elapsed after 5\.0s/i, "explicit timeoutMs must override the configured default");
			assert.match(text, /run-stuck \(running\)/);
			assert.deepEqual(result.details.wait, {
				reason: "window_elapsed",
				timedOut: true,
				activeRunIds: ["run-stuck"],
				activeProviderItems: [],
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the configured wait window when timeoutMs is omitted", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-config-timeout-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-configured", "running", { sessionId: "sess-1", pid: 999999 });
			let clock = 0;
			const result = await waitForSubagents({}, undefined, baseDeps(root, state, {
				now: () => clock,
				sleep: async (ms) => { clock += ms + 10_000; },
				defaultTimeoutMs: 2_000,
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /window elapsed after 2\.0s/i);
			assert.equal(result.details.wait?.reason, "window_elapsed");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports still-active provider identities when the wait window elapses", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-provider-timeout-"));
		try {
			const state = makeState("sess-1");
			let clock = 0;
			const result = await waitForSubagents({ timeoutMs: 1_000 }, undefined, baseDeps(root, state, {
				now: () => clock,
				sleep: async (ms) => { clock += ms + 10_000; },
				backgroundWork: {
					snapshot: () => ({
						providers: ["herdr"],
						items: [{ provider: "herdr", id: "pane-1", sessionId: "sess-1" }],
					}),
					wakeChannels: () => [],
				},
			}));

			assert.equal(result.isError, undefined);
			assert.deepEqual(result.details.wait?.activeProviderItems, [{ provider: "herdr", id: "pane-1" }]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves early when the turn is aborted", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-abort-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-x", "running", { sessionId: "sess-1", pid: 999999 });

			const controller = new AbortController();
			const sleep = async () => {
				controller.abort();
			};

			const result = await waitForSubagents({}, controller.signal, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, true);
			assert.match(textOf(result), /aborted/i);
			assert.match(textOf(result), /run-x \(running\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("wakes immediately on an event bus emission instead of waiting the poll interval", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-event-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });

			// Fake bus. Emitting on a wake channel should end wait's sleep early.
			const handlers = new Map<string, Array<(d: unknown) => void>>();
			const events = {
				on(channel: string, handler: (d: unknown) => void) {
					const list = handlers.get(channel) ?? [];
					list.push(handler);
					handlers.set(channel, list);
					return () => {
						const l = handlers.get(channel) ?? [];
						handlers.set(channel, l.filter((h) => h !== handler));
					};
				},
				emit(channel: string, data: unknown) {
					for (const h of handlers.get(channel) ?? []) h(data);
				},
			};

			let sleepCalls = 0;
			let sleepArmed!: () => void;
			const armed = new Promise<void>((resolve) => { sleepArmed = resolve; });
			const sleep = (_ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
				sleepCalls += 1;
				signal?.addEventListener("abort", resolve, { once: true });
				sleepArmed();
			});

			const p = waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				events,
				pollIntervalMs: 10_000,
				sleep,
			}));

			await armed;
			writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			events.emit("subagent:async-complete", { id: "run-a" });

			const result = await Promise.race([
				p,
				new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("event wake did not resolve bg_wait")), 1_000)),
			]);
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /done/i);
			assert.ok(sleepCalls >= 1, "poll-interval sleep still armed as fallback");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("still resolves via poll when no event bus is provided (fallback)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-nobus-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			};
			// No `events` in deps → pure poll path.
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /done/i);
			assert.ok(polls >= 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
