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
			"action.pause": "暂停任务",
			"action.resume": "恢复任务",
			"action.cancel": "取消任务"
		};
		const en = {
			"group.aria": "Task control",
			"state.paused": "Task paused",
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
			marginRight: 4
		};
		/**
		* Dock adapter: reads running/paused state and routes commands.
		* @param props - standard session slot props plus the injected `command` face.
		*/
		function TaskControlDock({ useSession, useProjection, command, t }) {
			const running = useSession((snapshot) => snapshot.running) ?? false;
			const projection = useProjection("taskControl");
			const paused = projection === void 0 || projection === null ? false : projection.paused === true;
			const [busy, setBusy] = react.useState(false);
			const run = react.useCallback(async (line) => {
				if (busy) return;
				setBusy(true);
				try {
					await command(line);
				} finally {
					setBusy(false);
				}
			}, [busy, command]);
			// Nothing to control: the composer tool row stays clean while idle.
			if (!running && !paused) return null;
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
								run("/resume");
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
					})
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
