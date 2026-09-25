import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/child-runtime-config.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

it("emits bounded file-only snapshots, refreshes through management, and performs zero prompt-time filesystem calls", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "advertised-refresh-"));
	const env = { ...process.env, PI_CODING_AGENT_DIR: home };
	delete env[SUBAGENT_CHILD_ENV];
	try {
		const output = execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", String.raw`
			import assert from "node:assert/strict";
			import fs from "node:fs";
			import path from "node:path";
			import { syncBuiltinESMExports } from "node:module";
			import register from "./src/extension/index.ts";
			import { registerSubagentCapabilityCeiling } from "./src/runs/shared/capability-ceiling.ts";
			const home = process.env.PI_CODING_AGENT_DIR;
			const cwd = path.join(home, "project");
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			const dir = path.join(home, "agents");
			fs.mkdirSync(dir);
			const write = (file, name, description, advertise = true) => fs.writeFileSync(path.join(dir, file + ".md"),
				"---\nname: " + name + "\ndescription: " + description + "\nadvertise: " + advertise + "\n---\nAct narrowly.\n");
			const handlers = new Map();
			let tool;
			let activeTools = ["subagent"];
			const pi = new Proxy({
				events: { on() { return () => {}; }, emit() {} },
				on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
				registerTool(value) { if (value.name === "subagent") tool = value; },
				getActiveTools() { return activeTools; },
			}, { get(target, key) { return key in target ? target[key] : () => undefined; } });
			register(pi);
			const ctx = {
				cwd, hasUI: false, model: { provider: "test", id: "test" },
				modelRegistry: { getAvailable() { return []; }, getAll() { return []; } },
				sessionManager: { getSessionId() { return "advertised-test"; }, getSessionFile() { return undefined; }, getBranch() { return []; } },
			};
			// Invoke the registered catalog lifecycle hook; unrelated host services are not started by this harness.
			const refresh = (reason = "reload") => handlers.get("session_start").at(-1)({ reason }, ctx);
			const emit = (systemPrompt = "base", selectedTools = activeTools) => {
				const result = handlers.get("before_agent_start").at(-1)({ systemPrompt, systemPromptOptions: { selectedTools: selectedTools ?? undefined } }, ctx);
				return result?.systemPrompt ?? systemPrompt;
			};
			const io = { statSync: 0, readdirSync: 0, readFileSync: 0 };
			const originals = {};
			for (const key of Object.keys(io)) {
				originals[key] = fs[key];
				fs[key] = (...args) => { io[key]++; return originals[key](...args); };
			}
			syncBuiltinESMExports();
			const noIo = (fn) => {
				const before = { ...io };
				const result = fn();
				assert.deepEqual(io, before, "prompt emission must not stat, readdir, or read files");
				return result;
			};
			refresh("startup");
			const builtin = noIo(() => emit());
			assert.match(builtin, /<advertised_subagents>/);
			assert.match(builtin, /<name>scout<\/name>/);
			assert.match(builtin, /<name>worker<\/name>/);
			noIo(() => { for (let i = 0; i < 20; i++) assert.equal(emit(), builtin); });
			for (let i = 0; i < 250; i++) write("hidden-" + i, "hidden-" + i, "hidden", false);
			refresh();
			noIo(() => { for (let i = 0; i < 20; i++) assert.equal(emit(), builtin); });
			write("specialist", "specialist", "Original specialist");
			assert.equal(noIo(() => emit()), builtin, "external edits wait for reload");
			refresh();
			let prompt = noIo(() => emit());
			assert.match(prompt, /<name>specialist<\/name>/);
			assert.doesNotMatch(prompt, /hidden-/);
			assert.match(prompt, /Before execution.*action: "list", capabilities: true/);
			assert.equal(noIo(() => emit(prompt, ["read"])), "base");
			activeTools = ["read"];
			assert.equal(noIo(() => emit(prompt, null)), "base");
			activeTools = ["subagent"];
			const ceiling = registerSubagentCapabilityCeiling({ sessionId: "advertised-test", source: "test", ceiling: { allowedAgents: [] } });
			assert.equal(noIo(() => emit(prompt)), "base");
			ceiling.dispose();
			assert.match(noIo(() => emit()), /Original specialist/);
			// Agent-management CRUD (create/update/delete/enable/disable) was
			// intentionally removed from the M1 model-facing surface (owned by
			// slash/config per D5). The advertised-prompt snapshot and zero-IO
			// assertions below remain and still hold.
			write("huge", "a".repeat(100000), "huge name");
			write("escaped-name", "b" + "&".repeat(4000), "escaped huge name");
			for (let i = 0; i < 25; i++) write("opt-" + i, "pkg.opt-" + i, i % 2 ? '<>&"'.repeat(300) : "🦜界".repeat(300));
			refresh();
			prompt = noIo(() => { let result; for (let i = 0; i < 20; i++) result = emit(); return result; });
			const catalog = prompt.slice(prompt.indexOf("<advertised_subagents>"));
			assert.ok(Buffer.byteLength(catalog) <= 12288);
			assert.doesNotMatch(catalog, /<name>[ab]/);
			assert.match(catalog, /&lt;&gt;&amp;&quot;/);
			assert.match(catalog, /not instructions to delegate/);
			assert.match(catalog, /🦜界/);
			assert.doesNotMatch(catalog, /�/);
			assert.match(catalog, /<name>pkg\.opt-\d+<\/name>/);
			assert.match(catalog, /<omitted count="\d+"/);
			for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
			assert.equal(noIo(() => emit()), prompt, "external removal waits for reload");
			refresh();
			assert.equal(noIo(() => emit(prompt)), builtin);
			process.stdout.write("prompt contracts passed; zero prompt-time stat/readdir/readFile calls at 0, 250, and 277 definitions");
		`], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
		assert.match(output, /prompt contracts passed/);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
