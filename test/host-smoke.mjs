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
const ctx = {
  logger: { warn: (...a) => console.log("[warn]", ...a) },
  get(key) {
    if (key === "goals") return goalsService;
    return undefined;
  },
  provide(key, value) { provided[key] = value; },
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

console.log("\nALL HOST HALF CHECKS PASSED");
