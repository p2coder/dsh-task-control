# dsh-task-control

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English | [中文](README.md)

<p align="center">
  <img src="fig/dsh-task-control-hero-v2.png" alt="dsh-task-control whale-girl hero illustration" width="720">
</p>

Adds task **pause, resume, and cancel** controls to DSH Web. Supports safe and force pause, then resumes from the pause point without repeating completed work.

## Installation

```bash
dsh plugin --profile web add github:p2coder/dsh-task-control
```

After installation, **fully restart dsh web**, then refresh the browser.

## Quick start

Three persistent buttons appear beside the input box while a task is running:

| Button | Action | Available when |
|---|---|---|
| ⏸ Pause | Pause using the configured default | Running |
| ▶ Resume | Continue from the pause point | Paused |
| ⏹ Cancel | Stop the current turn immediately | Running or paused |

Gray buttons are unavailable; dark buttons are clickable.

![Location and states of the Pause, Resume, and Cancel buttons](fig/button%20illustrate_en.png)

## Pause modes

| Mode | Behavior | Best for |
|---|---|---|
| `safe wait` (default) | Waits for reasoning and tools to finish naturally | Long tasks, migrations, tests |
| `safe stop` | Waits for tools, but may interrupt current reasoning | Faster pauses |
| `force` | Immediately interrupts reasoning and in-flight tools | Emergencies |

Change the default under Settings → Task control. Saving applies it immediately:

![Steps for configuring task pause granularity](fig/Task%20pause%20granularity%20configuration_en.png)

## Commands

| Command | Description |
|---|---|
| `/pause` | Pause using the configured default |
| `/pause force` | Force pause |
| `/pause safe wait` | Safe pause without interrupting reasoning |
| `/pause safe stop` | Safe pause that may interrupt reasoning |
| `/resume` | Resume the task |
| `/resume confirm rerun` | Re-run an interrupted or deferred tool, then resume |
| `/resume confirm skip` | Skip that tool, then resume |
| `/cancel` | Cancel the current turn |

![Using task controls with a slash command](fig/commond%20illustrate_en.png)

## Plugin API

Get the service with `ctx.get("taskControl")`:

| API | Action |
|---|---|
| `pause(sessionId, options?)` | Pause a task |
| `resume(sessionId, options?)` | Resume a task |
| `cancel(sessionId)` | Cancel a task |
| `state(sessionId)` | Read `idle`, `running`, or `offline` status and pause details |

Pause state is stored under `~/.dsh/task-control/` and survives restarts. Tests can override the directory with `DSH_TASK_CONTROL_STATE_DIR`.

## Notes

| Situation | Behavior |
|---|---|
| Force pause | A tool may have partial side effects; choose re-run, skip, or stay paused before resuming |
| Deferred tools under `safe wait` | Resume requires choosing re-run or skip |
| New messages while paused | Start a new turn; pause controls only the current turn |
| Scheduled reminders | Due `dsh-schedule` reminders still wake the session |
| Subagents | Already-dispatched subagents are not interrupted with the parent |
| State sync | The browser polls every 2 seconds; restart dsh web after plugin changes |

## Test

```bash
node test/host-smoke.mjs
```
