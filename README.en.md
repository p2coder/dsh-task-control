# dsh-task-control

English | [中文](README.md)

Task control plugin for DSH Web: in addition to the built-in "stop/cancel", provides **pause** and **resume** controls for the conversation task, implemented as a dual-face Cordis plugin (host + browser).

## Features

| Action | Behavior |
|---|---|
| **Pause** | Two modes: **force** and **safe**. When no mode is explicitly specified, the default granularity from Settings → "Task control" applies (shipped default: `safe wait`). |
| 　· Safe pause | Never interrupts work: a running **tool** defers to the **safe boundary** (the tool finishes, `tool/result` lands, and no more in-flight tools remain) before the pause actually lands; a running **reasoning** follows the configured granularity: `wait` (default — does not interrupt the LLM; pauses after reasoning completes) or `stop` (terminates the current LLM output; the model re-reasons on resume). The trace keeps recording during the pause. |
| 　· Force pause | Immediately **cancels the running tool** and **interrupts the reasoning output**; the paused state remembers the interrupted tool (`interruptedTool`). On resume the tool's actual outcome is looked up in the session log: if it completed → continue without re-running it; if aborted/state unknown (possibly partially executed) → the user is told "tool X did not finish before the pause; it will be re-run" and chooses **re-run the tool / skip the tool / stay paused**. |
| **Resume** | Clears the paused marker and **continues from the pause point** (the session log IS the trace — nothing is re-sent from scratch and completed work is not re-run). Safe pause: continue from the pause point; if the task is still actually running when resumed (the pause never truly landed) → just clear the marker, tool/model results keep flowing normally. Force pause (with an interrupted tool): confirmation is required first, then it continues per the user's `rerun`/`skip` choice. |
| **Cancel** | **Immediately** interrupts the current turn (queue preserved) and clears the paused marker; if a tool is running it is **terminated immediately**, and the reply states the tool's **intended purpose** and **reminds to check for side effects** (files/processes/network etc.). |

> Default pause granularity: configure it in Web Settings → "Task control" (shipped default `safe` + `wait`). A bare `/pause` (and the composer pause button) follows this default; `/pause force`, `/pause safe [stop|wait]` explicitly override it. `taskControl` service: `pause(sessionId, { mode, reason })` (omitted fields also resolve from the settings), `resume(sessionId, { confirm, choice: 'rerun'|'skip' })`. After a force pause, clicking resume shows a three-choice menu (re-run the tool / skip the tool / stay paused).

**State model (Route A)**: pause/resume state is **not written into the session log** (`task-control/paused` / `task-control/resumed` are custom event types; the harness's persistence reader only accepts its built-in event-type set or events flagged `ignorable`, and writing them makes the session unloadable after a restart). State lives in the plugin's own durable store (`~/.dsh/task-control/<sessionId>.json`, atomic writes; tests can override the root with `DSH_TASK_CONTROL_STATE_DIR`), and every consumer reads through this single source:

- Browser dock: polls the host route `/task-control/state?session=<id>` (every 2 seconds);
- Browser settings page: the `/task-control/settings` route reads/writes the default pause granularity (default `safe` + `wait`), effective immediately;
- `taskControl` service `state()`: reads the store directly — **offline sessions (not loaded) still report their pause state**, and the paused state survives restarts;
- dsh-trace-repeat: reconciles its pause gate from the `taskControl` service on every session event.

Other plugins (e.g. dsh-task-batch) keep using the `taskControl` service unchanged.

## Installation

The package ships a `dsh.bundle` manifest — it activates automatically on install (no manual configuration):

```bash
# Install from GitHub
dsh plugin --profile web add github:p2coder/dsh-task-control
# Once published to npm: dsh plugin --profile web add dsh-task-control
```

After install, **fully restart dsh web** (host plugins do not hot-reload) and refresh the browser.

## Usage

1. Refresh the browser page.
2. Submit a task; while the agent is running, three icon buttons appear to the left of the send button:
   - ⏸ Pause (available while running)
   - ▶ Resume (available while paused)
   - ⏹ Cancel (available while running or paused)
3. The button group is **always visible** (it does not hide when idle); buttons disable per state: Pause/Resume gray out when idle/not paused, Cancel grays out when neither running nor paused.
4. Settings → "Task control": configure the default pause granularity (default `safe` + `wait`); bare `/pause` and the pause button follow it.

Slash commands also work in the input box: `/pause`, `/resume`, `/cancel` (results appear as ordinary command lines in the conversation).

**Pause semantics (follows the settings; shipped default safe wait)**: a bare `/pause` (and the dock pause button) without an explicit mode uses the default granularity from Settings → "Task control" (default `safe wait`: lands after reasoning/tools finish, never interrupts work). An explicit `/pause force` interrupts the current turn immediately: in-flight tools are cancelled and the LLM output is cut; the pause snapshot records the interrupted tool (`interruptedTool`); resume needs confirmation first: `/resume confirm rerun` (re-run the interrupted tool) / `/resume confirm skip` (skip it); tools that actually completed are auto-skipped, never re-run. `/pause safe [stop|wait]` explicitly selects a safe pause: `safe wait` lands after reasoning completes and before tool dispatch; the undispatched tools are recorded as `deferredTools`, and resume also asks for confirmation.

## Structure

```
dsh-task-control/
├── package.json          # declares dsh.bundle.patch + dsh.client (platform: web)
├── cordis.patch.yml      # one dual-face row: - id: task-control / name: dsh-task-control
├── lib/
│   ├── index.js          # host: /pause /resume /cancel commands + taskControl service + durable state/settings store + /task-control/state, /task-control/settings routes
│   └── client.js         # browser: composer tool-row buttons + state polling + Settings "Task control" page (__ModuleLoader__ format)
└── test/
    └── host-smoke.mjs    # host logic smoke test (node test/host-smoke.mjs)
```

## Host service (for other plugins)

The host publishes the `taskControl` service; other plugins call the same implementation by **sessionId** (the commands and buttons go through it too):

```ts
taskControl.pause(sessionId)  → { ok, text } | { ok: false, error }   // pauses per the default granularity (default safe wait) + marks paused
taskControl.resume(sessionId) → { ok, text } | { ok: false, error }   // clears the marker + continues from the pause point (does not re-send the original prompt)
taskControl.cancel(sessionId) → { ok, text } | { ok: false, error }   // interrupts the turn + clears the marker
taskControl.state(sessionId)  → { status, paused, forced, interruptedTool, deferredTools, resumeContent }  // status: idle|running|offline (offline sessions still report pause state)
```

Consumers (e.g. dsh-task-batch's "pause/resume/cancel all") read it via `ctx.get("taskControl")` — do not duplicate the implementation; this service's semantics are the single source of truth.

## Known limitations

- **New input while paused**: pause only intercepts the *current turn*, not new messages — sending is still allowed while paused (a send starts a new turn). A "pause = freeze the session" composer gate is not implemented yet.
- **Scheduled reminders**: pause does not intercept `dsh-schedule` reminder turns (they still wake up); goal auto-rounds are intercepted (see above).
- **Subagents**: pausing a parent turn does not interrupt already-dispatched subagents; their reports may arrive after resume.
- **Resume semantics**: resume = continue from the pause point (no re-sending of the original prompt, no re-running of completed work); the user chooses whether an interrupted tool is re-run (`rerun`) or skipped (`skip`). Tool side-effect state is judged by the actual result in the session log: a completed result → treated as executed; aborted/no result → state unknown, the user is warned and decides.
- **State location (Route A)**: pause state lives in the plugin's durable store, not the session log — deliberate (custom session events would make the harness refuse to load the session). Cost: the browser dock polls `/task-control/state` every 2 seconds instead of subscribing to a projection; trace-repeat's pause marker versions are written on the next session event after pause/resume, so a pure pause+resume with no events in between produces no marker version. The default pause granularity lives in `settings.json` under the same store root (default `safe` + `wait`), effective immediately without a restart.
- **safe wait + tool calls emitted by finished reasoning (deferredTools)**: applies under the default (`safe wait`) or an explicit `/pause safe wait`, landing after reasoning completes and before tool dispatch. The tool calls the model just emitted are marked `ABORTED_BEFORE_DISPATCH` by the kernel (never dispatched, no side effects) and recorded as the pause snapshot's `deferredTools`. Resume **requires confirmation** (`/resume confirm rerun` to re-run / `/resume confirm skip` to skip; tools that actually completed are auto-skipped, never re-run). If the browser dock's client bundle is not updated with `lib/client.js` (needs a dsh web restart), the dock's resume button still sends a bare `/resume` without `confirm`, and the host rejects with `needConfirmation` — type `/resume confirm rerun` manually in that case. Note: the aborted tool calls still land in the session log as failures (the kernel writes them via `appendSkippedToolCall`) — an inherent shape of the record-and-replay approach; removing the failed look entirely would require "freeze before tool dispatch" in the core agent loop (approach 2, not implemented). **A bare `/pause` follows the default granularity from the settings (shipped `safe wait`); explicit `force`/`safe` take the corresponding path.**
