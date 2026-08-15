//#region lib/types/index.js
/**
* Task control for DSH Web, host half.
*
* Adds durable per-session task state plus three human-facing commands:
*
* - `/pause`  — pause the task. If a TOOL is mid-execution, the tool is NOT
*   interrupted: the pause is deferred to the next safe boundary — when the
*   in-flight tool completes (`tool/result`) and no more tools are running —
*   and only then is the turn stopped and the session marked paused. The
*   trace keeps recording until that boundary. An active same-session goal is
*   paused as well.
* - `/resume` — clear the paused marker and re-queue the remembered prompt
*   through `Agent.followup()`, which starts a normal later turn.
* - `/cancel` — stop the task NOW. If a tool is mid-execution it is
*   terminated immediately, and the reply tells the user what that tool was
*   meant to achieve and reminds them to check for side effects.
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
/** The in-flight tool map for one session (callId → { name, arguments }). */
function inflightOf(state, sessionId) {
	let map = state.inFlight.get(sessionId);
	if (map === void 0) {
		map = new Map();
		state.inFlight.set(sessionId, map);
	}
	return map;
}
/**
* Describe what a tool call was meant to achieve, for cancel reporting.
* Prefers the model-authored `description` argument, then the bash command,
* then a compact rendering of the arguments.
*/
function describeToolPurpose(info) {
	if (info === void 0 || info === null) return "未知工具";
	let args = null;
	try {
		args = typeof info.arguments === "string" ? JSON.parse(info.arguments) : info.arguments;
	} catch {
		args = null;
	}
	if (args !== null && typeof args.description === "string" && args.description.length > 0) return args.description;
	if (info.name === "bash" && args !== null && typeof args.command === "string") return `运行命令：${args.command}`;
	if (args !== null) {
		try {
			return JSON.stringify(args).slice(0, 120);
		} catch {
			/* ignore */
		}
	}
	return `工具 ${info.name}`;
}
/**
* Apply the pause NOW: stop the running turn (inbox preserved), hold a
* same-session goal, and append the durable paused event. Used directly by
* `/pause` when no tool is in flight, and by the session-event listener once
* the in-flight tool reaches the safe boundary.
* @returns the command-style result object.
*/
function applyPauseNow(ctx, state, agent, resumeContent) {
	state.pendingPause.delete(agent.id);
	const current = taskControlState(agent);
	if (current.paused) return {
		kind: "success",
		text: "task is already paused"
	};
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
/** `/pause`: pause now, or defer to the next safe boundary while a tool runs. */
function pauseTask(ctx, state, invocation) {
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
	if (agent.status === "running" && inflightOf(state, agent.id).size > 0) {
		state.pendingPause.set(agent.id, { resumeContent });
		return {
			kind: "success",
			text: "task pausing — waiting for the running tool to finish (safe boundary), trace keeps recording until then"
		};
	}
	return applyPauseNow(ctx, state, agent, resumeContent);
}
/** `/resume`: clear the paused marker and re-queue the remembered prompt. */
function resumeTask(ctx, state, invocation) {
	const agent = ctx.agents.get(invocation.agent.id);
	if (agent === void 0) return {
		kind: "error",
		text: "no live agent for this session"
	};
	state.pendingPause.delete(agent.id);
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
/** `/cancel`: stop the task NOW; report an interrupted tool's purpose and side-effect risk. */
function cancelTask(ctx, state, invocation) {
	const agent = ctx.agents.get(invocation.agent.id);
	if (agent === void 0) return {
		kind: "error",
		text: "no live agent for this session"
	};
	const current = taskControlState(agent);
	if (current.paused) agent.session.append(RESUMED_EVENT, {});
	state.pendingPause.delete(agent.id);
	let interrupted = null;
	if (agent.status === "running") {
		const inFlight = inflightOf(state, agent.id);
		if (inFlight.size > 0) {
			// The most recently started tool is the one being interrupted.
			const entries = [...inFlight.values()];
			interrupted = entries[entries.length - 1];
		}
		agent.cancel({
			kind: "user"
		}, { keepInbox: true });
	}
	if (interrupted !== null) {
		return {
			kind: "success",
			text: `task cancelled — 已立即终止正在执行的工具 ${interrupted.name}。其预期目的：${describeToolPurpose(interrupted)}。请检查该操作是否产生了副作用（文件修改、进程、网络等）。`
		};
	}
	return {
		kind: "success",
		text: "task cancelled"
	};
}
/**
* Apply a deferred pause outside the current session/event dispatch: appending
* to the session re-entrantly from inside its own append feed is unreliable,
* so the pause lands on a microtask boundary.
*/
function scheduleDeferredPause(ctx, state, sessionId, resumeContent) {
	queueMicrotask(() => {
		try {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) {
				state.pendingPause.delete(sessionId);
				return;
			}
			applyPauseNow(ctx, state, agent, resumeContent);
		} catch (error) {
			ctx.logger?.warn?.("task-control: deferred pause failed: " + String(error));
			state.pendingPause.delete(sessionId);
		}
	});
}
/**
* Session-event listener: track in-flight tools and apply deferred pauses at
* the safe boundary (when the last in-flight tool completes).
* @param ctx - the plugin context.
* @param state - shared recorder state.
* @param session - the live session.
* @param event - the appended session event.
*/
function handleSessionToolEvent(ctx, state, session, event) {
	const sessionId = session.id;
	if (typeof sessionId !== "string") return;
	if (event.type === "tool/call") {
		const info = {
			name: event.data?.name,
			arguments: event.data?.arguments
		};
		if (typeof event.data?.callId === "string") inflightOf(state, sessionId).set(event.data.callId, info);
		return;
	}
	if (event.type === "tool/result") {
		const callId = event.data?.message?.source?.callId ?? event.data?.message?.content?.[0]?.toolCallId;
		if (typeof callId === "string") inflightOf(state, sessionId).delete(callId);
		const pending = state.pendingPause.get(sessionId);
		if (pending !== void 0 && inflightOf(state, sessionId).size === 0) {
			scheduleDeferredPause(ctx, state, sessionId, pending.resumeContent ?? null);
		}
		return;
	}
	if (event.type === "user/message") {
		// Fallback: some flows deliver tool results as a user/message with a
		// tool-result block instead of a dedicated tool/result event.
		const content = Array.isArray(event.data?.content) ? event.data.content : [];
		for (const block of content) {
			if (block?.type === "tool-result" && typeof block.toolCallId === "string") {
				inflightOf(state, sessionId).delete(block.toolCallId);
			}
		}
		const pending = state.pendingPause.get(sessionId);
		if (pending !== void 0 && inflightOf(state, sessionId).size === 0) {
			scheduleDeferredPause(ctx, state, sessionId, pending.resumeContent ?? null);
		}
		return;
	}
}
/**
* Build the programmatic `taskControl` service: pause / resume / cancel /
* state addressed by session id. Command handlers and other plugins share
* this one implementation.
* @param ctx - the plugin context (provides `agents`).
* @param state - shared in-flight/pending-pause state.
* @returns the service object to publish under `ctx.provide("taskControl", …)`.
*/
function createTaskControlService(ctx, state) {
	const invocationFor = (sessionId) => ({
		agent: ctx.agents.get(sessionId),
		rawInput: "",
		commandId: "task-control"
	});
	const toResult = (result) => result.kind === "success"
		? { ok: true, text: result.text }
		: { ok: false, error: result.text };
	return {
		/** Pause the task of one session by id (deferred to the safe boundary while a tool runs). Returns `{ ok, text }` or `{ ok:false, error }`. */
		pause(sessionId) {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) return { ok: false, error: `no live agent for session "${sessionId}"` };
			return toResult(pauseTask(ctx, state, invocationFor(sessionId)));
		},
		/** Resume the paused task of one session by id. */
		resume(sessionId) {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) return { ok: false, error: `no live agent for session "${sessionId}"` };
			return toResult(resumeTask(ctx, state, invocationFor(sessionId)));
		},
		/** Cancel the task of one session by id immediately (interrupts any running tool and reports its purpose). */
		cancel(sessionId) {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) return { ok: false, error: `no live agent for session "${sessionId}"` };
			return toResult(cancelTask(ctx, state, invocationFor(sessionId)));
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
/** Register the projection, the three task-control commands, the session-event listener, and the taskControl service. */
function apply(ctx) {
	const state = {
		inFlight: new Map(),
		pendingPause: new Map()
	};
	ctx.sessionProjections.register(taskControlProjection);
	ctx.commands.register({
		name: "pause",
		description: "pause the running task (defers to the safe boundary while a tool runs)",
		handler: (invocation) => pauseTask(ctx, state, invocation)
	});
	ctx.commands.register({
		name: "resume",
		description: "resume the paused task (re-runs the interrupted prompt)",
		handler: (invocation) => resumeTask(ctx, state, invocation)
	});
	ctx.commands.register({
		name: "cancel",
		description: "cancel the running task (stops the current turn immediately, keeps the queue)",
		handler: (invocation) => cancelTask(ctx, state, invocation)
	});
	ctx.on("session/event", (session, event) => {
		try {
			handleSessionToolEvent(ctx, state, session, event);
		} catch (error) {
			ctx.logger?.warn?.("task-control: session event handling failed: " + String(error));
		}
	});
	ctx.provide("taskControl", createTaskControlService(ctx, state));
}
//#endregion
export { apply, createTaskControlService, inject, name, taskControlProjection };
