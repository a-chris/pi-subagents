# Plan: Facade rewrite of the subagent tool surface

> Status: **M3.1 Lanes DONE (merged `d8f67b7d` + synthesis `aaa11a84`) — next: M3.2.** VISION updated; decisions resolved.
> Current milestone: **M3.2 — Schedules** (`schedule.*` actions + `at`/`every`/`timezone`/
> `catchUp`/`overlap`/`on`/`name`, `src/runs/background/scheduled-runs.ts` engine; grep
> `schedule.*` gone; related tests deleted). Then 3.3 watchdog, 3.4 missions-trim.
> M1 result: three facade tools on main; rendered facade schemas 1,995 B total (was 12,449);
> suite 2,931/2,944 at head, sole failure = pre-existing `watchdog-lsp-diagnostics` parallel-load
> flake (passes isolated on both heads). Reviewer accepted the fixes for its two blockers.
> M2 result: agent-owned `defaultContext` (missing → fresh), `config.defaultSubagentContext` removed,
> `profile` removed, `prequel` wired (outermost labeled block for fork|summary, absent for fresh).
> Unit 2,942/2,942 green at head; integration 779/781 (sole pre-existing `single-execution.part-2`
> parse break). Reviewer: APPROVE, no blockers. Residuals: tool-reference/extension-api docs updated
> for context-owner change but full rewrite deferred to M6; `defaultSubagentContext` grep hit is one
> anti-regression assert in schemas.test.ts:219 after M2.
> M3.1 result: multi-lane orchestration removed — `runs.lanes` DSL (scripted-workflow.ts),
> `lane` param + `lane.*` actions, merge/supersession evidence, `usageBudget`, `planId`/`laneId`,
> reference doc; preflight lanes contract kept. Unit 2,911/2,924 (sole fail = the watchdog-lsp
> parallel-load flake family, both :93 and the malformed-JSON sibling pass isolated); integration
> 774/776 (sole pre-existing part-2 parse break). Reviewer verdict was REJECT on two P1s; parent
> evidence showed P1-1 (executable `runs.lanes` tests) was a misclassification — zero executable
> DSL tests remain, only two stale test titles (renamed); P1-2 (`progress.md` staged) + both P2s
> (usageBudget guidance leftovers) fixed in synthesis commit `aaa11a84`.
> Residuals: pi-lens style advisories on pre-existing baseline code (parallel-handoff
> `validateManifestIdentity` L52-63 etc.) recorded, not fixed (option-a decision, M2 precedent).
> Read "Vision & mindset" below first — it is the guideline set for anyone working on
> this plan, in any session, and it is the tie-breaker for implementation issues.

## Vision & mindset — read this first

These are the guidelines. When a contributor hits a decision or an implementation issue,
the principle beats the page: resolve it with this mindset, not by adding a special case.

1. **Facade for the model, engine for TypeScript.** The model sees a small, deliberate
   surface; validation, enrichment, and defaults happen in TypeScript and in declarations
   (agent + config). The internal contract (executor, preflight, bridges) is stable; only
   the surface changes shape.
2. **Impossible states unrepresentable.** Modes live in separate tools; a param exists on
   exactly one tool and cannot appear on another — except the declared cross-cutting set
   `{async, worktree}`, which carry identical meaning on both the delegation and workflow
   facades and create no impossible call. The invariant test asserts the exempt set is exactly
   `{async, worktree}` and never larger. Prefer a schema shape that makes a wrong
   call impossible over a rule the model must remember. Do not reach for `oneOf`/`if-then`
   to fake shape — split the surface instead.
3. **Policy rides with the agent, not the call.** Context mode, recurring reads, skills,
   and model preferences are declared on the agent definition (`defaultContext`,
   `defaultReads`, …) and cannot be overridden per call. Missing declarations fall back to
   a safe default (`fresh` / no reads).
4. **`task` ≠ `prequel`.** `task` states the action to do or problem to solve; `prequel`
   states the current state of the work and what led here. The child consumes `prequel`
   only when its declared mode is `fork|summary`; with `fresh` it stays empty and unused.
5. **Small models are first-class.** Sessions may run weak local models. The surface uses
   simple shapes (string/enum/boolean), ≤ 8 params per tool, enums for closed sets,
   ≤ 60-word descriptions, and live discovery (agent names injected into the description
   at load time).
6. **Removal over compatibility.** A feature whose outcome another path already produces
   (OS scheduling, configuration, a composed workflow) is removed, not maintained. No
   aliases, no shims, no compat modes. Hard cutovers with a CHANGELOG line apiece.
7. **Every removal is deliberate and proven.** One removed param/action = one CHANGELOG
   line + one deleted/updated test. Tests prove the current contract; no defensive tests
   for removed behavior. Delete obsolete assertions rather than neuter them.
8. **One invariant per milestone.** Each milestone proves one property and lands green:
   `npm run test:unit` (+ `test:integration` from M2), measurement recorded when applicable,
   plan.md status + current-milestone updated, committed.

## Why

The `subagent` tool today is one flat, 81-param JSON schema (~12.4 kB rendered) plus a
586–716-word description, injected into the parent session's system prompt **every turn**
(~18.6 kB ≈ 4.5–5.5k tokens). It is the union of three different APIs in one call
contract: delegate-one-child, run-workflow, manage/control. Consequences:

- The model must learn mode-specific rules (`agent` excludes `workflowScript`, `preflight`
  requires a workflow, `action` is management-only…) enforced afterward by a ~90-line
  normalization gate — rules the model carries instead of the system enforcing by shape.
- Every optional param sits at equal depth with no mode grouping, no defaults visible,
  no signal about what matters. This is hostile to small local models.
- Params that serve a single management action (e.g. `repo` for `worktree.cleanup`,
  `at`/`every`/`timezone` for `schedule.create`) are advertised as first-class model choices.

## Baseline (measured 2026-09)

| Surface | Current |
|---|---|
| `subagent` tool params (rendered JSON Schema, minified) | 12,449 chars / 81 top-level params (70 with descriptions) |
| Tool description (default / full) | 4,885 / 6,174 chars |
| Per-session recurring cost | ~18.6 kB ≈ 4.5–5.5k tokens/turn |
| `bg_wait` tool | separate registration (stays) — precedent for multi-tool extensions |

Engine fact that de-risks the change: the 7,196-line executor already takes the full
internal param contract (`executor.executePublic(id, params, …)`). The tool definition is
a **facade** today. Prompt-template, RPC, and slash bridges call `executePublic` /
`executeDelegated` directly and are unaffected by facade changes. Extension consumers use
internal contracts (`preflight`, `delegation`, `background-work`, etc.) and keep working.

## Target design

Three tools, each ≤ 8 params, rendered schemas total ≈ 1.5–2 kB (≈ 85–88% reduction).

### `subagent` — delegate one child (8 params)

```json
{
  "type": "object",
  "required": ["task"],
  "properties": {
    "task":       { "type": "string", "description": "The action to do or problem to solve." },
    "agent":      { "type": "string", "description": "One of the installed agent names (via subagent_control action:list). Default agent when omitted." },
    "prequel":    { "type": "string", "description": "Current state of the work and what led here — separate from task. Consumed when the agent's declared context mode is fork|summary; stays empty with fresh." },
    "reads":      { "type": "array", "items": { "type": "string" }, "description": "Task-specific file paths the child reads before running; the agent's defaultReads still apply." },
    "cwd":        { "type": "string", "description": "Working directory; default: session directory." },
    "async":      { "type": "boolean", "description": "Background run; default false." },
    "output":     { "anyOf": [{ "type": "string" }, { "type": "boolean" }], "description": "Durable result path, or false." },
    "worktree":   { "type": "boolean", "description": "Isolate in a managed git worktree; default false." }
  }
}
```

> Field name: **`prequel`** (locked). Distinctive so it never collides with `async`
> ("background run"), the context-*mode* concept, or mission `state`.
> Contract (D4): `task` = action/problem; `prequel` = current state and what led here;
> the runtime consumes `prequel` only when the agent's declared mode is `fork` or `summary`
> (for `fresh` it stays empty and unused).

### `subagent_workflow` — run a workflow (6 params)

```json
{
  "type": "object",
  "properties": {
    "workflow": { "type": "string", "description": "Named workflow resource, e.g. \"review\" or \"run-ci\"." },
    "source":   { "anyOf": [{ "type": "string" }, { "type": "object", "properties": { "path": { "type": "string" } } }], "description": "Inline script body, or { path } to a script file." },
    "args":     { "type": "object", "description": "Bounded JSON inputs for the workflow." },
    "async":    { "type": "boolean", "description": "Background run; default false." },
    "worktree": { "type": "boolean", "description": "Isolate in a managed git worktree; default false." },
    "baseRef":  { "type": "string", "description": "Branch/ref for worktree isolation." }
  }
}
```

### `subagent_control` — control runs by id (4 params)

```json
{
  "type": "object",
  "properties": {
    "id":      { "type": "string", "description": "Run id/prefix; required for run-targeting actions." },
    "action":  { "enum": ["status", "resume", "steer", "stop", "interrupt", "validate", "list", "get", "models", "guide", "mission.create"], "description": "What to do; omitted = status." },
    "message": { "type": "string", "description": "Guidance for steer/resume." }
  }
}
```

> Read verbs (`list`/`get`/`models`/`guide`) let the model read the agent registry and name
> an agent (D5). `validate` is the cheap script lint (D6). `mission.create` is the only
> mission action kept on the surface (D2).

## Param disposition (complete bucketing of the current 81)

| Bucket | Params | Decision |
|---|---|---|
| Delegation facade | `task`, `agent`, `prequel` (new), `reads` (new on main tool), `cwd`, `async`, `output`, `worktree` | KEEP model-facing |
| Workflow facade | `workflow`, `source` (merges `workflowScript`+`workflowScriptPath` into one shape), `args`, `async`, `worktree`, `baseRef` | KEEP model-facing |
| Control facade | `id`, `action` (trimmed enum incl. read verbs + `validate` + `mission.create`), `message` | KEEP model-facing |
| Agent-declared | `context` → `defaultContext` (mode only), `skill` (agents declare skills), `model` (agent `model`/config), `reads`-recurring (agent `defaultReads`) | MOVE to agent frontmatter; model never passes mode |
| Config-enriched | `model`, `timeoutMs`/`maxRuntimeMs`, `checkpointBeforeDeadlineMs`, `toolTimeoutMs`, `toolBudget`, `usageBudget`, `agentScope`, `fast`, `includeProgress`, `outputMode` defaults, `control` (attention thresholds), `thinking` | MOVE to `config.ts`-validated keys; executor enriches |
| Extension/API-only (internal contract, stays) | `outputSchema`, `agentContract`, `gate`, `extensionBindings`, `capabilities`, `preflight`, `context` (internal), `reads`-step (workflow steps), `mission` (object + `false` opt-out) | REMAIN on internal `SubagentParams` for `preflight`/delegation consumers, not on any facade |
| Remove entirely | `lane` (654 B), `usageBudget`, `mission*` patch metadata (`missionUpdate`/`missionStatus`/`missionScope`/`missionId`), `chatProgress`, `on`, `runMode`, `runStatus`, `summary`, `additional` (grant-spawn-budget), `planId`, `merge`, `supersession`, `share`, `sessionDir`, `sessionOnly`, `quiet`, `timezone`, `at`, `every`, `name`, `scope`, `target`, `focus`, `overlap`, `catchUp`, `topic`, `lines`, `view`, `handoffPath`, `repo`, `mode`, `steeringRecovery`, `index`, `childId` | DELETE from internal contract, executor, types, docs, tests |
| Control action long tail | `schedule.*`, `watchdog.*`, `inspector.*`, `project.*`, `lane.*`, `mission.*` (except `mission.create`), `worktree.discard`/`cleanup`, `doctor`, `grant-spawn-budget`, agent CRUD (`create`/`update`/`delete`/`eject`/`disable`/`enable`/`reset`/`refine`) | REMOVE from tool. Discovery stays via `list`/`get`/`models`/`guide`. Subsystem removal per D2/D5 |

## Feature removals (owner-approved)

| # | Removed | Verdict |
|---|---|---|
| 1 | Per-call `context` (mode) + `profile` + `config.defaultSubagentContext` — mode agent-owned | **Remove** (D4/D8); add `prequel` field |
| 2 | `toolDescriptionMode` config (`full`/`compact`/`custom`) — `compact` is a no-op alias today; default description text shortened | **Remove** (D3) |
| 3 | `intercom` enum value in `notifyChannels` (schemas.ts:271) + stale supervisor guidance in tool description | **Remove** (no decision needed) |
| 4 | Multi-lane orchestration: `lane` param, `usageBudget`, `lane.*` actions, `runs.lanes` DSL (scripted-workflow.ts), `merge`/`supersession`/`planId`/`handoffPath`, `multi-lane-orchestration.md` reference | **Remove entirely** (D1) — incl. the script-level API |
| 5 | Schedules: `schedule.*` actions + `at`/`every`/`timezone`/`catchUp`/`overlap`/`on`/`name`, `scheduled-runs.ts` engine | **Remove** (D2) — cron/OS equivalent |
| 6 | Watchdog: `watchdog.*` actions + `scope`/`target`/`focus`/`thinking`, `runtime.ts` + watchdog config — second path over config; reviewer workflow composes | **Remove subsystem** (D2) |
| 7 | Missions: keep records + durable `state.get/set` + auto-mission for workflows; keep `mission.create` on surface; drop patch metadata | **Keep, trimmed** (D2) |
| 8 | Agent-management CRUD (`create`/`update`/`delete`/`eject`/`disable`/`enable`/`reset`/`refine`) — read stays (`list`/`get`/`models`/`guide`), write goes to slash/config | **Remove write surface** (D5) |
| 9 | `preflight` param internal-only; `validate` action stays | **As stated** (D6) |
| 10 | `reads` per-call (plain path list) + agent `defaultReads` compose in TypeScript | **Keep both** (D7) |
| 11 | Bundled-agent `defaultContext` (below); call cannot override | **Keep per-agent** (D8) |

## Milestones (one landable unit per session)

Order rule: M1 before M2 (facades carry `task`/`prequel`); M2 before M6 (agents declare
context before docs describe it). M3.x are independent of each other and of M1–M2 — each
is a safe checkpoint on its own.

### M1 — Facade (≈ 1 session)
- **Files:** `src/extension/schemas.ts`, `src/extension/facade.ts` (new), `src/extension/index.ts`,
  `src/extension/tool-description.ts`, `test/unit/schemas.test.ts`, `test/unit/tool-description.test.ts`,
  `test/unit/index-child-registration.test.ts`, `test/unit/advertised-agent-refresh.test.ts`
  (the last two are tests of the deleted single-tool surface — retarget to the new facades,
  delete obsolete CRUD asserts; discovered during M1)
- Add `SubagentDelegationParams` / `SubagentWorkflowParams` / `SubagentControlParams` —
  **projections derived from the internal full schema**, not hand-copied (no drift).
- New `facade.ts` normalizes facade params → internal `SubagentParams` → `executePublic`.
- Register the three tools (+ `renderCall`/`renderResult` per tool); delete the old
  `subagent` registration. Bridges/extensions untouched.
- Rewrite the three descriptions ≤ 60 words each; guide topics carry depth.
- **Verify:** `npm run test:unit` green; `package-manifest.test.ts` green (exports unchanged);
  rendered bytes measured (target ≈ 1.5–2 kB total).
- **Done-when:** one tool = one mode; invariant test proves no param name appears on two
  facades except the declared cross-cutting set `{async, worktree}` (and asserts the exempt
  set is never larger).

### M2 — Context → agent-owned + `prequel` (≈ 1 session)
- **Files:** `src/shared/fork-context.ts`, `src/extension/config.ts`, `src/shared/types.ts`,
  `src/runs/foreground/subagent-executor.ts` (prequel wiring), `agents/*.md`, `docs/agents.md`
- Rewire `resolveSubagentContext`: read `agent.defaultContext`, fallback `fresh`; delete
  `profile`/implicit-from-call paths; delete `config.defaultSubagentContext` (+ validator).
- Wire `prequel` (D4): consumed for `fork|summary` (prepend to child packet / feed brief),
  ignored for `fresh`. Exact wiring decided during implementation; contract above.
- Add `defaultContext` (+ `contextBrief` where fitting) to bundled agents; rewrite the
  `docs/agents.md` precedence section (163–165) to agent-only.
- **Verify:** `test:unit` + `test:integration`; context-mode tests updated; grep
  `defaultSubagentContext` → zero hits.
- **Done-when:** a call cannot override mode; `prequel` reaches the child for `fork|summary`
  and is absent for `fresh`.

### M3 — Subsystem removals (independent, ≈ 1 session each)
- **3.1 Lanes** — `runs.lanes` DSL (scripted-workflow.ts), `lane` param + `lane.*` actions,
  `merge`/`supersession`/`planId`/`handoffPath`, `skills/pi-subagents/references/multi-lane-orchestration.md`.
  Verify: grep `lane` → zero hits; suite green.
- **3.2 Schedules** — `schedule.*` actions, `at`/`every`/`timezone`/`catchUp`/`overlap`/`on`/`name`,
  `src/runs/background/scheduled-runs.ts` engine.
  Verify: `schedule.*` gone; related tests deleted.
- **3.3 Watchdog** — `watchdog.*` actions, `scope`/`target`/`focus`/`thinking`,
  `src/watchdog/runtime.ts` + watchdog config validators + `docs/watchdog.md`.
  Verify: watchdog references gone (the VISION refusal line stays — unrelated wording).
- **3.4 Missions trim** — `missionUpdate`/`missionStatus`/`missionScope`/`missionId` off the
  surface; keep auto-mission for workflows, `state.get/set`, and `mission.create`.
  Verify: patch metadata gone; `state` tests green.
- **Done-when (each):** removed code/tests/docs + one CHANGELOG line; suite green.

### M4 — Enrichment + param sweep (≈ 1–2 sessions)
- **Files:** `src/extension/config.ts` (new keys + validators), `src/shared/types.ts`, executor,
  `preflight`, TUI files, `docs/configuration.md`; all listed REMOVE params.
- Add config keys for the config-enriched params **before** removing their per-call forms.
- Delete REMOVE params end-to-end (types, executor, preflight, TUI, docs, tests).
- **Verify:** grep removed names → zero hits; suite green; obsolete assertions deleted, not neutered.
- **Done-when:** every param the model can pass is a facade param or an internal contract field;
  every config-enriched param has a validated config key.

### M5 — Small-model polish (≈ 1 session)
- **Files:** `src/extension/tool-description.ts` (live agent list), `src/extension/index.ts` (load-time discovery)
- Inject the actual installed agent-name list into `subagent.description` at load.
- Fixture test: a weak-model-shaped call validates and enriches.
- **Done-when:** the description lists real agent names; fixture passes.

### M6 — Docs, measurement, release (≈ 1 session)
- **Files:** `docs/tool-reference.md` (three tools), `docs/extension-api.md` (internal contract note),
  `docs/configuration.md` (removed keys), CHANGELOG, byte-count regression test.
- Byte-count regression test (< threshold, e.g. 2.5 kB total rendered).
- **Done-when:** docs match the three tools, no dead refs; CHANGELOG captures every removal;
  `test:unit` + `test:integration` green.

> VISION.md has already been updated with the facade principle and new refusals (2026-09) —
> M6's doc work keeps the rest of the repo consistent with it.

## Session protocol (prevents drift and confusion across sessions)

1. **Start:** read `plan.md` + VISION.md; the **current-milestone marker** at the top tells you
   where to start. Nothing else from the plan is in scope this session.
2. **During:** stay inside the milestone's Files / Verify / Done-when. If a milestone grows
   beyond the session, **stop at the last green checkpoint**, split it, and update the plan.
3. **Commit hygiene:** in worktrees that link `node_modules` (validation symlink), commit
   **explicit file lists only — never `git add -A`** (the link gets swept into the branch;
   M2's merge carried it and needed a corrective revert).
4. **End:** suite green; measurement recorded when applicable; plan.md status + current-milestone
   updated; committed. A milestone is never "mostly done" — it is done (done-when met) or not.

## Resolved decisions (owner, 2026-09)

- **D1** Multi-lane orchestration → **remove entirely** (surface + `runs.lanes` DSL + actions + doc). Flag if the script-level `runs.lanes` API was meant to survive.
- **D2** Schedules + watchdog → **remove** (watchdog is a redundant second path over config; reviewer workflow composes; cron/OS covers schedules). **Missions → keep**, trimmed.
- **D3** `toolDescriptionMode` → **remove** the config option; shorten the default description.
- **D4** Per-call context *mode* → **remove** (agent-owned). **Add `prequel` field** (name locked): model-authored context/summary of the chat, separated from `task`; consumed for `fork|summary`, empty with `fresh`.
- **D5** Agent-management CRUD → **remove write** from the model surface; read verbs stay. The model can read the registry and name an agent, but cannot create/edit/disable/delete one.
- **D6** `preflight` param → internal-only; `validate` action stays on the model surface.
- **D7** `reads` → keep per-call (plain list of file paths) + agent `defaultReads` compose.
- **D8** `defaultContext` per agent → **keep**, and the call cannot override it; missing → `fresh`.

## Risks / guardrails

- **Breaking release surface:** one `subagent` tool → three tools is a hard cutover for any
  user/extension that calls the tool by name; internal contracts (`executePublic`, preflight,
  delegation) stay stable so the engine and bridges survive.
- **Behavior change:** params moved to config must have a config key *before* removal,
  else the model silently loses the ability to set them.
- **Small-model regression:** description too terse → model misuses a tool; mitigated by
  live agent list, guide topics, and the `validate` action.
- **Engine untouched until M4** keeps each PR narrow (VISION: scope must earn size).
- **Test churn is a feature:** delete assertions for removed behavior; do not neuter them.

## Resume checklist (next session)

1. Start **M3.2 — Schedules**: `schedule.*` actions, `at`/`every`/`timezone`/`catchUp`/
   `overlap`/`on`/`name`, `src/runs/background/scheduled-runs.ts` engine; delete related tests;
   add one CHANGELOG line. Then 3.3 watchdog, 3.4 missions-trim. Each is an independent, narrow
   PR; keep one writer per worktree; reviewer each before merge. Follow the session protocol.
2. Reuse the M3.1 orchestration lesson: scout map must include the subsystem's OWN test files
   (the lanes scout missed scripted-workflow.test.ts); reviewer verdicts are evidence to verify
   (a tool-less reviewer misread test titles as executable DSL tests — parent re-verification
   caught it, but cheaper to give the reviewer a verified evidence pack).
3. Gate each milestone on `npm run test:unit` (+ `test:integration`; the pre-existing baseline
   failures: watchdog-lsp parallel-load flake family in watchdog-lsp-diagnostics.test.ts —
   both :93 and "malformed language-server JSON" pass isolated — and single-execution.part-2
   parse break — both out of scope).