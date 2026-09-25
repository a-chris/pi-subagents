# Pi Subagents: Execution Controls

This file is a detailed reference loaded from `skills/pi-subagents/SKILL.md`.

## Discovery and Scope Rules

Agent files can live in:

- `~/.pi/agent/agents/**/*.md` — user scope
- `.pi/agents/**/*.md` — canonical project scope
- legacy `.agents/**/*.md` — still read for compatibility, but `.pi/agents/` wins on conflicts

Saved chain files may still be discovered for management and existing durable run state, but they are not a public execution surface. Author new orchestration with `workflowScript`.

Precedence is by parsed runtime name:

1. project scope
2. user scope
3. builtin agents

Project settings resolve from the nearest parent directory containing `.pi` or `.agents` by default. In monorepos or git worktrees where an incidental nested `.pi` directory should not shadow the repository config, set `subagents.projectRootResolution: "git-root"` in the repository root `.pi/settings.json`; a nested project can opt back with `"nearest"` in its own settings.

## Running Subagents

### External CLI profiles

An agent may set `runner.type: external-cli` with a non-empty `command`, optional string `args`, and `promptDelivery: stdin` (the default). The command runs with `shell: false`, inherits the resolved cwd and environment, and receives the combined agent instructions and task through stdin. It must already be installed; pi-subagents adds no CLI dependency.

External CLI profiles are async-only and one-shot. They support lifecycle artifacts, stdout/stderr logs, timeout, and stop. Full stdout and stderr are retained in their log files, while the final stdout response and stderr error kept in memory are each limited to their last 64 KiB. They do not support native Pi child options such as model override, structured output, acceptance/agent contract, tool budgets, fast mode, fork context, skills, or native Pi tools unless the runner explicitly implements them. Foreground/clarify, steer/resume/interrupt-as-pause, nested subagents, and sessions are also unsupported.

### External job profiles

An agent may set `runner.type: external-job` with a non-empty `provider` and optional JSON `options`. When `surf-cli` is installed and loaded, Surf can optionally expose a `gpt-pro` package agent through provider `surf-oracle`. Surf maps `model: pro` to its configured pro web mode. pi-subagents does not own that package agent or model mapping. Remove any old `agentOverrides.gpt-pro.disabled` workaround before using Surf's package agent. The provider must be registered in the host Pi process through `pi-subagents/external-job-provider`; the async runner talks to that parent-owned registry through a local operation bridge.

External job profiles are async-only. The provider owns the remote job and Pi owns the async run record. Status persists provider name, provider job id, prompt digest, provider options, handle/conversation URLs when supplied, result artifact path, last known state, and provider failure code/message. Recovery uses existing provider job metadata to call `reattach` and `result`; it refuses to redispatch a prompt when the persisted provider job does not match the prompt digest.

External job profiles do not support foreground/clarify, steer/resume, Pi models/tools/extensions/skills, tool budgets, structured output, native child permissions, or Pi child sessions. Capacity conflicts fail closed and include the blocking provider job id when the provider supplies it.

### Single agent

```typescript
subagent({
  agent: "oracle",
  task: "Review my current direction and challenge assumptions."
})
```

Use direct single-agent execution for one bounded task when no stable key,
branching, retained-child lookup, or aggregate workflow result is needed. Use a
`workflowScript` when the parent needs JavaScript control flow or data-dependent
branching, or when the run is part of a larger coordinated wave or a later step
must resume it by key.

### Forked context

```typescript
subagent({
  workflowScript: `return runs.run("oracle-check", { agent: "oracle", task: "Review my current direction and challenge assumptions.", context: "fork" })`
})
```

`context: "fork"` creates a branched child session from the current persisted
parent session. It does **not** create a fresh minimal review context or filter
history down to only the relevant parts. Use it when you want a separate review
or execution thread that can still reference the parent session history.

Foreground results, async status, fleet, and widget surfaces label each child with
its resolved launch context as `[fresh]` or `[fork]`. Aggregate headers show
`[mixed]` when a run uses both modes.

### Scripted workflows

`workflowScript` is the public composition surface when the parent needs
JavaScript control flow or data-dependent branching. Use
`runs.run(key, { agent, task, ... })` for keyed children, `runs.all([...])` for
parallel children, and ordinary JavaScript for sequence, filtering, retries,
and aggregation. Scripts are ordinary JavaScript statement bodies, so use an
explicit return such as `return runs.run("main", { agent: "worker", task: "..." })` for a useful one-child result. Use top-level `await`,
plain helper functions, or explicit Promise chains; nested `async function`
helpers, async arrows, and async methods are rejected. Prefer a single scripted
workflow whenever the parent is starting a coordinated wave, such as multiple
reviews, review plus gate monitor, worker then monitor setup, cross-repo prep
steps, or a fanout that the parent will consume together.

```js
subagent({
  workflowScript: `
    const scan = await runs.run("scan", { label: "Map target behavior", agent: "scout", task: "Map the target" });
    const reviews = await runs.all([
      { key: "correctness", label: "Review target correctness", agent: "reviewer", task: "Review correctness: " + scan.output },
      { key: "tests", label: "Review target test coverage", agent: "reviewer", task: "Review tests: " + scan.output }
    ]);
    return reviews.map(result => result.output);
  `
})
```

Scripts run in a timed worker with only `runs.run`, `runs.all`, `runs.status`, `runs.ref/refs`, `emit`, captured `console`, and standard JavaScript. Pass explicit task text to `runs.run`. Mission-attached workflows also get `await state.get(key)` and `await state.set(key, value)` for durable JSON state shared across workflows on the same mission; `mission: false` workflows have no `state` global. Stable keys are required. Child launches follow ordinary single-agent execution controls. Give each child a distinct decision and output path when reports must outlive the workflow, then consume the aggregate workflow result before opening individual reports. Do not ask children to write `reports/...` or other repo-root scratch paths in task text.

If `runs.all` is missing in a running session, reload or update `pi-subagents` before retrying. The current runtime supports `runs.all`; `await Promise.all([runs.run(...)])` is also supported for advanced dynamic fanout.

For one host-run verification command, pass `gate: "npm test"` on a `runs.run`/`runs.all` item (or at the top level as a workflow default). It is shorthand for verified acceptance with that single command: the runtime executes it on the host, records the result as evidence, and memoizes it per tracked workspace state and effective environment. `gate` cannot be combined with `acceptance`; use explicit `acceptance.verify` for multiple commands or custom criteria.

If omitted, acceptance is inferred from role, mode, and risk. Use `level: "checked"` for ordinary writer evidence and `level: "verified"` when the runtime should run explicit validation commands. Independent review is orthogonal: use `review: { required: true, agent: "reviewer" }`; reviewer/read-only calls omit `acceptance`. `review-required` means evidence passed but review is pending; `reviewed` means an independent review found no blockers. Never request `level: "reviewed"`; it is recognized only so preflight can return an actionable correction. Disable gates with `{ level: "none", reason: "..." }`; bare `"none"` is rejected and `false` is only a deprecated shorthand. Child-reported command success is evidence, not runtime verification.

Completed workflow children from this parent session stay addressable as retained children. `subagent({ action: "children.list" })` lists up to the last 10 with run ids and reports each row as `resumable` or `not resumable` with a reason. Resume only rows reported `resumable`. For a retained-child challenge, use `resume` instead of `steer` when the child is complete. If no retained child is resumable, launch a same-role fallback challenge and label it as fallback. A later workflow continues a resumable child with `runs.run(key, { resume: "<run-id>", task: "follow-up" })`. Inside `workflowScript`, awaiting that call waits for the revived child to finish and returns its completed output and new `runId`; top-level `{ action: "resume" }` remains detached. Pass explicit follow-up task text. Assign each returned child result back to the loop variable because every resume can return a new retained `runId`; always resume the latest returned id. `resume` and `agent` are mutually exclusive, the revived child keeps its stored agent/model/tool contract, and `gate` is rejected on retained resume items.

Each workflow key identifies one workflow child: use a new stable workflow key for every distinct retained resume pass; same-key calls are reused only when launch parameters are identical, and incompatible parameters are rejected.

Terminal async workflows also persist `workflow-receipt.json` beside `status.json`. It maps each stable child key to its agent, requested and resolved context when known, latest run id, resumability, output reference, and continuation lineage. A later workflow can resume the latest retained child without copying its run id:

```js
return runs.run("cross-oracle", {
  label: "Challenge proposed direction",
  resume: { workflowRunId: "<pass-1-workflow-id>", key: "advisor-oracle", latest: true },
  task: "Review the focused challenge packet."
});
```

Keyed resume reads that one exact receipt and revalidates the retained run at launch. It fails when the workflow or key is missing, the receipt is stale, `latest` is not `true`, or the recorded child is no longer resumable. The receipt is terminal-only: if `status.json` or `events.jsonl` exists without it, the workflow may still be active or terminal receipt writing may have failed. Use direct child run IDs from status/events for direct resume after the normal retained-child checks; do not reconstruct keyed entries from those files. Foreground workflow results expose the same receipt in `details.workflow.receipt`, but cross-workflow keyed lookup requires the durable receipt from an async workflow.

