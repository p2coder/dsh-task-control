//#region lib/types/index.js
/**
* Task control for DSH Web, host half.
*
* Adds durable per-session task state plus three human-facing commands:
*
* - `/pause [force|safe] [stop|wait]` — pause the task with a MODE. Without an
*   explicit mode the pause follows the pause-granularity settings (Web 设置 →
*   任务控制; shipped default: `safe` + `wait`):
*   - **force**: interrupts everything NOW — any in-flight tool is
*     cancelled and the LLM output is cut. The paused state remembers which
*     tool was interrupted (`interruptedTool`). On resume the interrupted
*     tool's actual outcome is looked up in the session log (the cancelled
*     tool's result still lands as a `tool/result` once the drain settles): if
*     it actually completed, execution continues without re-running it;
*     otherwise the user is told that the tool did NOT finish and chooses
*     between re-running it, skipping it, or staying paused.
*   - **safe**: never interrupts work. A running TOOL is left
*     to finish — the pause lands at the safe boundary (when the last in-flight
*     tool completes). A running REASONING (LLM output) is handled by the
*     configured granularity:
*       * `stop`: terminate the current LLM output now; on resume
*         the model re-reasons.
*       * `wait`: do NOT interrupt the LLM — reasoning continues and the
*         pause applies only after the reasoning completes. If the finished
*         reasoning emitted tool calls, the pause lands BEFORE their dispatch:
*         those tools are recorded as `deferredTools` (never dispatched, no
*         side effects). On resume the user chooses whether they are re-run
*         (default) or skipped; tools that actually ran while draining keep
*         their real results and are never re-run.
* - `/resume [confirm] [rerun|skip]` — clear the paused marker and continue
*   FROM the pause point (the session log IS the trace; nothing is re-sent
*   from scratch). A FORCE-paused task with an interrupted tool requires
*   `confirm` first, and the user's choice (`rerun` re-executes that tool,
*   `skip` continues without it) shapes the resume instruction. A SAFE-paused
*   task that is still actually running resumes by just clearing the marker —
*   the tool/model output that flowed while "paused" keeps showing normally.
* - `/cancel` — stop the task NOW. If a tool is mid-execution it is
*   terminated immediately, and the reply tells the user what that tool was
*   meant to achieve and reminds them to check for side effects.
*
* STATE MODEL (Route A): the paused state is NOT written into the session
* log as custom event types. The harness's persistence reader only accepts
* event types from its generated known-event set (or events carrying
* `ignorable: true`, which the current `session.append()` cannot produce), so
* a session containing `task-control/*` events becomes unloadable after a
* restart. Instead the plugin keeps its own durable per-session store
* (`~/.dsh/task-control/<sessionId>.json`, atomic tmp+rename; override the
* root with `DSH_TASK_CONTROL_STATE_DIR`), and every consumer reads through
* that single source:
*
*   - the `taskControl` service (`state()` works even for offline sessions);
*   - the `/task-control/state` JSON route for the browser dock;
*   - the `/task-control/settings` JSON route for the Web settings page;
*   - dsh-trace-repeat reconciles its pause gate from the `taskControl`
*     service on every session event.
*
* PAUSE-GRANULARITY SETTINGS: a bare `/pause` (or `taskControl.pause(id)`
* without `opts`) uses the settings persisted in `settings.json` (same state
* root): `defaultMode` (`force` | `safe`) and `safeReasoning` (`stop` | `wait`,
* used when the mode is `safe`). The shipped default is `safe` + `wait`; the
* Web settings page (设置 → 任务控制) and the `/task-control/settings` route
* both read and write it, and explicit `/pause force|safe [stop|wait]` tokens
* always override the settings.
*
* The `taskControl` service (pause/resume/cancel/state by session id) is the
* programmatic face used by dsh-task-batch and other plugins.
*
* @module dsh-task-control
*/
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
//#endregion
const name = "task-control";
const inject = ["agents", "commands", "goals", "webServer"];
/** Built-in defaults for the pause-granularity settings (settings.json in the state root). */
const DEFAULT_SETTINGS = { defaultMode: "safe", safeReasoning: "wait" };

// ── durable per-session state store ──────────────────────────────────────────

/** Sanitize a session id into a safe file name. */
function encodeSessionId(sessionId) {
	return String(sessionId).replace(/[^a-zA-Z0-9._-]/g, "_");
}
/** State root: `~/.dsh/task-control` (override via DSH_TASK_CONTROL_STATE_DIR). */
function stateRootDir() {
	return process.env.DSH_TASK_CONTROL_STATE_DIR || join(process.env.HOME || process.cwd(), ".dsh", "task-control");
}
/** Per-session state file path. */
function stateFilePath(sessionId) {
	return join(stateRootDir(), `${encodeSessionId(sessionId)}.json`);
}
/** Read the durable state for one session; null when no pause is recorded. */
function readStoredState(sessionId) {
	try {
		const file = stateFilePath(sessionId);
		if (!existsSync(file)) return null;
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}
/** Atomically write the durable state for one session. */
function writeStoredState(sessionId, snapshot) {
	const file = stateFilePath(sessionId);
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
	renameSync(tmp, file);
}
/** Remove the durable state for one session (unpaused). */
function clearStoredState(sessionId) {
	try { rmSync(stateFilePath(sessionId), { force: true }); } catch { /* ignore */ }
}
/** The unpaused baseline snapshot. */
function idleState(sessionId) {
	return { sessionId, paused: false, resumeContent: null, forced: false, interruptedTool: null, deferredTools: null, updatedAt: null };
}
/** Current state for one session, from the plugin's own store (cached). */
function currentState(state, sessionId) {
	const cached = state.cache.get(sessionId);
	if (cached !== void 0) return cached;
	const stored = readStoredState(sessionId);
	const merged = stored !== null && typeof stored === "object" && stored !== void 0 ? stored : idleState(sessionId);
	state.cache.set(sessionId, merged);
	return merged;
}
/** Persist a paused snapshot and refresh the in-memory cache. */
function markPaused(state, sessionId, resumeContent, forcedContext, deferredTools) {
	const snapshot = {
		sessionId,
		paused: true,
		resumeContent: resumeContent ?? null,
		forced: forcedContext?.forced === true,
		interruptedTool: forcedContext?.interruptedTool ?? null,
		deferredTools: deferredTools ?? null,
		updatedAt: Date.now()
	};
	writeStoredState(sessionId, snapshot);
	state.cache.set(sessionId, snapshot);
	return snapshot;
}
/** Clear the paused state (resume / cancel) and refresh the in-memory cache. */
function clearPaused(state, sessionId) {
	clearStoredState(sessionId);
	state.cache.set(sessionId, idleState(sessionId));
}

// ── pause-granularity settings (global; settings.json in the state root) ─────

/** Settings file path (same root as the per-session state). */
function settingsFilePath() {
	return join(stateRootDir(), "settings.json");
}
/** Read the pause-granularity settings; falls back to `safe` + `wait`. */
function readSettings() {
	try {
		const file = settingsFilePath();
		if (!existsSync(file)) return { ...DEFAULT_SETTINGS };
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return {
			defaultMode: parsed?.defaultMode === "force" || parsed?.defaultMode === "safe" ? parsed.defaultMode : DEFAULT_SETTINGS.defaultMode,
			safeReasoning: parsed?.safeReasoning === "stop" || parsed?.safeReasoning === "wait" ? parsed.safeReasoning : DEFAULT_SETTINGS.safeReasoning
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}
/** Atomically persist the pause-granularity settings. */
function writeSettings(settings) {
	const file = settingsFilePath();
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(settings, null, 2));
	renameSync(tmp, file);
}
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
/**
* Look up what actually happened to an interrupted tool call in the session
* log. The kernel DRAINS a started tool on cancel: its result still lands as
* a `tool/result` event once the execution settles (a bash process is killed
* and reports `aborted`, or the tool simply finishes). So a completed result
* means the tool really ran; an error result means it was aborted mid-flight
* (side-effect state unknown); no result at all means its state is unknown.
* Returns `null` when no result was recorded for `callId`.
*/
function findToolOutcome(agent, callId) {
	let outcome = null;
	for (const event of agent.session.events) {
		if (event.type === "tool/result") {
			const message = event.data?.message ?? {};
			const block = (Array.isArray(message.content) ? message.content : []).find((b) => b?.type === "tool-result");
			const id = block?.toolCallId ?? message.source?.callId;
			if (id === callId) {
				outcome = {
					hasResult: true,
					isError: block?.isError === true,
					abortedBeforeDispatch: event.data?.error?.code === "ABORTED_BEFORE_DISPATCH",
					content: block?.content ?? []
				};
			}
		} else if (event.type === "user/message") {
			// Some flows deliver tool results as a user/message tool-result block.
			const content = Array.isArray(event.data?.content) ? event.data.content : [];
			for (const block of content) {
				if (block?.type === "tool-result" && block.toolCallId === callId) {
					outcome = {
						hasResult: true,
						isError: block.isError === true,
						abortedBeforeDispatch: false,
						content: block.content ?? []
					};
				}
			}
		}
	}
	return outcome;
}
/** Render one interrupted tool for user-facing text: `name（用途）`. */
function describeTool(info) {
	return `${info?.name ?? "未知工具"}（${describeToolPurpose(info)}）`;
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
* same-session goal, and persist the paused snapshot (with the forced
* context when applicable).
*/
function applyPauseNow(ctx, state, agent, resumeContent, forcedContext, deferredTools) {
	state.pendingPause.delete(agent.id);
	const current = currentState(state, agent.id);
	if (current.paused) return {
		kind: "success",
		text: "task is already paused"
	};
	if (agent.status === "running") agent.cancel({
		kind: "user"
	}, { keepInbox: true });
	clearInflight(state, agent.id);
	pauseSessionGoal(ctx, agent);
	markPaused(state, agent.id, resumeContent, forcedContext, deferredTools);
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
function pauseTask(ctx, state, invocation, opts) {
	const agent = ctx.agents.get(invocation.agent.id);
	if (agent === void 0) return {
		kind: "error",
		text: "no live agent for this session — nothing to pause"
	};
	const current = currentState(state, agent.id);
	if (current.paused) return {
		kind: "success",
		text: "task is already paused"
	};
	// Explicit `/pause force|safe [stop|wait]` tokens win; otherwise the
	// pause-granularity settings (default: safe + wait) decide.
	const settings = readSettings();
	const mode = opts?.mode ?? settings.defaultMode;
	const reason = opts?.reason ?? settings.safeReasoning;
	const resumeContent = agent.status === "running" ? lastUserPrompt(agent) : null;
	if (mode === "force") {
		const interruptedTool = latestInflight(state, agent.id);
		if (agent.status === "running") agent.cancel({
			kind: "user"
		}, { keepInbox: true });
		clearInflight(state, agent.id);
		pauseSessionGoal(ctx, agent);
		markPaused(state, agent.id, resumeContent, {
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
* `/resume`: clear the paused marker and CONTINUE from the pause point —
* the session log IS the trace, so nothing is re-sent from scratch.
* A SAFE-paused task that is still actually running (the pause never truly
* landed) just clears the marker and keeps flowing. A FORCE-paused task with
* an interrupted tool requires `confirm` first; the user's choice decides
* whether that tool is re-executed (`rerun`, default) or skipped (`skip`).
* The interrupted tool's actual outcome is read from the session log first,
* so a tool that actually finished is never re-run.
*/
function resumeTask(ctx, state, invocation, opts) {
	const agent = ctx.agents.get(invocation.agent.id);
	if (agent === void 0) return {
		kind: "error",
		text: "no live agent for this session"
	};
	state.pendingPause.delete(agent.id);
	const current = currentState(state, agent.id);
	if (!current.paused) return {
		kind: "success",
		text: "no paused task to resume"
	};
	const followup = (blocks) => agent.followup(createUserMessage({
		content: blocks,
		source: {
			kind: "plugin",
			plugin: "task-control"
		}
	}));
	if (current.forced) {
		const tool = current.interruptedTool;
		if (tool !== null) {
			if (opts?.confirm !== true) {
				return {
					kind: "error",
					needConfirmation: true,
					text: `需要确认：上次暂停时工具 ${describeTool(tool)} 没有执行完成，将重新执行。请选择：重新执行该工具 / 跳过该工具 / 保持暂停。`
				};
			}
			const outcome = findToolOutcome(agent, tool.callId);
			clearPaused(state, agent.id);
			if (outcome !== null && !outcome.isError) {
				// The tool actually ran to completion while draining — do not re-run it.
				followup([{
					type: "text",
					text: `任务已恢复。上次暂停时工具 ${describeTool(tool)} 实际已执行完成（结果见上方上下文）。请基于该结果继续执行，不要重复执行该工具。`
				}]);
				return {
					kind: "success",
					text: `task resumed — tool ${tool.name} had actually completed, continuing`
				};
			}
			if (outcome !== null && outcome.abortedBeforeDispatch) {
				// Never dispatched: no side effects, safe to run or skip.
				if (opts?.choice === "skip") {
					followup([{
						type: "text",
						text: `任务已恢复。上次暂停时工具 ${describeTool(tool)} 未及执行（无副作用），你选择跳过。请直接继续后续工作。`
					}]);
					return {
						kind: "success",
						text: `task resumed — skipped tool ${tool.name}`
					};
				}
				followup([{
					type: "text",
					text: `任务已恢复。上次暂停时工具 ${describeTool(tool)} 未及执行（无副作用）。请执行该工具调用，然后继续任务。`
				}]);
				return {
					kind: "success",
					text: `task resumed — re-executing tool ${tool.name}`
				};
			}
			// Aborted mid-flight or no result at all: side-effect state unknown.
			if (opts?.choice === "skip") {
				followup([{
					type: "text",
					text: `任务已恢复。上次暂停时工具 ${describeTool(tool)} 没有执行完成（可能已部分执行，状态未知）。你选择跳过该工具：请基于已有上下文继续任务，不再执行该工具。`
				}]);
				return {
					kind: "success",
					text: `task resumed — skipped tool ${tool.name}`
				};
			}
			followup([{
				type: "text",
				text: `任务已恢复。上次暂停时工具 ${describeTool(tool)} 没有执行完成（可能已部分执行并产生副作用，状态未知）。你选择重新执行：请先评估/清理该工具可能产生的部分副作用，再重新执行该工具调用，然后继续任务。`
			}]);
			return {
				kind: "success",
				text: `task resumed — re-executing interrupted tool ${tool.name}`
			};
		}
		// Forced pause without an interrupted tool: continue from the latest trace.
		clearPaused(state, agent.id);
		followup([{
			type: "text",
			text: "任务已恢复。请基于以上上下文（暂停点之前的完整执行记录）继续执行任务。"
		}]);
		return {
			kind: "success",
			text: "task resumed — continuing from the latest trace"
		};
	}
	// Safe pause: continue from the pause point. A `safe wait` pause that
	// landed right after reasoning may have aborted the model's tool calls
	// before dispatch — those tools never ran (no side effects). Ask the
	// user whether to re-run (default) or skip them; tools that actually
	// ran while draining keep their real results and are never re-run.
	const deferred = Array.isArray(current.deferredTools) ? current.deferredTools : [];
	if (deferred.length > 0) {
		if (opts?.confirm !== true) {
			return {
				kind: "error",
				needConfirmation: true,
				text: `需要确认：上次暂停发生在推理完成后、工具执行前，以下工具未及执行（无副作用）：${deferred.map(describeTool).join("、")}。请选择：重新执行 / 跳过 / 保持暂停。`
			};
		}
		clearPaused(state, agent.id);
		const rerun = deferred.filter((tool) => {
			const outcome = findToolOutcome(agent, tool.callId);
			return outcome === null || outcome.abortedBeforeDispatch === true;
		});
		if (rerun.length === 0) {
			followup([{
				type: "text",
				text: "任务已恢复。上次暂停时待执行的工具均已实际执行完成，请基于以上结果继续执行，不要重复执行。"
			}]);
			return {
				kind: "success",
				text: "task resumed — deferred tools had actually completed"
			};
		}
		if (opts?.choice === "skip") {
			followup([{
				type: "text",
				text: `任务已恢复。上次暂停时以下工具未及执行（无副作用），你选择跳过：${rerun.map(describeTool).join("、")}。请直接继续后续工作。`
			}]);
			return {
				kind: "success",
				text: "task resumed — skipped deferred tools"
			};
		}
		followup([{
			type: "text",
			text: `任务已恢复。上次暂停时以下工具未及执行（无副作用），请执行这些工具调用，然后继续任务：${rerun.map(describeTool).join("、")}。`
		}]);
		return {
			kind: "success",
			text: "task resumed — re-executing deferred tools"
		};
	}
	clearPaused(state, agent.id);
	if (agent.status === "running") {
		// The task was never truly paused (tools/model kept running): just
		// clear the marker — the execution results keep flowing normally.
		return {
			kind: "success",
			text: "task resumed — the task was still actually running; execution results keep flowing"
		};
	}
	followup([{
		type: "text",
		text: "任务已恢复。请基于以上上下文（暂停点之前的完整执行记录）从暂停点继续执行，不要重复已完成的工作。"
	}]);
	return {
		kind: "success",
		text: "task resumed — continuing from the pause point"
	};
}
/** `/cancel`: stop the task NOW; report an interrupted tool's purpose and side-effect risk. */
function cancelTask(ctx, state, invocation) {
	const agent = ctx.agents.get(invocation.agent.id);
	if (agent === void 0) return {
		kind: "error",
		text: "no live agent for this session"
	};
	const current = currentState(state, agent.id);
	if (current.paused) clearPaused(state, agent.id);
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
* the store write must not interleave with the session feed, so the pause
* lands on a microtask boundary.
*/
function scheduleDeferredPause(ctx, state, sessionId, resumeContent, deferredTools) {
	queueMicrotask(() => {
		try {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) {
				state.pendingPause.delete(sessionId);
				return;
			}
			applyPauseNow(ctx, state, agent, resumeContent, { forced: false, interruptedTool: null }, deferredTools);
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
	scheduleDeferredPause(ctx, state, sessionId, pending.resumeContent ?? null, pending.deferredTools ?? null);
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
		// Reasoning completed (the LLM output finished assembling). With a
		// pending `safe wait` pause, the pause lands right AFTER this message
		// but BEFORE the model's tool calls dispatch — the kernel aborts those
		// calls as "aborted before dispatch". Record them now (from the
		// message content, so nothing is lost) for the resume flow, which
		// asks whether to re-run or skip them.
		const pending = state.pendingPause.get(sessionId);
		if (pending !== void 0 && pending.mode === "safe" && pending.reason === "wait") {
			const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
			const calls = content.filter((block) => block?.type === "tool-call").map((block) => ({
				name: block.name ?? "tool",
				arguments: block.arguments ?? null,
				callId: block.id ?? "unknown"
			}));
			if (calls.length > 0) pending.deferredTools = calls;
		}
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
* this one implementation. All state reads go through the plugin's own
* durable store, so `state()` also works for sessions with no live agent.
*/
function createTaskControlService(ctx, state) {
	const invocationFor = (sessionId) => ({
		agent: ctx.agents.get(sessionId),
		rawInput: "",
		commandId: "task-control"
	});
	const toResult = (result) => result.kind === "success"
		? { ok: true, text: result.text, ...(result.needConfirmation === true ? { needConfirmation: true } : {}) }
		: { ok: false, error: result.text, ...(result.needConfirmation === true ? { needConfirmation: true } : {}) };
	return {
		/** Pause by session id. `opts`: `{ mode: 'safe'|'force', reason: 'stop'|'wait' }` — omitted fields follow the pause-granularity settings (default safe + wait). */
		pause(sessionId, opts) {
			const agent = ctx.agents.get(sessionId);
			if (agent === void 0) return { ok: false, error: `no live agent for session "${sessionId}"` };
			return toResult(pauseTask(ctx, state, invocationFor(sessionId), opts));
		},
		/** Resume by session id. `opts`: `{ confirm: true, choice: 'rerun'|'skip' }` — confirm is required when a force-paused task has an interrupted tool; choice decides whether that tool is re-executed or skipped. */
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
		/** Read one session's task-control state: status / paused / forced / interruptedTool / resumeContent (from the durable store — works offline). */
		state(sessionId) {
			const agent = ctx.agents.get(sessionId);
			const current = currentState(state, sessionId);
			return {
				status: agent === void 0 ? "offline" : agent.status,
				paused: current.paused === true,
				forced: current.forced === true,
				interruptedTool: current.interruptedTool ?? null,
				deferredTools: current.deferredTools ?? null,
				resumeContent: current.resumeContent ?? null
			};
		}
	};
}
// ── HTTP routes (dock state + settings) ──────────────────────────────────────

/** Read a JSON request body (mirrors dsh-trace-repeat). */
function readJsonBody(req) {
	return new Promise((resolveBody, rejectBody) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			try {
				const text = Buffer.concat(chunks).toString("utf8");
				resolveBody(text.length === 0 ? {} : JSON.parse(text));
			} catch (error) {
				rejectBody(new Error(`invalid JSON body: ${String(error)}`));
			}
		});
		req.on("error", rejectBody);
	});
}
/** Send a JSON response (mirrors dsh-trace-repeat). */
function sendJson(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(payload));
}
/** `/task-control/state?session=<id>` — the dock's live pause-state source. */
function createStateHandler(ctx, state) {
	return async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", "http://localhost");
			const route = url.pathname;
			const method = req.method ?? "GET";
			if (method === "GET" && route === "/task-control/state") {
				const sessionId = url.searchParams.get("session") ?? "";
				if (sessionId.length === 0) return sendJson(res, 400, { ok: false, error: "missing session parameter" });
				const agent = ctx.agents.get(sessionId);
				const current = currentState(state, sessionId);
				return sendJson(res, 200, {
					ok: true,
					state: {
						status: agent === void 0 ? "offline" : agent.status,
						paused: current.paused === true,
						forced: current.forced === true,
						interruptedTool: current.interruptedTool ?? null,
						deferredTools: current.deferredTools ?? null,
						resumeContent: current.resumeContent ?? null
					}
				});
			}
			if (method === "GET" && route === "/task-control/settings") {
				return sendJson(res, 200, { ok: true, settings: readSettings() });
			}
			if (method === "POST" && route === "/task-control/settings") {
				const body = await readJsonBody(req);
				const current = readSettings();
				const next = {};
				if (body?.defaultMode === "force" || body?.defaultMode === "safe") next.defaultMode = body.defaultMode;
				if (body?.safeReasoning === "stop" || body?.safeReasoning === "wait") next.safeReasoning = body.safeReasoning;
				const merged = { ...current, ...next };
				writeSettings(merged);
				return sendJson(res, 200, { ok: true, settings: merged });
			}
			return sendJson(res, 404, { ok: false, error: `unknown task-control route ${method} ${route}` });
		} catch (error) {
			ctx.logger?.error?.("task-control: route error: " + String(error));
			return sendJson(res, 500, { ok: false, error: String(error) });
		}
	};
}
/**
* Register the commands, the session-event listener, the service, and the
* state/settings routes. Pause defaults come from the durable settings store
* (default safe + wait).
*/
function apply(ctx) {
	const state = {
		inFlight: new Map(),
		pendingPause: new Map(),
		cache: new Map()
	};
	ctx.commands.register({
		name: "pause",
		description: "pause the running task (safe: defers to the safe boundary; force: interrupts tools and reasoning now; wait: let reasoning finish; bare /pause follows the pause-granularity settings)",
		input: { hint: "[force|safe] [stop|wait]" },
		handler: (invocation) => {
			const tokens = (invocation.rawInput ?? "").trim().split(/\s+/).filter(Boolean);
			const opts = {};
			for (const token of tokens) {
				if (token === "force" || token === "safe") opts.mode = token;
				if (token === "stop" || token === "wait") opts.reason = token;
			}
			return pauseTask(ctx, state, invocation, opts);
		}
	});
	ctx.commands.register({
		name: "resume",
		description: "resume the paused task and continue from the pause point (a force-paused task with an interrupted tool needs `confirm`, plus `rerun`/`skip` for the tool)",
		input: { hint: "[confirm] [rerun|skip]" },
		handler: (invocation) => {
			const tokens = (invocation.rawInput ?? "").trim().split(/\s+/).filter(Boolean);
			return resumeTask(ctx, state, invocation, {
				confirm: tokens.includes("confirm"),
				choice: tokens.includes("skip") ? "skip" : "rerun"
			});
		}
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
	// Register the state/settings routes through ctx.effect so the returned
	// disposer is unwound with the fiber: a hot unload (plugin-toggle) must
	// remove the /task-control prefix from the shared host webserver, or a
	// later re-apply throws "webserver: duplicate prefix route".
	if (ctx.webServer !== void 0 && typeof ctx.webServer.register === "function") {
		ctx.effect(() => ctx.webServer.register({
			kind: "prefix",
			path: "/task-control",
			handler: createStateHandler(ctx, state)
		}));
	}
}
//#endregion
export { DEFAULT_SETTINGS, apply, clearPaused, clearStoredState, createStateHandler, createTaskControlService, currentState, encodeSessionId, inject, markPaused, name, readSettings, readStoredState, settingsFilePath, stateFilePath, stateRootDir, writeSettings, writeStoredState };
