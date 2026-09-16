import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildDoctorReport } from "../../src/extension/doctor.ts";
import type { AgentConfig, ChainConfig } from "../../src/agents/agents.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function makeState(cwd: string): SubagentState {
	return {
		baseCwd: cwd,
		currentSessionId: "session-current",
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
	};
}

function makeAgent(name: string, source: AgentConfig["source"]): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: "Prompt",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source,
		filePath: `/tmp/${name}.md`,
	};
}

function makeChain(name: string, source: ChainConfig["source"]): ChainConfig {
	return {
		name,
		description: `${name} chain`,
		source,
		filePath: `/tmp/${name}.chain.md`,
		steps: [{ agent: "worker", task: "Work" }],
	};
}

describe("buildDoctorReport", () => {

	it("reports the effective source when the run fan-out environment value is invalid", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-fanout-source-"));
		const previous = process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN;
		try {
			process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN = "invalid";
			const report = buildDoctorReport({
				cwd: root,
				config: { maxSubagentSpawnsPerRun: 12 },
				state: makeState(root),
				deps: {
					isAsyncAvailable: () => true,
					discoverAgentsAll: () => ({ builtin: [], user: [], project: [], chains: [], userDir: root, projectDir: root, userChainDir: root, projectChainDir: root, userSettingsPath: path.join(root, "user.json"), projectSettingsPath: path.join(root, "project.json") }),
					discoverAvailableSkills: () => [],
					diagnoseIntercomBridge: () => ({ active: false, mode: "off", wantsIntercom: false, supervisorChannelAvailable: false, extensionDir: "none" }),
				},
			});
			assert.match(report, /Run fan-out budget\n- configured limit: 12 \(config\)/);
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN;
			else process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN = previous;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps reporting when a directory or discovery check fails", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-failure-"));
		try {
			const asyncPath = path.join(root, "async-file");
			fs.writeFileSync(asyncPath, "not a directory");
			const report = buildDoctorReport({
				cwd: root,
				config: {},
				state: makeState(root),
				paths: {
					tempRootDir: root,
					asyncDir: asyncPath,
					resultsDir: path.join(root, "missing-results"),
					chainRunsDir: path.join(root, "missing-chains"),
				},
				deps: {
					isAsyncAvailable: () => false,
					discoverAgentsAll: () => {
						throw new Error("discovery exploded");
					},
					discoverAvailableSkills: () => [],
				},
			});

			assert.match(report, /- async support: unavailable/);
			assert.match(report, /- async runs: failed .*Error: not a directory:/);
			assert.match(report, /- results: missing /);
			assert.match(report, /- agents: failed — Error: discovery exploded/);
			assert.match(report, /- skills: total 0 \(none\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
