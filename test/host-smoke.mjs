// Local smoke test for dsh-task-control host half: exercises apply() load
// (command normalization + projection registration) and the pause/resume/
// cancel command handlers with a fake agent + session.
import { apply } from "/Users/wx/Desktop/DSH/dsh-task-control/lib/index.js";

// --- fake services ----------------------------------------------------------
const registeredCommands = [];
const registeredProjections = [];

const session = {
  events: [],
  seq: 0,
  append(type, data) {
    const event = { type, data, seq: this.seq++, time: Date.now() };
    this.events.push(event);
    return event;
  }
};

const fakeAgent = {
  id: "session-1",
  status: "idle",
  session,
  cancelled: [],
  followups: [],
  cancel(cause, options) { this.cancelled.push({ cause, options }); },
  followup(message) { this.followups.push(message); }
};

const goalsService = {
  goal: { id: "g1", revision: 1, phase: "active" },
  get(agent) { return this.goal; },
  pause(agent, ref) { this.pausedRef = ref; }
};

const provided = {};
const sessionListeners = {};
const ctx = {
  logger: { warn: (...a) => console.log("[warn]", ...a) },
  get(key) {
    if (key === "goals") return goalsService;
    return undefined;
  },
  provide(key, value) { provided[key] = value; },
  on(name, fn) { sessionListeners[name] = fn; },
  agents: { get(id) { return id === fakeAgent.id ? fakeAgent : undefined; } },
  commands: {
    register(definition) {
      // Mirror dsh-commands normalizeDefinition validation.
      if (!/^[a-z][a-z0-9-]*$/.test(definition.name)) throw new TypeError(`command name "${definition.name}" invalid`);
      if (typeof definition.description !== "string" || definition.description.trim().length === 0) throw new TypeError(`command "${definition.name}" description must not be empty`);
      if (typeof definition.handler !== "function") throw new TypeError(`command "${definition.name}" handler must be a function`);
      if (definition.input !== void 0) {
        if (typeof definition.input !== "object" || definition.input === null || !("hint" in definition.input) || typeof definition.input.hint !== "string") throw new TypeError(`command "${definition.name}" input hint must be a string`);
        if (definition.input.hint.trim().length === 0) throw new TypeError(`command "${definition.name}" input hint must not be empty`);
      }
      registeredCommands.push(definition);
    }
  },
  sessionProjections: {
    register(definition) {
      if (!definition.key || typeof definition.init !== "function" || typeof definition.apply !== "function" || typeof definition.view !== "function") throw new TypeError("projection definition invalid");
      registeredProjections.push(definition);
    }
  }
};

// --- load -------------------------------------------------------------------
apply(ctx);
console.log("commands registered:", registeredCommands.map((c) => c.name).join(", "));
console.log("projections registered:", registeredProjections.map((p) => p.key).join(", "));
if (registeredCommands.length !== 3) throw new Error("expected 3 commands");
if (registeredProjections.length !== 1) throw new Error("expected 1 projection");

const handler = (name) => registeredCommands.find((c) => c.name === name).handler;
const invocation = (agent) => ({ agent, rawInput: "", commandId: "t1" });

// --- pause while running -----------------------------------------------------
session.events.push({
  type: "user/message",
  data: { id: "m1", role: "user", content: [{ type: "text", text: "do the thing" }], source: { kind: "user" } },
  seq: 0,
  time: 1
});
fakeAgent.status = "running";
const pausedResult = await handler("pause")(invocation(fakeAgent));
console.log("pause ->", pausedResult);
if (fakeAgent.cancelled.length !== 1 || fakeAgent.cancelled[0].cause.kind !== "user") throw new Error("pause did not cancel agent");
if (!goalsService.pausedRef) throw new Error("pause did not pause goal");
const pausedEvents = session.events.filter((e) => e.type === "task-control/paused");
if (pausedEvents.length !== 1 || pausedEvents[0].data.resumeContent?.[0]?.text !== "do the thing") throw new Error("pause did not record resume content");
fakeAgent.status = "idle";

// --- pause twice -------------------------------------------------------------
const again = await handler("pause")(invocation(fakeAgent));
console.log("pause(again) ->", again);

// --- resume ------------------------------------------------------------------
const resumedResult = await handler("resume")(invocation(fakeAgent));
console.log("resume ->", resumedResult);
if (fakeAgent.followups.length !== 1) throw new Error("resume did not followup");
if (fakeAgent.followups[0].content?.[0]?.text !== "do the thing") throw new Error("resume followup content mismatch");
const resumedEvents = session.events.filter((e) => e.type === "task-control/resumed");
if (resumedEvents.length !== 1) throw new Error("resume did not append resumed event");

// --- resume when nothing paused ----------------------------------------------
const noResume = await handler("resume")(invocation(fakeAgent));
console.log("resume(empty) ->", noResume);

// --- cancel while paused -----------------------------------------------------
fakeAgent.status = "running";
await handler("pause")(invocation(fakeAgent));
fakeAgent.status = "idle";
const cancelResult = await handler("cancel")(invocation(fakeAgent));
console.log("cancel ->", cancelResult);
if (fakeAgent.cancelled.length !== 2) throw new Error("cancel did not run");
const resumedCount = session.events.filter((e) => e.type === "task-control/resumed").length;
if (resumedCount !== 2) throw new Error("cancel did not clear paused state");

// --- projection fold ---------------------------------------------------------
const projection = registeredProjections[0];
let state = projection.init();
for (const event of session.events) state = projection.apply(state, event);
console.log("projection fold ->", JSON.stringify(projection.view(state)));
if (projection.view(state).paused !== false) throw new Error("projection should end unpaused");

// --- taskControl service (per-session programmatic face) ----------------------
const taskControl = provided.taskControl;
if (taskControl === void 0) throw new Error("apply did not provide the taskControl service");
if (typeof taskControl.pause !== "function" || typeof taskControl.resume !== "function" || typeof taskControl.cancel !== "function" || typeof taskControl.state !== "function") {
  throw new Error("taskControl service missing pause/resume/cancel/state methods");
}

// unknown session -> soft error, no throw
const unknown = taskControl.state("session-nope");
console.log("state(unknown) ->", JSON.stringify(unknown));
if (unknown.status !== "offline" || unknown.paused !== false) throw new Error("state(unknown) should report offline");
const unknownPause = taskControl.pause("session-nope");
console.log("pause(unknown) ->", JSON.stringify(unknownPause));
if (unknownPause.ok !== false || typeof unknownPause.error !== "string") throw new Error("pause(unknown) should fail softly");

// pause by session id while running
session.events.push({
  type: "user/message",
  data: { id: "m2", role: "user", content: [{ type: "text", text: "service task" }], source: { kind: "user" } },
  seq: 5,
  time: 6
});
fakeAgent.status = "running";
const svcPause = taskControl.pause(fakeAgent.id);
console.log("service pause ->", JSON.stringify(svcPause));
if (svcPause.ok !== true) throw new Error("service pause failed");
if (fakeAgent.cancelled.length !== 3) throw new Error("service pause did not cancel");
const svcState = taskControl.state(fakeAgent.id);
console.log("service state ->", JSON.stringify(svcState));
if (svcState.paused !== true || svcState.status !== "running") throw new Error("service state should be paused+running");

// resume by session id
fakeAgent.status = "idle";
const svcResume = taskControl.resume(fakeAgent.id);
console.log("service resume ->", JSON.stringify(svcResume));
if (svcResume.ok !== true) throw new Error("service resume failed");
if (fakeAgent.followups.length !== 2) throw new Error("service resume did not followup");
if (fakeAgent.followups[1].content?.[0]?.text !== "service task") throw new Error("service resume content mismatch");

// cancel by session id clears paused marker
fakeAgent.status = "running";
taskControl.pause(fakeAgent.id);
fakeAgent.status = "idle";
const svcCancel = taskControl.cancel(fakeAgent.id);
console.log("service cancel ->", JSON.stringify(svcCancel));
if (svcCancel.ok !== true) throw new Error("service cancel failed");
if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("service cancel should clear paused");

// --- deferred pause: a running tool is NOT interrupted; pause lands at the
// --- safe boundary (tool/result) --------------------------------------------
const fireEvent = (event) => sessionListeners["session/event"]({ id: fakeAgent.id }, event);
fakeAgent.status = "running";
fireEvent({ type: "tool/call", data: { callId: "call-1", name: "bash", arguments: JSON.stringify({ command: "sleep 5 && echo done", description: "等待并输出 done" }) } });
const cancelledBefore = fakeAgent.cancelled.length;
const pausedBefore = session.events.filter((e) => e.type === "task-control/paused").length;
const deferred = taskControl.pause(fakeAgent.id);
console.log("deferred pause ->", JSON.stringify(deferred));
if (!/safe boundary|pausing/.test(deferred.text)) throw new Error("pause should report deferral while a tool runs");
if (fakeAgent.cancelled.length !== cancelledBefore) throw new Error("deferred pause must NOT cancel the running tool");
// the in-flight tool completes -> pause applies (asynchronously via microtask)
fireEvent({ type: "tool/result", data: { message: { source: { callId: "call-1" } } } });
await new Promise((resolve) => setTimeout(resolve, 10));
if (fakeAgent.cancelled.length !== cancelledBefore + 1) throw new Error("safe boundary should cancel the turn");
const pausedAfter = session.events.filter((e) => e.type === "task-control/paused").length;
if (pausedAfter !== pausedBefore + 1) throw new Error("safe boundary should append the paused event");
if (taskControl.state(fakeAgent.id).paused !== true) throw new Error("state should be paused after safe boundary");
console.log("deferred pause applied at safe boundary (tool completed, no interrupt)");

// --- cancel during a running tool: terminate NOW + report purpose + side effects ---
fakeAgent.status = "running";
fireEvent({ type: "tool/call", data: { callId: "call-2", name: "bash", arguments: JSON.stringify({ command: "rm -rf /tmp/x", description: "清理临时目录" }) } });
const cancelledBefore2 = fakeAgent.cancelled.length;
const cancelDuringTool = taskControl.cancel(fakeAgent.id);
console.log("cancel during tool ->", JSON.stringify(cancelDuringTool));
if (fakeAgent.cancelled.length !== cancelledBefore2 + 1) throw new Error("cancel must terminate the running tool immediately");
if (!/清理临时目录/.test(cancelDuringTool.text)) throw new Error("cancel reply should include the tool's expected purpose");
if (!/副作用/.test(cancelDuringTool.text)) throw new Error("cancel reply should remind about side effects");
if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("cancel should clear paused state");

// --- force pause with a running tool: interrupt NOW, remember the tool, resume needs confirm ---
fakeAgent.status = "running";
fireEvent({ type: "tool/call", data: { callId: "call-3", name: "bash", arguments: JSON.stringify({ command: "migrate-db", description: "执行数据库迁移" }) } });
const cancelledBefore3 = fakeAgent.cancelled.length;
const forcedPause = taskControl.pause(fakeAgent.id, { mode: "force" });
console.log("force pause ->", JSON.stringify(forcedPause));
if (fakeAgent.cancelled.length !== cancelledBefore3 + 1) throw new Error("force pause must cancel the running tool immediately");
if (!/迁移/.test(forcedPause.text)) throw new Error("force pause reply should name the interrupted tool's purpose");
const forcedState = taskControl.state(fakeAgent.id);
if (forcedState.paused !== true || forcedState.forced !== true || forcedState.interruptedTool?.name !== "bash") {
  throw new Error(`force pause state wrong: ${JSON.stringify(forcedState)}`);
}
// resume without confirm -> needConfirmation
fakeAgent.status = "idle";
const followupsBefore = fakeAgent.followups.length;
const resumeNoConfirm = taskControl.resume(fakeAgent.id);
console.log("resume(forced, no confirm) ->", JSON.stringify(resumeNoConfirm));
if (resumeNoConfirm.ok !== false || resumeNoConfirm.needConfirmation !== true) throw new Error("forced resume without confirm should need confirmation");
if (fakeAgent.followups.length !== followupsBefore) throw new Error("unconfirmed resume must not followup");
// resume with confirm -> followup includes the re-execute instruction
const resumedEventsBefore = session.events.filter((e) => e.type === "task-control/resumed").length;
const resumeConfirmed = taskControl.resume(fakeAgent.id, { confirm: true });
console.log("resume(forced, confirm) ->", JSON.stringify(resumeConfirmed));
if (resumeConfirmed.ok !== true) throw new Error("confirmed forced resume failed");
if (fakeAgent.followups.length !== followupsBefore + 1) throw new Error("confirmed resume should followup");
const resumeText = (fakeAgent.followups[fakeAgent.followups.length - 1].content ?? []).map((b) => b.text ?? "").join("\n");
if (!/重新执行|迁移/.test(resumeText)) {
  throw new Error("forced resume message should instruct re-execution of the interrupted tool");
}
if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("confirmed resume should clear paused");

// --- safe pause, reasoning granularity 'wait': LLM is NOT interrupted; pause after reasoning completes ---
fakeAgent.status = "running";
const cancelledBefore4 = fakeAgent.cancelled.length;
const pausedBefore4 = session.events.filter((e) => e.type === "task-control/paused").length;
const waitPause = taskControl.pause(fakeAgent.id, { mode: "safe", reason: "wait" });
console.log("safe wait pause ->", JSON.stringify(waitPause));
if (fakeAgent.cancelled.length !== cancelledBefore4) throw new Error("wait-mode pause must NOT cancel the running reasoning");
// reasoning completes -> pause applies
fireEvent({ type: "assistant/message", data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "finished reasoning" }], source: { kind: "model", provider: "p", model: "m" } }, usage: {} } });
await new Promise((resolve) => setTimeout(resolve, 10));
if (fakeAgent.cancelled.length !== cancelledBefore4 + 1) throw new Error("wait-mode pause should cancel after reasoning completes");
if (session.events.filter((e) => e.type === "task-control/paused").length !== pausedBefore4 + 1) throw new Error("wait-mode pause should append paused event after reasoning");
if (taskControl.state(fakeAgent.id).forced !== false) throw new Error("safe pause must not be marked forced");
console.log("safe wait pause applied after reasoning completed (LLM not interrupted)");

console.log("\nALL HOST HALF CHECKS PASSED");

console.log("\nALL HOST HALF CHECKS PASSED");
