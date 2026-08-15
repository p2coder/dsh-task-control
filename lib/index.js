//#region lib/types/index.js
/**
* Task control for DSH Web, host half.
*
* Adds durable per-session task state plus three human-facing commands:
*
* - `/pause`  — stop the in-flight turn now (same abort semantics as the
*   existing stop button, inbox preserved) and mark the session paused,
*   remembering the originating user prompt so the task can be resumed.
*   An active same-session goal is paused as well, so the goal-round driver
*   cannot re-queue automatic rounds while the task is on hold.
* - `/resume` — clear the paused marker and re-queue the remembered prompt
*   through `Agent.followup()`, which starts a normal later turn (the loop's
*   waking-after-abort path sends it to next-turn and wakes the driver).
* - `/cancel` — stop the in-flight turn (inbox preserved, like the stop
*   button) and clear any paused marker.
*
* The paused state is durable: each mutation appends a `task-control/*`
* event to the session log, and a `taskControl` session projection folds
* those events so the browser half can render the Pause/Resume/Cancel
* controls from the same authoritative state.
*
* The host also publishes a `taskControl` service so other plugins (e.g.
* `dsh-task-batch`) can pause / resume / cancel ANY session's task by
* session id through this SAME implementation — the service is the single
* programmatic face; commands route through it, and no consumer copies the
* logic.
*
* @module dsh-task-control
*/
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { z } from "zod";
//#endregion
const name = "task-control";
const inject = ["agents", "commands", "sessionProjections", "goals"];
/** Durable session event appended when the user pauses the task. */
const PAUSED_EVENT = "task-control/paused";
/** Durable session event appended when the user resumes (or cancels) the task. */
const RESUMED_EVENT = "task-control/resumed";
/** Content captured at pause time: the last user-originated prompt. */
const taskControlSchema = z.object({
	paused: z.boolean(),
	resumeContent: z.array(z.object({
		type: z.string(),
		text: z.string().optional()
	})).nullable()
}).strict();
/** Projection unit registered on `ctx.sessionProjections`: fold of pause/resume events. */
const taskControlProjection = {
	key: "taskControl",
	schema: taskControlSchema,
	stateVersion: 0,
	init: () => ({
		paused: false,
		resumeContent: null
	}),
	apply: (state, event) => {
		switch (event.type) {
			case PAUSED_EVENT: return {
				paused: true,
				resumeContent: event.data.resumeContent ?? null
			};
			case RESUMED_EVENT: return {
				paused: false,
				resumeContent: null
			};
			default: return state;
		}
	},
	view: (state) => state
};
/** The last user-originated prompt content, used as the resume source. */
function lastUserPrompt(agent) {
	for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
		const event = agent.session.events[index];
		if (event.type !== "user/message") continue;
		if (event.data.source?.kind !== "user") continue;
		return event.data.content ?? null;
	}
	return null;
}
/** Fold the log for the latest task-control state (used by command handlers). */
function taskControlState(agent) {
	let state = taskControlProjection.init();
	for (const event of agent.session.events) state = taskControlProjection.apply(state, event);
	return state;
}
/** `/pause`: stop the in-flight turn and mark the session paused. */
function pauseTask(ctx, invocation) {
	const agent = ctx.agents.get(invocation.agent.id);
	if (agent === void 0) return {
		kind: "error",
		text: "no live agent for this session — nothing to pause"
	};
	const current = taskControlState(agent);
	if (current.paused) return {
		kind: "success",
		text: "task is already paused"
	};
	const resumeContent = agent.status === "running" ? lastUserPrompt(agent) : null;
	if (agent.status === "running") agent.cancel({
		kind: "user"
	}, { keepInbox: true });
	// Holding a same-session goal keeps the goal-round driver from re-queuing
	// automatic rounds while the task is paused.
	try {
		const goals = ctx.get("goals");
		if (goals !== void 0) {
			const goal = goals.get(agent);
			if (goal !== void 0 && goal.phase === "active") goals.pause(agent, {
				id: goal.id,
				revision: goal.revision
			});
		}
	} catch (error) {
		ctx.logger?.warn?.("task-control: goal pause failed: " + String(error));
	}
	agent.session.append(PAUSED_EVENT, {
		resumeContent
	});
	return {
		kind: "success",
		text: agent.status === "running" ? "task paused — the running turn was stopped" : "task paused"
	};
}
/** `/resume`: clear the paused marker and re-queue the remembered prompt. */
function resumeTask(ctx, invocation) {
	const agent = ctx.agents.get(invocation.agent.id);
	if (agent === void 0) return {
		kind: "error",
		text: "no live agent for this session"
	};
	const current = taskControlState(agent);
	if (!current.paused) return {
		kind: "success",
		text: "no paused task to resume"
	};
	agent.session.append(RESUMED_EVENT, {});
	if (current.resumeContent !== null && current.resumeContent.length > 0) {
		const message = createUserMessage({
			content: current.resumeContent,
			source: {
				kind: "plugin",
				plugin: "task-control"
			}
		});
		agent.followup(message);
		return {
			kind: "success",
			text: "task resumed — re-running the interrupted prompt"
		};
	}
	return {
		kind: "success",
		text: "task resumed"
	};
}
/** `/cancel`: stop the in-flight turn and clear any paused marker. */
function cancelTask(ctx, invocation) {
	const agent = ctx.agents.get(invocation.agent.id);
	if (agent === void 0) return {
		kind: "error",
		text: "no live agent for this session"
	};
	const current = taskControlState(agent);
	if (current.paused) agent.session.append(RESUMED_EVENT, {});
	if (agent.status === "running") agent.cancel({
		kind: "user"
	}, { keepInbox: true });
	return {
		kind: "success",
		text: "task cancelled"
	};
}
/**
* Build the programmatic `taskControl` service: pause / resume / cancel /
* state addressed by session id. Command handlers and other plugins share
* this one implementation.
* @param ctx - the plugin context (provides `agents`).
* @returns the service object to publish under `ctx.provide("taskControl", …)`.
*/
function createTaskControlService(ctx) {
	const invocationFor = (sessionId) => ({
		agent: ctx.agents.get(sessionId),
		rawInput: "",
		commandId: "task-control"
	});
	const toResult = (result) => result.kind === "success"
		? { ok: true, text: result.text }
		: { ok: false, error: result.text };
	return {
		/** Pause the task of one session by id. Returns `{ ok, text }` or `{ ok:false, error }`. */
		pause(sessionId) {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) return { ok: false, error: `no live agent for session "${sessionId}"` };
			return toResult(pauseTask(ctx, invocationFor(sessionId)));
		},
		/** Resume the paused task of one session by id. */
		resume(sessionId) {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) return { ok: false, error: `no live agent for session "${sessionId}"` };
			return toResult(resumeTask(ctx, invocationFor(sessionId)));
		},
		/** Cancel the task of one session by id (session stays; paused marker cleared). */
		cancel(sessionId) {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) return { ok: false, error: `no live agent for session "${sessionId}"` };
			return toResult(cancelTask(ctx, invocationFor(sessionId)));
		},
		/** Read one session's task-control state: `{ status, paused, resumeContent }`. */
		state(sessionId) {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) return { status: "offline", paused: false, resumeContent: null };
			const current = taskControlState(agent);
			return {
				status: agent.status,
				paused: current.paused,
				resumeContent: current.resumeContent
			};
		}
	};
}
/** Register the projection, the three task-control commands, and the taskControl service. */
function apply(ctx) {
	ctx.sessionProjections.register(taskControlProjection);
	ctx.commands.register({
		name: "pause",
		description: "pause the running task (stops the current turn and holds the session)",
		handler: (invocation) => pauseTask(ctx, invocation)
	});
	ctx.commands.register({
		name: "resume",
		description: "resume the paused task (re-runs the interrupted prompt)",
		handler: (invocation) => resumeTask(ctx, invocation)
	});
	ctx.commands.register({
		name: "cancel",
		description: "cancel the running task (stops the current turn, keeps the queue)",
		handler: (invocation) => cancelTask(ctx, invocation)
	});
	ctx.provide("taskControl", createTaskControlService(ctx));
}
//#endregion
export { apply, createTaskControlService, inject, name, taskControlProjection };
