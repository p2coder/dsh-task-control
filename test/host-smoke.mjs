// Local smoke test for dsh-task-control host half: exercises apply() load
// (command normalization) and the pause/resume/cancel command handlers with
// a fake agent + session. Pause state now lives in the plugin's own durable
// store (Route A: no custom session event types), so assertions read the
// taskControl service state instead of session events.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

// Isolate the durable state store in a temp dir (hermetic, no ~/.dsh writes).
process.env.DSH_TASK_CONTROL_STATE_DIR = mkdtempSync(join(tmpdir(), "dsh-task-control-test-"));
const stateRoot = process.env.DSH_TASK_CONTROL_STATE_DIR;

// Seed the pause-granularity settings with `force` so the bare `/pause`
// assertions below keep exercising force behavior (the shipped default is
// `safe` + `wait`; a later test section switches the settings to verify it).
const settingsFile = join(stateRoot, "settings.json");
writeFileSync(settingsFile, JSON.stringify({ defaultMode: "force", safeReasoning: "wait" }), "utf8");

// --- fake services ----------------------------------------------------------
const registeredCommands = [];

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
// Fake host webserver mirroring dsh-host-webserver's contract: register()
// throws on duplicate (kind, path) and returns a disposer removing the route.
const webServerRoutes = new Map();
const fakeWebServer = {
  register(route) {
    if (webServerRoutes.has(route.path)) throw new Error(`webserver: duplicate prefix route "${route.path}"`);
    webServerRoutes.set(route.path, route);
    return () => { webServerRoutes.delete(route.path); };
  }
};
// Collect disposers wired through ctx.effect (mirrors Cordis effect semantics).
const effectDisposers = [];
const ctx = {
  logger: { warn: (...a) => console.log("[warn]", ...a) },
  get(key) {
    if (key === "goals") return goalsService;
    return undefined;
  },
  provide(key, value) { provided[key] = value; },
  on(name, fn) { sessionListeners[name] = fn; },
  agents: { get(id) { return id === fakeAgent.id ? fakeAgent : undefined; } },
  webServer: fakeWebServer,
  effect(callback) {
    const disposer = callback();
    if (typeof disposer === "function") effectDisposers.push(disposer);
    return disposer;
  },
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
  }
};

try {
  // --- load -------------------------------------------------------------------
  apply(ctx);
  console.log("commands registered:", registeredCommands.map((c) => c.name).join(", "));
  if (registeredCommands.length !== 3) throw new Error("expected 3 commands");
  const taskControl = provided.taskControl;
  if (taskControl === void 0) throw new Error("apply did not provide the taskControl service");
  if (typeof taskControl.pause !== "function" || typeof taskControl.resume !== "function" || typeof taskControl.cancel !== "function" || typeof taskControl.state !== "function") {
    throw new Error("taskControl service missing pause/resume/cancel/state methods");
  }

  // --- webServer route lifecycle (hot unload must not leak the route) ---------
  // The /task-control prefix must be registered AND its disposer wired through
  // ctx.effect: without the effect wrap, a hot unload (plugin-toggle) would
  // leave the route in the shared host webserver and the next re-apply would
  // throw "webserver: duplicate prefix route".
  if (!webServerRoutes.has("/task-control")) throw new Error("webServer route /task-control not registered");
  if (effectDisposers.length !== 1) throw new Error(`webServer route disposer must be wired via ctx.effect, got ${effectDisposers.length}`);
  effectDisposers[0]();
  if (webServerRoutes.has("/task-control")) throw new Error("route must be removed when the effect disposer runs (hot unload)");
  console.log("webServer route lifecycle -> registered, effect-disposed, removed OK");

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
  let st = taskControl.state(fakeAgent.id);
  if (st.paused !== true || st.resumeContent?.[0]?.text !== "do the thing") throw new Error("pause did not persist paused state");
  if (st.forced !== true) throw new Error("default pause must be force mode (interrupts everything)");
  fakeAgent.status = "idle";

  // --- pause twice -------------------------------------------------------------
  const again = await handler("pause")(invocation(fakeAgent));
  console.log("pause(again) ->", again);
  if (again.kind !== "success" || !/already paused/.test(again.text)) throw new Error("double pause should report already paused");

  // --- resume ------------------------------------------------------------------
  const resumedResult = await handler("resume")(invocation(fakeAgent));
  console.log("resume ->", resumedResult);
  if (fakeAgent.followups.length !== 1) throw new Error("resume did not followup");
  if (!/继续执行任务/.test(fakeAgent.followups[0].content?.[0]?.text ?? "")) throw new Error("resume should continue from the pause point, not re-run the prompt");
  if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("resume did not clear paused state");

  // --- resume when nothing paused ----------------------------------------------
  const noResume = await handler("resume")(invocation(fakeAgent));
  console.log("resume(empty) ->", noResume);
  if (noResume.kind !== "success" || !/no paused task/.test(noResume.text)) throw new Error("resume with nothing paused should say so");

  // --- cancel while paused -----------------------------------------------------
  fakeAgent.status = "running";
  await handler("pause")(invocation(fakeAgent));
  fakeAgent.status = "idle";
  const cancelResult = await handler("cancel")(invocation(fakeAgent));
  console.log("cancel ->", cancelResult);
  if (fakeAgent.cancelled.length !== 2) throw new Error("cancel did not run");
  if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("cancel did not clear paused state");

  // --- Route A invariant: no custom session event types written ---------------
  const custom = session.events.filter((e) => e.type === "task-control/paused" || e.type === "task-control/resumed");
  if (custom.length > 0) throw new Error("task-control must NOT write custom session event types (sessions would become unloadable)");
  console.log("Route A: no task-control/* session events written");

  // --- taskControl service (per-session programmatic face) ----------------------
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
  if (!/继续/.test(fakeAgent.followups[1].content?.[0]?.text ?? "")) throw new Error("service resume should continue, not re-send the prompt");

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
  const deferred = taskControl.pause(fakeAgent.id, { mode: "safe" });
  console.log("deferred pause ->", JSON.stringify(deferred));
  if (!/safe boundary|pausing/.test(deferred.text)) throw new Error("pause should report deferral while a tool runs");
  if (fakeAgent.cancelled.length !== cancelledBefore) throw new Error("deferred pause must NOT cancel the running tool");
  if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("deferred pause must not be persisted yet");
  // the in-flight tool completes -> pause applies (asynchronously via microtask)
  fireEvent({ type: "tool/result", data: { message: { source: { callId: "call-1" } } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (fakeAgent.cancelled.length !== cancelledBefore + 1) throw new Error("safe boundary should cancel the turn");
  if (taskControl.state(fakeAgent.id).paused !== true) throw new Error("safe boundary should persist paused state");
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
  const waitPause = taskControl.pause(fakeAgent.id, { mode: "safe", reason: "wait" });
  console.log("safe wait pause ->", JSON.stringify(waitPause));
  if (fakeAgent.cancelled.length !== cancelledBefore4) throw new Error("wait-mode pause must NOT cancel the running reasoning");
  if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("wait-mode pause must not be persisted yet");
  // reasoning completes -> pause applies
  fireEvent({ type: "assistant/message", data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "finished reasoning" }], source: { kind: "model", provider: "p", model: "m" } }, usage: {} } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (fakeAgent.cancelled.length !== cancelledBefore4 + 1) throw new Error("wait-mode pause should cancel after reasoning completes");
  if (taskControl.state(fakeAgent.id).paused !== true) throw new Error("wait-mode pause should persist paused state after reasoning");
  if (taskControl.state(fakeAgent.id).forced !== false) throw new Error("safe pause must not be marked forced");
  console.log("safe wait pause applied after reasoning completed (LLM not interrupted)");

  // --- safe pause then resume while the task is STILL actually running: ---
  // --- just clear the marker, no followup, results keep flowing -------------
  // (state after the wait-mode pause above: paused=true, agent still "running")
  const followupsBeforeRunning = fakeAgent.followups.length;
  const runningResume = taskControl.resume(fakeAgent.id);
  console.log("resume(safe, still running) ->", JSON.stringify(runningResume));
  if (runningResume.ok !== true) throw new Error("running-resume failed");
  if (fakeAgent.followups.length !== followupsBeforeRunning) throw new Error("running-resume must not followup (task already executing)");
  if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("running-resume should clear the paused marker");

  // --- force pause while a tool runs, but the tool DRAINED to completion: ---
  // --- resume must NOT re-run it, just continue with the recorded result -----
  fakeAgent.status = "running";
  fireEvent({ type: "tool/call", data: { callId: "call-4", name: "bash", arguments: JSON.stringify({ command: "touch /tmp/x", description: "创建文件" }) } });
  taskControl.pause(fakeAgent.id, { mode: "force" });
  // the kernel drains started calls: the result lands AFTER the paused event
  session.append("tool/result", { message: { source: { callId: "call-4" }, content: [{ type: "tool-result", toolCallId: "call-4", content: [{ type: "text", text: "ok" }], isError: false }] } });
  fakeAgent.status = "idle";
  const followupsBeforeCompleted = fakeAgent.followups.length;
  const resumeCompletedTool = taskControl.resume(fakeAgent.id, { confirm: true });
  console.log("resume(forced, tool completed) ->", JSON.stringify(resumeCompletedTool));
  if (resumeCompletedTool.ok !== true) throw new Error("completed-tool resume failed");
  if (fakeAgent.followups.length !== followupsBeforeCompleted + 1) throw new Error("completed-tool resume should followup");
  const completedText = (fakeAgent.followups[fakeAgent.followups.length - 1].content ?? []).map((b) => b.text ?? "").join("\n");
  if (!/已执行完成/.test(completedText)) throw new Error("completed-tool resume should report the tool actually completed");
  if (/重新执行该工具/.test(completedText)) throw new Error("completed-tool resume must not instruct re-execution");

  // --- force pause with an unfinished tool + user choice `skip`: ------------
  // --- resume continues without re-running the tool --------------------------
  fakeAgent.status = "running";
  fireEvent({ type: "tool/call", data: { callId: "call-5", name: "bash", arguments: JSON.stringify({ command: "migrate-db-2", description: "执行数据库迁移（第二次）" }) } });
  taskControl.pause(fakeAgent.id, { mode: "force" });
  fakeAgent.status = "idle";
  const followupsBeforeSkip = fakeAgent.followups.length;
  const resumeSkip = taskControl.resume(fakeAgent.id, { confirm: true, choice: "skip" });
  console.log("resume(forced, skip) ->", JSON.stringify(resumeSkip));
  if (resumeSkip.ok !== true) throw new Error("skip resume failed");
  if (fakeAgent.followups.length !== followupsBeforeSkip + 1) throw new Error("skip resume should followup");
  const skipText = (fakeAgent.followups[fakeAgent.followups.length - 1].content ?? []).map((b) => b.text ?? "").join("\n");
  if (!/跳过该工具/.test(skipText)) throw new Error("skip resume should instruct skipping the interrupted tool");
  if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("skip resume should clear paused");

  // --- safe wait pause whose finished reasoning emitted tool calls: ----------
  // --- the pause lands BEFORE their dispatch; they are recorded as -----------
  // --- deferredTools (never dispatched, no side effects); resume asks --------
  // --- re-run (default) / skip; actually-completed tools are never re-run -----
  fakeAgent.status = "running";
  const cancelledBefore5 = fakeAgent.cancelled.length;
  const deferredPause = taskControl.pause(fakeAgent.id, { mode: "safe", reason: "wait" });
  if (fakeAgent.cancelled.length !== cancelledBefore5) throw new Error("wait-mode pause must NOT cancel running reasoning");
  // reasoning completes and emits a tool call -> the pause microtask then lands
  fireEvent({ type: "assistant/message", data: { turn: 2, step: 1, message: { role: "assistant", content: [
    { type: "tool-call", id: "call-6", name: "bash", arguments: JSON.stringify({ command: "sleep 15 && echo tool-safe-done", description: "工具中暂停验证" }) }
  ], source: { kind: "model", provider: "p", model: "m" } }, usage: {} } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (fakeAgent.cancelled.length !== cancelledBefore5 + 1) throw new Error("wait-mode pause should cancel after reasoning completes");
  const deferredState = taskControl.state(fakeAgent.id);
  console.log("deferred-tools pause state ->", JSON.stringify(deferredState));
  if (deferredState.paused !== true || deferredState.forced !== false) throw new Error("deferred pause should be a safe pause");
  if (!Array.isArray(deferredState.deferredTools) || deferredState.deferredTools.length !== 1 || deferredState.deferredTools[0].callId !== "call-6" || deferredState.deferredTools[0].name !== "bash") {
    throw new Error(`deferred tools not recorded: ${JSON.stringify(deferredState.deferredTools)}`);
  }
  // the kernel writes the aborted-before-dispatch result into the log
  session.append("tool/result", { message: { source: { callId: "call-6" }, content: [{ type: "tool-result", toolCallId: "call-6", content: [{ type: "text", text: "Error: tool call aborted before dispatch" }], isError: true }] }, error: { code: "ABORTED_BEFORE_DISPATCH", name: "AbortError" } });
  fakeAgent.status = "idle";
  // resume without confirm -> needConfirmation
  const followupsBeforeDeferred = fakeAgent.followups.length;
  const deferredNoConfirm = taskControl.resume(fakeAgent.id);
  console.log("resume(deferred, no confirm) ->", JSON.stringify(deferredNoConfirm));
  if (deferredNoConfirm.ok !== false || deferredNoConfirm.needConfirmation !== true) throw new Error("deferred resume without confirm should need confirmation");
  if (fakeAgent.followups.length !== followupsBeforeDeferred) throw new Error("unconfirmed deferred resume must not followup");
  // resume with confirm -> instruct re-execution
  const deferredRerun = taskControl.resume(fakeAgent.id, { confirm: true });
  console.log("resume(deferred, confirm) ->", JSON.stringify(deferredRerun));
  if (deferredRerun.ok !== true) throw new Error("confirmed deferred resume failed");
  if (fakeAgent.followups.length !== followupsBeforeDeferred + 1) throw new Error("confirmed deferred resume should followup");
  const deferredText = (fakeAgent.followups[fakeAgent.followups.length - 1].content ?? []).map((b) => b.text ?? "").join("\n");
  if (!/未及执行/.test(deferredText) || !/执行这些工具/.test(deferredText)) throw new Error("deferred rerun message should instruct re-execution");
  if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("deferred rerun should clear paused");

  // deferred + user choice `skip`: continue without re-running
  fakeAgent.status = "running";
  taskControl.pause(fakeAgent.id, { mode: "safe", reason: "wait" });
  fireEvent({ type: "assistant/message", data: { turn: 3, step: 1, message: { role: "assistant", content: [
    { type: "tool-call", id: "call-7", name: "bash", arguments: JSON.stringify({ command: "echo hi", description: "跳过验证" }) }
  ], source: { kind: "model", provider: "p", model: "m" } }, usage: {} } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  fakeAgent.status = "idle";
  const followupsBeforeDeferredSkip = fakeAgent.followups.length;
  const deferredSkip = taskControl.resume(fakeAgent.id, { confirm: true, choice: "skip" });
  console.log("resume(deferred, skip) ->", JSON.stringify(deferredSkip));
  if (deferredSkip.ok !== true) throw new Error("deferred skip resume failed");
  const deferredSkipText = (fakeAgent.followups[fakeAgent.followups.length - 1].content ?? []).map((b) => b.text ?? "").join("\n");
  if (!/跳过/.test(deferredSkipText)) throw new Error("deferred skip message should instruct skipping");
  if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("deferred skip should clear paused");

  // deferred tool that actually DRAINED to completion: never re-run
  fakeAgent.status = "running";
  taskControl.pause(fakeAgent.id, { mode: "safe", reason: "wait" });
  fireEvent({ type: "assistant/message", data: { turn: 4, step: 1, message: { role: "assistant", content: [
    { type: "tool-call", id: "call-8", name: "bash", arguments: JSON.stringify({ command: "touch /tmp/y", description: "创建文件" }) }
  ], source: { kind: "model", provider: "p", model: "m" } }, usage: {} } });
  // the tool actually dispatched and drained BEFORE the pause microtask landed
  session.append("tool/result", { message: { source: { callId: "call-8" }, content: [{ type: "tool-result", toolCallId: "call-8", content: [{ type: "text", text: "ok" }], isError: false }] } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  fakeAgent.status = "idle";
  const followupsBeforeDeferredDone = fakeAgent.followups.length;
  const deferredDone = taskControl.resume(fakeAgent.id, { confirm: true });
  console.log("resume(deferred, actually completed) ->", JSON.stringify(deferredDone));
  if (deferredDone.ok !== true) throw new Error("deferred-completed resume failed");
  const deferredDoneText = (fakeAgent.followups[fakeAgent.followups.length - 1].content ?? []).map((b) => b.text ?? "").join("\n");
  if (!/均已实际执行完成/.test(deferredDoneText)) throw new Error("deferred-completed resume should report all tools completed");
  if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("deferred-completed resume should clear paused");

  // --- durable store: state survives an offline "restart" ----------------------
  // A session paused while running, then no longer live, still reports paused
  // (the dock polls this after restart to show the paused state).
  fakeAgent.status = "running";
  taskControl.pause(fakeAgent.id);
  // simulate a restart: drop the in-memory cache, agent gone
  ctx.agents.get = () => undefined;
  const afterRestart = taskControl.state(fakeAgent.id);
  console.log("state(after restart) ->", JSON.stringify(afterRestart));
  if (afterRestart.paused !== true || afterRestart.status !== "offline") throw new Error("paused state should survive restart via the durable store");
  // resume through a live agent again (restore fake)
  ctx.agents.get = (id) => (id === fakeAgent.id ? fakeAgent : undefined);
  fakeAgent.status = "idle";
  taskControl.resume(fakeAgent.id);
  if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("resume should clear the durable state");

  // --- pause-granularity settings: bare /pause follows the settings -----------
  // Switch the durable settings to the shipped default (`safe` + `wait`): a
  // bare /pause must NOT interrupt anything, land at the safe boundary after
  // reasoning completes, and resume needs no confirmation (no forced tool).
  writeFileSync(settingsFile, JSON.stringify({ defaultMode: "safe", safeReasoning: "wait" }), "utf8");
  fakeAgent.status = "running";
  const cancelledBeforeSafeDefault = fakeAgent.cancelled.length;
  const defaultSafePause = await handler("pause")(invocation(fakeAgent));
  console.log("pause(default settings=safe wait) ->", JSON.stringify(defaultSafePause));
  if (fakeAgent.cancelled.length !== cancelledBeforeSafeDefault) throw new Error("safe-wait default must NOT cancel the running turn immediately");
  if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("safe-wait default must not persist yet");
  // reasoning completes -> pause applies at the boundary, marked non-forced
  fireEvent({ type: "assistant/message", data: { turn: 9, step: 1, message: { role: "assistant", content: [{ type: "text", text: "reasoned while pausing" }], source: { kind: "model", provider: "p", model: "m" } }, usage: {} } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const safeDefaultState = taskControl.state(fakeAgent.id);
  if (safeDefaultState.paused !== true) throw new Error("safe-wait default should persist after reasoning completes");
  if (safeDefaultState.forced !== false) throw new Error("safe-wait default must not be forced");
  fakeAgent.status = "idle";
  await handler("resume")(invocation(fakeAgent));
  if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("resume should clear after a safe-wait default pause");

  // explicit `/pause force` still overrides the safe default
  fakeAgent.status = "running";
  fireEvent({ type: "tool/call", data: { callId: "call-9", name: "bash", arguments: JSON.stringify({ command: "echo explicit", description: "显式强制暂停验证" }) } });
  const cancelledBeforeExplicit = fakeAgent.cancelled.length;
  const explicitForce = await handler("pause")({ ...invocation(fakeAgent), rawInput: "force" });
  console.log("pause(explicit force over safe default) ->", JSON.stringify(explicitForce));
  if (fakeAgent.cancelled.length !== cancelledBeforeExplicit + 1) throw new Error("explicit /pause force must interrupt even with a safe default");
  const explicitState = taskControl.state(fakeAgent.id);
  if (explicitState.paused !== true || explicitState.forced !== true || explicitState.interruptedTool?.callId !== "call-9") {
    throw new Error(`explicit force pause state wrong: ${JSON.stringify(explicitState)}`);
  }
  fakeAgent.status = "idle";
  const explicitResume = await handler("resume")({ ...invocation(fakeAgent), rawInput: "confirm rerun" });
  console.log("resume(explicit force, confirm) ->", JSON.stringify(explicitResume));
  if (explicitResume.kind !== "success") throw new Error("confirmed resume after explicit force pause should succeed");
  if (taskControl.state(fakeAgent.id).paused !== false) throw new Error("confirmed resume should clear the explicit force pause");

  // settings route payload validation is exercised through the file directly;
  // the route handler only accepts force|safe / stop|wait and keeps old values.

  console.log("\nALL HOST HALF CHECKS PASSED");
} finally {
  rmSync(stateRoot, { recursive: true, force: true });
}
