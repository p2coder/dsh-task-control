window.__ModuleLoader__.load({
	id: "dsh-task-control",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/types/client/locales.js
		/** `task-control` namespace dictionaries. */
		const zh = {
			"group.aria": "任务控制",
			"state.paused": "任务已暂停",
			"confirm.resumeForced": "上次暂停时工具 {tool} 没有执行完成，将重新执行。请选择如何处理：",
			"confirm.resumeDeferred": "上次暂停发生在推理完成后、工具执行前，以下工具未及执行（无副作用）：{tools}。请选择如何处理：",
			"action.resumeRerun": "重新执行该工具",
			"action.resumeSkip": "跳过该工具，继续任务",
			"action.resumeKeep": "保持暂停",
			"action.pause": "暂停任务",
			"action.resume": "恢复任务",
			"action.cancel": "取消任务"
		};
		const en = {
			"group.aria": "Task control",
			"state.paused": "Task paused",
			"confirm.resumeForced": "Tool {tool} did not finish before the force pause; it will be re-run. Choose how to proceed:",
			"confirm.resumeDeferred": "The task paused after reasoning, before these tools dispatched (no side effects): {tools}. Choose how to proceed:",
			"action.resumeRerun": "Re-run this tool",
			"action.resumeSkip": "Skip this tool and continue",
			"action.resumeKeep": "Stay paused",
			"action.pause": "Pause task",
			"action.resume": "Resume task",
			"action.cancel": "Cancel task"
		};
		//#endregion
		//#region lib/types/client/TaskControlDock.js
		/**
		* Composer-row task controls. Renders next to the send/stop button:
		* pause (running), resume (paused), cancel (running or paused). All three
		* route through the host `/pause` `/resume` `/cancel` commands, whose
		* outcomes land in the transcript through the ordinary command result
		* row, so the controls stay consistent with typing the commands by hand.
		*/
		const BUTTON_STYLE = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 28,
			height: 28,
			padding: 0,
			border: "none",
			borderRadius: 8,
			background: "transparent",
			color: "var(--dsw-alias-icon-muted, currentColor)",
			cursor: "pointer",
			flex: "none"
		};
		const BUTTON_DISABLED = {
			...BUTTON_STYLE,
			opacity: 0.4,
			cursor: "default"
		};
		const GROUP_STYLE = {
			display: "inline-flex",
			alignItems: "center",
			gap: 2,
			marginRight: 4,
			position: "relative"
		};
		/** Force-pause resume menu: floating above the dock, asks the user how to treat the interrupted tool. */
		const MENU_STYLE = {
			position: "absolute",
			bottom: "calc(100% + 8px)",
			right: 0,
			zIndex: 40,
			minWidth: 240,
			padding: "8px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border, #ddd)",
			background: "var(--dsw-alias-bg, #fff)",
			color: "var(--dsw-alias-text, inherit)",
			boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
			display: "flex",
			flexDirection: "column",
			gap: 4
		};
		const MENU_TITLE_STYLE = {
			fontSize: 12,
			fontWeight: 600,
			lineHeight: 1.45,
			marginBottom: 4,
			whiteSpace: "normal"
		};
		const MENU_ITEM_STYLE = {
			display: "block",
			width: "100%",
			textAlign: "left",
			padding: "6px 8px",
			borderRadius: 6,
			border: "none",
			background: "transparent",
			color: "inherit",
			fontSize: 13,
			cursor: "pointer"
		};
		/**
		* The paused-resume choice: re-run the interrupted/deferred tool(s)
		* (default), skip them and continue, or stay paused. Rendered above the
		* dock when the user clicks resume on a force-paused task or on a
		* `safe wait`-paused task whose tool calls were aborted before dispatch.
		*/
		function ForceResumeMenu({ title, onRerun, onSkip, onKeep }) {
			return (0, react_jsx_runtime.jsx)("div", {
				style: MENU_STYLE,
				role: "menu",
				"aria-label": title,
				children: [
					(0, react_jsx_runtime.jsx)("div", {
						style: MENU_TITLE_STYLE,
						children: title
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: MENU_ITEM_STYLE,
						onClick: onRerun,
						children: t("action.resumeRerun")
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: MENU_ITEM_STYLE,
						onClick: onSkip,
						children: t("action.resumeSkip")
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: MENU_ITEM_STYLE,
						onClick: onKeep,
						children: t("action.resumeKeep")
					})
				]
			});
		}
		/** Fetch JSON from the host (same-origin). */
		const api = (path) => fetch(path).then((res) => res.json());
		/**
		* Dock adapter: reads running/paused state and routes commands.
		* Pause state comes from the host `/task-control/state` route (the
		* plugin's own durable store — task-control no longer writes custom
		* session events, so there is no projection to read), polled while the
		* composer row is mounted.
		* @param props - standard session slot props plus the injected `command` face and `sessionId`.
		*/
		function TaskControlDock({ useSession, command, t, sessionId }) {
			const running = useSession((snapshot) => snapshot.running) ?? false;
			const [paused, setPaused] = react.useState(false);
			const [forced, setForced] = react.useState(false);
			const [interruptedTool, setInterruptedTool] = react.useState(null);
			const [deferredTools, setDeferredTools] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [menuOpen, setMenuOpen] = react.useState(false);
			const refreshState = react.useCallback(() => {
				if (typeof sessionId !== "string" || sessionId.length === 0) return;
				api(`/task-control/state?session=${encodeURIComponent(sessionId)}`).then((res) => {
					if (!res.ok || res.state === void 0) return;
					setPaused(res.state.paused === true);
					setForced(res.state.forced === true);
					setInterruptedTool(res.state.interruptedTool ?? null);
					setDeferredTools(res.state.deferredTools ?? null);
				}).catch(() => {});
			}, [sessionId]);
			react.useEffect(() => { refreshState(); }, [refreshState]);
			react.useEffect(() => {
				const timer = window.setInterval(refreshState, 2000);
				return () => window.clearInterval(timer);
			}, [refreshState]);
			const run = react.useCallback(async (line) => {
				if (busy) return;
				setBusy(true);
				try {
					await command(line);
				} finally {
					setBusy(false);
				}
			}, [busy, command]);
			const resume = () => {
				if ((forced && interruptedTool !== null) || (Array.isArray(deferredTools) && deferredTools.length > 0)) {
					// A tool was actually interrupted (forced) or deferred
					// (`safe wait`, aborted before dispatch): the host needs a
					// decision, so show the menu. A forced pause with NO
					// interrupted tool resumes directly — no menu.
					setMenuOpen(true);
					return;
				}
				run("/resume");
			};
			// Always-visible controls: the task may leave `running` while a
			// paused/interrupted state still needs a recovery entry point (e.g.
			// a tool aborted by a force pause lands the agent idle), so the
			// button group stays mounted and disables per state instead of
			// unmounting when idle.
			const pauseDisabled = busy || !running || paused;
			const resumeDisabled = busy || !paused;
			const cancelDisabled = busy || (!running && !paused);
			return (0, react_jsx_runtime.jsx)("div", {
				style: GROUP_STYLE,
				"data-task-control": "",
				role: "group",
				"aria-label": t("group.aria"),
				title: paused ? t("state.paused") : void 0,
				children: [
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
						label: t("action.pause"),
						side: "top",
						delayMs: 500,
						children: (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: pauseDisabled ? BUTTON_DISABLED : BUTTON_STYLE,
							disabled: pauseDisabled,
							onClick: () => {
								run("/pause");
							},
							"aria-label": t("action.pause"),
							children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPauseOutline16, { size: 14 })
						})
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
						label: t("action.resume"),
						side: "top",
						delayMs: 500,
						children: (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: resumeDisabled ? BUTTON_DISABLED : BUTTON_STYLE,
							disabled: resumeDisabled,
							onClick: () => {
								resume();
							},
							"aria-label": t("action.resume"),
							children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlayOutline16, { size: 14 })
						})
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
						label: t("action.cancel"),
						side: "top",
						delayMs: 500,
						children: (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: cancelDisabled ? BUTTON_DISABLED : BUTTON_STYLE,
							disabled: cancelDisabled,
							onClick: () => {
								run("/cancel");
							},
							"aria-label": t("action.cancel"),
							children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconStopFill16, { size: 14 })
						})
					}),
					menuOpen && ((forced && interruptedTool !== null) || (Array.isArray(deferredTools) && deferredTools.length > 0)) ? (0, react_jsx_runtime.jsx)(ForceResumeMenu, {
						title: forced && interruptedTool !== null
							? t("confirm.resumeForced", { tool: interruptedTool?.name ?? "未知工具" })
							: t("confirm.resumeDeferred", {
								tools: (Array.isArray(deferredTools) ? deferredTools : []).map((tool) => tool?.name ?? "未知工具").join("、")
							}),
						onRerun: () => {
							setMenuOpen(false);
							run("/resume confirm rerun");
						},
						onSkip: () => {
							setMenuOpen(false);
							run("/resume confirm skip");
						},
						onKeep: () => setMenuOpen(false)
					}) : null
				]
			});
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Dictionary namespace owned by this plugin. */
		const NS = "task-control";
		/** Required services for the dock entry and the command route. */
		const inject = [
			"slots",
			"sessions",
			"locale"
		];
		/**
		* Client plugin body: register the task-control dock entry in the
		* composer tool row (`conversation.input.right`).
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const sessions = ctx.sessions;
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "task-control: dictionaries");
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "task-control",
				order: 10,
				locale: NS,
				inject: (sessionId) => ({
					sessionId,
					command: async (line) => {
						const session = sessions.binding(sessionId)?.session;
						if (session === void 0) return {
							ok: false,
							error: {
								code: "session-not-found",
								message: `session "${sessionId}" resolved no binding`,
								details: {}
							}
						};
						return await session.command(line);
					}
				})
			}, TaskControlDock));
		}
		//#endregion
		exports.TaskControlDock = TaskControlDock;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
