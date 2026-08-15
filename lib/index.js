//#region lib/types/index.js
/**
* Task control for DSH Web, host half.
*
* Adds durable per-session task state plus three human-facing commands:
*
* - `/pause [force|safe] [stop|wait]` — pause the task with a MODE:
*   - **safe** (default): never interrupts work. A running TOOL is left to
*     finish — the pause lands at the safe boundary (when the last in-flight
*     tool completes). A running REASONING (LLM output) is handled by the
*     configured granularity:
*       * `stop` (default): terminate the current LLM output now; on resume
*         the model re-reasons.
*       * `wait`: do NOT interrupt the LLM — reasoning continues and the
*         pause applies only after the reasoning completes.
*   - **force**: interrupts everything NOW — any in-flight tool is cancelled
*     and the LLM output is cut. The paused state remembers which tool was
*     interrupted (`interruptedTool`), and resume re-runs FROM that tool as
*     the execution node — after the user CONFIRMS (the tool may have
*     partially executed and caused side effects).
* - `/resume [confirm]` — clear the paused marker and re-queue the remembered
*   prompt. A FORCE-paused task requires `confirm` first (the reply names the
*   interrupted tool and asks for confirmation); after confirmation, the
*   resume message instructs the agent to re-execute from that tool call.
* - `/cancel` — stop the task NOW. If a tool is mid-execution it is
*   terminated immediately, and the reply tells the user what that tool was
*   meant to achieve and reminds them to check for side effects.
*
* The paused state is durable: each mutation appends a `task-control/*`
* event to the session log, and a `taskControl` session projection folds
* those events (paused / resumeContent / forced / interruptedTool) so the
* browser half renders the controls from the same authoritative state.
*
* The host also publishes a `taskControl` service (pause/resume/cancel/state
* by session id) used by dsh-task-batch and other plugins.
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
/** Safe-pause reasoning granularity default when the row config is absent. */
const DEFAULT_SAFE_PAUSE_REASONING = "stop";
/** Projection schema: paused flag, resume source, and forced-pause context. */
const taskControlSchema = z.object({
	paused: z.boolean(),
	resumeContent: z.array(z.object({
		type: z.string(),
		text: z.string().optional()
	})).nullable(),
	forced: z.boolean(),
	interruptedTool: z.object({
		name: z.string(),
		arguments: z.unknown().nullable(),
		callId: z.string()
	}).nullable()
}).strict();
/** Projection unit registered on `ctx.sessionProjections`: fold of pause/resume events. */
const taskControlProjection = {
	key: "taskControl",
	schema: taskControlSchema,
	stateVersion: 0,
	init: () => ({
		paused: false,
		resumeContent: null,
		forced: false,
		interruptedTool: null
	}),
	apply: (state, event) => {
		switch (event.type) {
			case PAUSED_EVENT: return {
				paused: true,
				resumeContent: event.data.resumeContent ?? null,
				forced: event.data.forced === true,
				interruptedTool: event.data.interruptedTool ?? null
			};
			case RESUMED_EVENT: return {
				paused: false,
				resumeContent: null,
				forced: false,
				interruptedTool: null
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
/** Drop all in-flight tracking for a session (used when tools are interrupted). */
function clearInflight(state, sessionId) {
	state.inFlight.delete(sessionId);
}
/** The most recently started in-flight tool, if any. */
function latestInflight(state, sessionId) {
	const map = inflightOf(state, sessionId);
	const entries = [...map.values()];
	return entries.length > 0 ? entries[entries.length - 1] : null;
}
/**
* Describe what a tool call was meant to achieve, for cancel/forced-pause
* reporting. Prefers the model-authored `description` argument, then the bash
* command, then a compact rendering of the arguments.
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
/** Hold a same-session goal so the goal-round driver cannot re-queue rounds. */
function pauseSessionGoal(ctx, agent) {
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
}
/**
* Apply the pause NOW: stop the running turn (inbox preserved), hold a
* same-session goal, and append the durable paused event (with the forced
* context when applicable).
*/
function applyPauseNow(ctx, state, agent, resumeContent, forcedContext) {
	state.pendingPause.delete(agent.id);
	const current = taskControlState(agent);
	if (current.paused) return {
		kind: "success",
		text: "task is already paused"
	};
	if (agent.status === "running") agent.cancel({
		kind: "user"
	}, { keepInbox: true });
	clearInflight(state, agent.id);
	pauseSessionGoal(ctx, agent);
	agent.session.append(PAUSED_EVENT, {
		resumeContent,
		forced: forcedContext?.forced === true,
		interruptedTool: forcedContext?.interruptedTool ?? null
	});
	return {
		kind: "success",
		text: agent.status === "running" ? "task paused — the running turn was stopped" : "task paused"
	};
}
/**
* `/pause`: forced pauses interrupt everything now; safe pauses defer to the
* next safe boundary (tool completion, or — with `reason: 'wait'` — the end
* of the current reasoning).
*/
function pauseTask(ctx, config, state, invocation, opts) {
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
	const mode = opts?.mode ?? "safe";
	const reason = opts?.reason ?? config.safePauseReasoning ?? DEFAULT_SAFE_PAUSE_REASONING;
	const resumeContent = agent.status === "running" ? lastUserPrompt(agent) : null;
	if (mode === "force") {
		const interruptedTool = latestInflight(state, agent.id);
		if (agent.status === "running") agent.cancel({
			kind: "user"
		}, { keepInbox: true });
		clearInflight(state, agent.id);
		pauseSessionGoal(ctx, agent);
		agent.session.append(PAUSED_EVENT, {
			resumeContent,
			forced: true,
			interruptedTool: interruptedTool ? {
				name: interruptedTool.name,
				arguments: interruptedTool.arguments,
				callId: interruptedTool.callId
			} : null
		});
		return {
			kind: "success",
			text: interruptedTool !== null
				? `task force-paused — interrupted tool ${interruptedTool.name}（预期目的：${describeToolPurpose(interruptedTool)}），可能已部分执行`
				: "task force-paused — interrupted the running turn"
		};
	}
	// safe mode
	if (agent.status === "running" && inflightOf(state, agent.id).size > 0) {
		state.pendingPause.set(agent.id, { resumeContent, mode: "safe", reason });
		return {
			kind: "success",
			text: "task pausing — waiting for the running tool to finish (safe boundary), trace keeps recording until then"
		};
	}
	if (agent.status === "running" && reason === "wait") {
		state.pendingPause.set(agent.id, { resumeContent, mode: "safe", reason: "wait" });
		return {
			kind: "success",
			text: "task pausing — waiting for the current reasoning to complete before pausing"
		};
	}
	return applyPauseNow(ctx, state, agent, resumeContent, { forced: false, interruptedTool: null });
}
/**
* `/resume`: clear the paused marker and re-queue the remembered prompt.
* A force-paused task requires `confirm` first and resumes FROM the
* interrupted tool (re-executing it as the execution node).
*/
function resumeTask(ctx, state, invocation, opts) {
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
	if (current.forced) {
		const toolName = current.interruptedTool?.name ?? "未知工具";
		if (opts?.confirm !== true) {
			return {
				kind: "error",
				needConfirmation: true,
				text: `需要确认：工具 ${toolName} 在强制暂停前已被取消，可能已部分执行（${describeToolPurpose(current.interruptedTool)}）。确认后将从该工具调用重新执行。`
			};
		}
		agent.session.append(RESUMED_EVENT, {});
		const blocks = [];
		if (current.resumeContent !== null && current.resumeContent.length > 0) blocks.push(...current.resumeContent);
		blocks.push({
			type: "text",
			text: `[强制暂停恢复] 工具 ${toolName}（${describeToolPurpose(current.interruptedTool)}）在暂停前已被取消，可能已部分执行。请从该工具调用开始重新执行以继续任务。`
		});
		const message = createUserMessage({
			content: blocks,
			source: {
				kind: "plugin",
				plugin: "task-control"
			}
		});
		agent.followup(message);
		return {
			kind: "success",
			text: `task resumed — re-executing from the interrupted tool ${toolName}`
		};
	}
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
		interrupted = latestInflight(state, agent.id);
		agent.cancel({
			kind: "user"
		}, { keepInbox: true });
		clearInflight(state, agent.id);
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
* Apply a deferred (safe) pause OUTSIDE the current session/event dispatch:
* appending to the session re-entrantly from inside its own append feed is
* unreliable, so the pause lands on a microtask boundary.
*/
function scheduleDeferredPause(ctx, state, sessionId, resumeContent) {
	queueMicrotask(() => {
		try {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) {
				state.pendingPause.delete(sessionId);
				return;
			}
			applyPauseNow(ctx, state, agent, resumeContent, { forced: false, interruptedTool: null });
		} catch (error) {
			ctx.logger?.warn?.("task-control: deferred pause failed: " + String(error));
			state.pendingPause.delete(sessionId);
		}
	});
}
/** Resolve the pending pause's resumeContent and schedule its application. */
function tryApplyPending(ctx, state, sessionId) {
	const pending = state.pendingPause.get(sessionId);
	if (pending === void 0) return;
	if (pending.mode !== "safe") return;
	if (inflightOf(state, sessionId).size > 0) return;
	scheduleDeferredPause(ctx, state, sessionId, pending.resumeContent ?? null);
}
/**
* Session-event listener: track in-flight tools and apply deferred pauses at
* the safe boundary — when the last in-flight tool completes, or (with
* `reason: 'wait'`) when the current reasoning completes.
*/
function handleSessionToolEvent(ctx, state, session, event) {
	const sessionId = session.id;
	if (typeof sessionId !== "string") return;
	if (event.type === "tool/call") {
		const info = {
			name: event.data?.name ?? "tool",
			arguments: event.data?.arguments ?? null,
			callId: event.data?.callId ?? "unknown"
		};
		if (typeof event.data?.callId === "string") inflightOf(state, sessionId).set(event.data.callId, info);
		return;
	}
	if (event.type === "tool/result") {
		const callId = event.data?.message?.source?.callId ?? event.data?.message?.content?.[0]?.toolCallId;
		if (typeof callId === "string") inflightOf(state, sessionId).delete(callId);
		tryApplyPending(ctx, state, sessionId);
		return;
	}
	if (event.type === "assistant/message") {
		// Reasoning completed (the LLM output finished assembling).
		tryApplyPending(ctx, state, sessionId);
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
		tryApplyPending(ctx, state, sessionId);
		return;
	}
}
/**
* Build the programmatic `taskControl` service: pause / resume / cancel /
* state addressed by session id. Command handlers and other plugins share
* this one implementation.
*/
function createTaskControlService(ctx, config, state) {
	const invocationFor = (sessionId) => ({
		agent: ctx.agents.get(sessionId),
		rawInput: "",
		commandId: "task-control"
	});
	const toResult = (result) => result.kind === "success"
		? { ok: true, text: result.text, ...(result.needConfirmation === true ? { needConfirmation: true } : {}) }
		: { ok: false, error: result.text, ...(result.needConfirmation === true ? { needConfirmation: true } : {}) };
	return {
		/** Pause by session id. `opts`: `{ mode: 'safe'|'force', reason: 'stop'|'wait' }`. */
		pause(sessionId, opts) {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) return { ok: false, error: `no live agent for session "${sessionId}"` };
			return toResult(pauseTask(ctx, config, state, invocationFor(sessionId), opts));
		},
		/** Resume by session id. `opts`: `{ confirm: true }` required for force-paused tasks. */
		resume(sessionId, opts) {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) return { ok: false, error: `no live agent for session "${sessionId}"` };
			return toResult(resumeTask(ctx, state, invocationFor(sessionId), opts));
		},
		/** Cancel by session id immediately (interrupts any running tool and reports its purpose). */
		cancel(sessionId) {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) return { ok: false, error: `no live agent for session "${sessionId}"` };
			return toResult(cancelTask(ctx, state, invocationFor(sessionId)));
		},
		/** Read one session's task-control state: status / paused / forced / interruptedTool / resumeContent. */
		state(sessionId) {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) return { status: "offline", paused: false, forced: false, interruptedTool: null, resumeContent: null };
			const current = taskControlState(agent);
			return {
				status: agent.status,
				paused: current.paused,
				forced: current.forced,
				interruptedTool: current.interruptedTool,
				resumeContent: current.resumeContent
			};
		}
	};
}
/** Register the projection, the commands, the session-event listener, and the taskControl service. */
function apply(ctx, config = {}) {
	const state = {
		inFlight: new Map(),
		pendingPause: new Map()
	};
	const resolvedConfig = {
		safePauseReasoning: config.safePauseReasoning ?? DEFAULT_SAFE_PAUSE_REASONING
	};
	ctx.sessionProjections.register(taskControlProjection);
	ctx.commands.register({
		name: "pause",
		description: "pause the running task (safe: defers to the safe boundary; force: interrupts tools and reasoning now; wait: let reasoning finish)",
		input: { hint: "[force|safe] [stop|wait]" },
		handler: (invocation) => {
			const tokens = (invocation.rawInput ?? "").trim().split(/\s+/).filter(Boolean);
			const opts = {};
			for (const token of tokens) {
				if (token === "force" || token === "safe") opts.mode = token;
				if (token === "stop" || token === "wait") opts.reason = token;
			}
			return pauseTask(ctx, resolvedConfig, state, invocation, opts);
		}
	});
	ctx.commands.register({
		name: "resume",
		description: "resume the paused task (a force-paused task needs `confirm`)",
		input: { hint: "[confirm]" },
		handler: (invocation) => resumeTask(ctx, state, invocation, { confirm: (invocation.rawInput ?? "").trim() === "confirm" })
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
	ctx.provide("taskControl", createTaskControlService(ctx, resolvedConfig, state));
}
//#endregion
export { DEFAULT_SAFE_PAUSE_REASONING, apply, createTaskControlService, inject, name, taskControlProjection };
