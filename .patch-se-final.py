def patch(path, subs):
    s = open(path).read()
    for old, new in subs:
        assert old in s, f"{path}: NOT FOUND: {old[:70]!r}"
        s = s.replace(old, new)
    open(path, "w").write(s)
    print("ok", path)

f = "src/runs/foreground/subagent-executor.ts"
patch(f, [
    # uniform multi-site removals
    ('\t\tcontrolIntercomTarget: intercomBridge.active ? intercomBridge.orchestratorTarget : undefined,\n', ''),
    ('\t\tchildIntercomTarget: intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,\n', ''),
    ('\t\t\tcontrolIntercomTarget: intercomBridge.active ? intercomBridge.orchestratorTarget : undefined,\n', ''),
    ('\t\t\tchildIntercomTarget: intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,\n', ''),
    ('\t\tcontrolIntercomTarget,\n\t\tchildIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(agent, index) : undefined,\n', ''),
    ('\t\tintercomBridge: params.intercomBridge,\n', ''),
    ('\t\tintercomBridge: input.params.intercomBridge ?? recoveryDescriptor?.intercomBridge,\n', ''),
    # child status helper first usage sites -> local function (defined below via another sub)
    ('\t\t\t\tstatus: resolveSubagentResultStatus(omitUndefinedProperties({\n\t\t\t\t\texitCode: result.exitCode,\n\t\t\t\t\tinterrupted: result.interrupted,\n\t\t\t\t\tdetached: result.detached,\n\t\t\t\t\tprocessSignal: result.processSignal,\n\t\t\t\t\ttimedOut: result.timedOut,\n\t\t\t\t\tstopped: result.stopped,\n\t\t\t\t\tturnBudgetExceeded: result.turnBudgetExceeded,\n\t\t\t\t})),',
     '\t\t\t\tstatus: childTerminalStatus(result),'),
    ('\tconst terminalStatus = resolveSubagentResultStatus(omitUndefinedProperties({\n\t\texitCode: input.result.exitCode,\n\t\t...(input.result.acceptance?.status === "rejected" ? { success: false } : {}),\n\t\tinterrupted: input.result.interrupted,\n\t\tdetached: false,\n\t\tprocessSignal: input.result.processSignal,\n\t\ttimedOut: input.result.timedOut,\n\t\tstopped: input.result.stopped,\n\t\tturnBudgetExceeded: input.result.turnBudgetExceeded,\n\t}));',
     '\tconst terminalStatus = childTerminalStatus({ exitCode: input.result.exitCode, acceptanceRejected: input.result.acceptance?.status === "rejected", interrupted: input.result.interrupted, detached: false, processSignal: input.result.processSignal, timedOut: input.result.timedOut, stopped: input.result.stopped, turnBudgetExceeded: input.result.turnBudgetExceeded });'),
    ('\t\t\t\t\tstatus: resolveSubagentResultStatus(omitUndefinedProperties({\n\t\t\t\t\t\texitCode: input.result.exitCode,\n\t\t\t\t\t\tinterrupted: input.result.interrupted,\n\t\t\t\t\t\tdetached: input.result.detached,\n\t\t\t\t\t\tstate: input.result.stopped ? "stopped" : undefined,\n\t\t\t\t\t\tprocessSignal: input.result.processSignal,\n\t\t\t\t\t\ttimedOut: input.result.timedOut,\n\t\t\t\t\t\tstopped: input.result.stopped,\n\t\t\t\t\t\tturnBudgetExceeded: input.result.turnBudgetExceeded,\n\t\t\t\t\t})),',
     '\t\t\t\t\tstatus: childTerminalStatus(input.result),'),
    # updateRememberedForegroundChild events type
    ('\tevents: IntercomEventBus;', '\tevents: { emit(channel: string, data: unknown): void };'),
    # resumeExternalJobFollowUp signature
    ('\tintercomBridge: IntercomBridgeState;\n\tparentSessionFile: string | null;\n\tabsoluteDeadlineAt?: number;\n}): Promise<AgentToolResult<Details>> {',
     '\tparentSessionFile: string | null;\n\tabsoluteDeadlineAt?: number;\n}): Promise<AgentToolResult<Details>> {'),
    ('\t\t\tintercomBridge,\n\t\t\tparentSessionFile,', '\t\t\tparentSessionFile,'),
    # resumeAsyncRun: sessionName/intercomBridge/agents
    ('''\tconst sessionName = resolveIntercomSessionTarget(input.deps.pi.getSessionName(), input.ctx.sessionManager.getSessionId());
\tconst recoveryDescriptor = "recoveryDescriptor" in target ? target.recoveryDescriptor : undefined;
\tconst recoveryContext = recoveryDescriptor?.context ?? (input.params.context === "profile" ? undefined : input.params.context);
\tconst intercomBridge = resolveIntercomBridge({
\t\tconfig: input.deps.config.intercomBridge,
\t\toverride: input.params.intercomBridge ?? recoveryDescriptor?.intercomBridge,
\t\tcontext: recoveryContext,
\t\torchestratorTarget: sessionName,
\t});
\tconst agents = intercomBridge.active
\t\t? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
\t\t: discoveredAgents;''',
     '''\tconst recoveryDescriptor = "recoveryDescriptor" in target ? target.recoveryDescriptor : undefined;
\tconst recoveryContext = recoveryDescriptor?.context ?? (input.params.context === "profile" ? undefined : input.params.context);
\tconst agents = discoveredAgents;'''),
    ('\tconst agentConfig = intercomBridge.active ? applyIntercomBridgeToAgent(recoveryAgentConfig, intercomBridge) : recoveryAgentConfig;',
     '\tconst agentConfig = recoveryAgentConfig;'),
    ('\tconst revivedTarget = intercomBridge.active ? resolveSubagentIntercomTarget(revivedId, target.agent, 0) : undefined;\n', ''),
    ('\t\trevivedTarget ? `Intercom target: ${revivedTarget} (if registered)` : undefined,\n', ''),
    # runAsyncPath main path: sessionName/intercomBridge/agents
    ('''\t\tconst sessionName = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
\t\tconst intercomBridge = resolveIntercomBridge({
\t\t\tconfig: deps.config.intercomBridge,
\t\t\toverride: effectiveParams.intercomBridge,
\t\t\tcontext: effectiveParams.context === "fresh" || effectiveParams.context === "fork"
\t\t\t\t? effectiveParams.context
\t\t\t\t: contextPolicy.usesFork ? "fork" : undefined,
\t\t\torchestratorTarget: sessionName,
\t\t});
\t\tconst agents = applyScopedIntercomBridgeToAgents(discoveredAgents, intercomBridge, contextPolicy);''',
     '''\t\tconst agents = discoveredAgents;'''),
    # executor execData intercomBridge
    ('\t\t\t...(delegatedExecution ? { suppressUnchangedDelegationUpdates: true } : {}),\n\t\t\tintercomBridge,\n\t\t\tnestedRoute,', '\t\t\t...(delegatedExecution ? { suppressUnchangedDelegationUpdates: true } : {}),\n\t\t\tnestedRoute,'),
    # runAsyncPath destructure + controlIntercomTarget/childIntercomTarget vars
    ('\t\tcontrolConfig,\n\t\tintercomBridge,\n\t\tnestedRoute,\n\t\tcontextPolicy,', '\t\tcontrolConfig,\n\t\tnestedRoute,\n\t\tcontextPolicy,'),
    ('\tconst controlIntercomTarget = resolveRunLevelIntercomTarget(intercomBridge, contextPolicy);\n\tconst childIntercomTarget = resolveChildIntercomTargetFactory(intercomBridge, contextPolicy, id);\n\n', ''),
    # runSinglePath bridge bits
    ('\tconst childBridgeActive = intercomBridgeAppliesToAgent(data.intercomBridge, contextPolicy, params.agent!);\n\tconst childIntercomTarget = childBridgeActive ? resolveSubagentIntercomTarget(runId, params.agent!, 0) : undefined;\n', ''),
    ('\t\t\tallowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,\n\t\t\tintercomEvents: deps.pi.events,\n', ''),
    ('\t\t\tintercomSessionName: childIntercomTarget,\n\t\t\torchestratorIntercomTarget: childBridgeActive ? data.intercomBridge.orchestratorTarget : undefined,\n', ''),
    # suppressRoutine + intercom receipt block in runSinglePath
    ('''\tconst suppressRoutineResultIntercom = shouldSuppressRoutineResultIntercom({ suppressRoutineResultIntercom: params.suppressRoutineResultIntercom, results: [r] });
\tif (!r.detached && !r.interrupted && !suppressRoutineResultIntercom) {
\t\tif (foregroundControl) updateForegroundNestedProjection(foregroundControl);
\t\tconst intercomReceipt = await maybeBuildForegroundIntercomReceipt({
\t\t\tpi: deps.pi,
\t\t\tintercomBridge: data.intercomBridge,
\t\t\trunId,
\t\t\tmode: "single",
\t\t\tdetails,
\t\t\t...(params.workflowParentRunId !== undefined ? { preserveDetailsOutputs: true } : {}),
\t\t\t...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
\t\t});
\t\tif (intercomReceipt) {
\t\t\treturn {
\t\t\t\tcontent: [{ type: "text", text: intercomReceipt.text }],
\t\t\t\tdetails: intercomReceipt.details,
\t\t\t\t...(r.exitCode !== 0 ? { isError: true } : {}),
\t\t\t};
\t\t}
\t}

''', ''),
    # result-intercom usage in worktree handoff summary
    ('\t\t\t\t\t\tsummary: resultSummaryForIntercom(input.result),', '\t\t\t\t\t\tsummary: input.result.error ? `${input.result.error}${getSingleResultOutput(input.result).trim() ? `\\n\\nOutput:\\n${getSingleResultOutput(input.result).trim()}` : ""}` : getSingleResultOutput(input.result).trim() || "(no output)",'),
    # persistAsyncWorkflowControlEvent simplification
    ('''\tcontrolConfig: ResolvedControlConfig;
\tintercomBridge: IntercomBridgeState;
\tchildIntercomTarget?: string;
}): void {
\tconst channels = input.event.type === "active_long_running"
\t\t? input.controlConfig.notifyChannels.filter((channel) => channel !== "intercom")
\t\t: input.controlConfig.notifyChannels;
\tif (channels.length === 0) return;
\tconst record = {
\t\tts: Date.now(),
\t\trunId: input.job.asyncId,
\t\ttype: "subagent.control",
\t\tevent: input.event,
\t\tchannels,
\t\tchildIntercomTarget: input.childIntercomTarget,
\t\tnoticeText: formatControlNoticeMessage(input.event, input.childIntercomTarget),
\t\t...(input.intercomBridge.active && input.intercomBridge.orchestratorTarget && channels.includes("intercom")
\t\t\t? {
\t\t\t\tintercom: {
\t\t\t\t\tto: input.intercomBridge.orchestratorTarget,
\t\t\t\t\tmessage: formatControlIntercomMessage(input.event, input.childIntercomTarget),
\t\t\t\t},
\t\t\t}
\t\t\t: {}),
\t};''',
     '''\tcontrolConfig: ResolvedControlConfig;
}): void {
\tconst channels = input.controlConfig.notifyChannels;
\tif (channels.length === 0) return;
\tconst record = {
\t\tts: Date.now(),
\t\trunId: input.job.asyncId,
\t\ttype: "subagent.control",
\t\tevent: input.event,
\t\tchannels,
\t\tnoticeText: formatControlNoticeMessage(input.event),
\t};'''),
    # emitControlNotification simplification
    ('''\tcontrolConfig: ResolvedControlConfig;
\tintercomBridge: IntercomBridgeState;
\tevent: ControlEvent;
\tsource?: "foreground" | "async";
}): void {
\tif (!shouldNotifyControlEvent(input.controlConfig, input.event)) return;
\tconst childIntercomTarget = input.intercomBridge.active
\t\t? resolveSubagentIntercomTarget(input.event.runId, input.event.agent, input.event.index)
\t\t: undefined;
\tconst payload = {
\t\tevent: input.event,
\t\tsource: input.source ?? "foreground",
\t\tchildIntercomTarget,
\t\tnoticeText: formatControlNoticeMessage(input.event, childIntercomTarget),
\t};
\tif (input.controlConfig.notifyChannels.includes("event")) {
\t\temitAdvisoryControlEvent(input.pi, SUBAGENT_CONTROL_EVENT, payload);
\t}
\tif (input.event.type !== "active_long_running" && input.controlConfig.notifyChannels.includes("intercom") && input.intercomBridge.active && input.intercomBridge.orchestratorTarget) {
\t\temitAdvisoryControlEvent(input.pi, SUBAGENT_CONTROL_INTERCOM_EVENT, {
\t\t\t...payload,
\t\t\tto: input.intercomBridge.orchestratorTarget,
\t\t\tmessage: formatControlIntercomMessage(input.event, childIntercomTarget),
\t\t});
\t}
}''',
     '''\tcontrolConfig: ResolvedControlConfig;
\tevent: ControlEvent;
\tsource?: "foreground" | "async";
}): void {
\tif (!shouldNotifyControlEvent(input.controlConfig, input.event)) return;
\tconst payload = {
\t\tevent: input.event,
\t\tsource: input.source ?? "foreground",
\t\tnoticeText: formatControlNoticeMessage(input.event),
\t};
\tif (input.controlConfig.notifyChannels.includes("event")) {
\t\temitAdvisoryControlEvent(input.pi, SUBAGENT_CONTROL_EVENT, payload);
\t}
}'''),
    # createForegroundControlNotifier
    ('function createForegroundControlNotifier(data: Pick<ExecutionContextData, "controlConfig" | "contextPolicy" | "intercomBridge" | "params">, deps: Pick<ExecutorDeps, "pi" | "state">): (event: ControlEvent) => void {\n\treturn (event) => {\n\t\tapplyControlEventToRememberedForegroundRun(deps.state, event);\n\t\tconst eventBridge = intercomBridgeAppliesToAgent(data.intercomBridge, data.contextPolicy, event.agent)\n\t\t\t? data.intercomBridge\n\t\t\t: { ...data.intercomBridge, active: false };\n',
     'function createForegroundControlNotifier(data: Pick<ExecutionContextData, "controlConfig" | "params">, deps: Pick<ExecutorDeps, "pi" | "state">): (event: ControlEvent) => void {\n\treturn (event) => {\n\t\tapplyControlEventToRememberedForegroundRun(deps.state, event);\n'),
    ('''\t\tif (asyncWorkflow) {
\t\t\tpersistAsyncWorkflowControlEvent({
\t\t\t\tjob: asyncWorkflow,
\t\t\t\tevent: enriched,
\t\t\t\tcontrolConfig: data.controlConfig,
\t\t\t\tintercomBridge: eventBridge,
\t\t\t\tchildIntercomTarget: eventBridge.active
\t\t\t\t\t? resolveSubagentIntercomTarget(enriched.runId, enriched.agent, enriched.index)
\t\t\t\t\t: undefined,
\t\t\t});
\t\t}
\t\temitControlNotification({
\t\t\tpi: deps.pi,
\t\t\tcontrolConfig: data.controlConfig,
\t\t\tintercomBridge: eventBridge,
\t\t\tevent: enriched,
\t\t\tsource: asyncWorkflow ? "async" : "foreground",
\t\t});''',
     '''\t\tif (asyncWorkflow) {
\t\t\tpersistAsyncWorkflowControlEvent({ job: asyncWorkflow, event: enriched, controlConfig: data.controlConfig });
\t\t}
\t\temitControlNotification({ pi: deps.pi, controlConfig: data.controlConfig, event: enriched, source: asyncWorkflow ? "async" : "foreground" });'''),
    # doctor orchestratorTarget
    ('''\t\t\t\tlet orchestratorTarget: string | undefined;
\t\t\t\ttry {
\t\t\t\t\torchestratorTarget = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
\t\t\t\t} catch (error) {
\t\t\t\t\tif (!sessionError) sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
\t\t\t\t}
''', ''),
    ('\t\t\t\t\t\t\torchestratorTarget,\n', ''),
    # nested event ownerIntercomTarget fields
    ('\t\t\t\t\t\townerIntercomTarget: deps.childRuntime?.intercomSessionName,\n\t\t\t\t\t\tleafIntercomTarget,\n\t\t\t\t\t\tintercomTarget: leafIntercomTarget,\n', ''),
    # getCurrentSupervisorOwnerStates removal
    ('''\t/** Scheduled state visible to the current runtime supervisor owner only. */
\tgetCurrentSupervisorOwnerStates: () => Iterable<SubagentState>;
''', ''),
    ('''\tfunction* getCurrentSupervisorOwnerStates(): Iterable<SubagentState> {
\t\tconst ownerId = deps.state.supervisorOwnerSessionId;
\t\tif (!ownerId) return;
\t\t// File transitions remain separate entries; other runtime owners are never scanned.
\t\tfor (const owner of scheduledOwnerExecutors.get(ownerId)?.values() ?? []) yield owner.state;
\t}

''', ''),
    ('\treturn { execute: executeWithSingleDispatchGuard, executePublic, executeDelegated, executeScheduled, getCurrentSupervisorOwnerStates };',
     '\treturn { execute: executeWithSingleDispatchGuard, executePublic, executeDelegated, executeScheduled };'),
])
