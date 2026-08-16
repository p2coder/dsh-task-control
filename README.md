# dsh-task-control

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](README.en.md) | 中文

任务控制插件（DSH Web）：提交对话任务后，除了现有的"停止/取消"，还提供 **暂停任务**、**恢复任务** 两个控制，以 Cordis 双面插件（宿主端 + 浏览器端）实现。

## 功能

| 操作 | 行为 |
|---|---|
| **暂停** (Pause) | 两种模式：**强制暂停**与**安全暂停**；未显式指定时按设置 →「任务控制」中的默认粒度执行（出厂默认 `safe wait`）。 |
| 　· 安全暂停 | 从不中断工作：有**工具在执行** → 延迟到**安全界限**（工具执行完毕、`tool/result` 落地且无更多 in-flight 工具）才真正暂停；有**推理在执行** → 按设置中的推理粒度：`wait`（默认，不中断 LLM，等推理完成后再暂停）或 `stop`（终止当前 LLM 输出，恢复时重新推理）。期间 trace 持续记录。 |
| 　· 强制暂停 | 立即**取消正在执行的工具**、**中断推理输出**；暂停状态记住被中断的工具（`interruptedTool`）。**恢复时先查该工具在会话日志中的实际结果**：已执行完成 → 直接继续不重跑；被中止/状态未知（可能部分执行）→ 提醒用户"上次暂停时 xxx 工具没有执行完成，将重新执行"，由用户选择 **重新执行该工具 / 跳过该工具 / 保持暂停**。 |
| **恢复** (Resume) | 清除暂停标记，**从暂停点继续执行**（会话日志即 trace，不重发原始提示词、不重跑已完成工作）。安全暂停：从暂停点继续；若恢复时任务实际仍在运行（暂停未真正落地）→ 仅清除标记，期间工具/模型执行结果正常显示。强制暂停（有被中断工具）：必须先确认，用户选择 `rerun`/`skip` 后按选择继续。 |
| **取消** (Cancel) | **立即**中断当前回合（保留输入队列），清除暂停标记；若有工具在执行，**立即终止**并在回复中说明其**预期目的**、**提醒检查副作用**（文件/进程/网络等）。 |

> 暂停粒度默认值：在 Web 设置 →「任务控制」中配置（出厂默认 `safe` + `wait`）。命令 `/pause`（及输入区暂停按钮）未显式指定模式时按此默认执行；`/pause force`、`/pause safe [stop|wait]` 显式覆盖。`taskControl` 服务：`pause(sessionId, { mode, reason })`（缺省字段同样按设置解析）、`resume(sessionId, { confirm, choice: 'rerun'|'skip' })`。强制暂停后点恢复会弹出三选菜单（重新执行 / 跳过该工具 / 保持暂停）。

**状态模型（Route A）**：暂停/恢复状态**不再写入会话日志**（`task-control/paused` / `task-control/resumed` 是自定义事件类型，harness 的持久化读取器只认内置事件类型清单或带 `ignorable` 标记的事件，写进去会导致会话在重启后无法加载）。状态改由插件自己的持久化 store 保存（`~/.dsh/task-control/<sessionId>.json`，原子写；测试可用 `DSH_TASK_CONTROL_STATE_DIR` 覆盖目录），所有读取方统一走这一个数据源：

- 浏览器 dock：轮询宿主路由 `/task-control/state?session=<id>`（每 2 秒）；
- 浏览器设置页：`/task-control/settings` 路由读写暂停粒度默认值（默认 `safe` + `wait`），修改后立即生效；
- `taskControl` 服务 `state()`：直接读 store，**离线会话（未加载）也能返回暂停状态**，重启后暂停态不丢；
- dsh-trace-repeat：在每个会话事件上通过 `taskControl` 服务对账暂停门控。

task-batch 等其他插件继续用 `taskControl` 服务，无需改动。

## 安装

包内已含 `dsh.bundle` manifest，安装后自动激活（无需手动修改任何配置）：

```bash
# 从 GitHub 安装
dsh plugin --profile web add github:p2coder/dsh-task-control
# 发布 npm 后亦可：dsh plugin --profile web add dsh-task-control
```

安装后**完整重启 dsh web**（宿主插件不支持运行时热装），并在浏览器中刷新页面。

## 使用

1. 刷新浏览器页面。
2. 提交一个任务，agent 运行期间，发送按钮左侧会出现三个图标按钮：
   - ⏸ 暂停（运行中可用）
   - ▶ 恢复（已暂停时可用）
   - ⏹ 取消（运行中或已暂停时可用）
3. 按钮组**常驻**（不随空闲隐藏），仅按状态禁用：空闲/无暂停时暂停与恢复按钮变灰、取消按钮在既非运行也非暂停时变灰。

   下图标出了输入框旁的任务控制按钮；从左到右依次为**暂停、恢复、取消**，灰色表示当前不可点击，黑色表示可点击。

   ![暂停、恢复、取消按钮的位置与状态说明](fig/button%20illustrate.png)

4. 设置 →「任务控制」：配置默认暂停粒度（默认 `safe` + `wait`），裸 `/pause` 与暂停按钮按此执行。

   进入左下角「设置」→「任务控制」，选择默认暂停模式和安全暂停的推理粒度，修改后点击「保存」即可生效。

   ![任务暂停粒度配置步骤](fig/Task%20pause%20granularity%20configuration.png)

也可以直接在输入框输入斜杠命令：`/pause`、`/resume`、`/cancel`（命令结果会以普通命令行形式出现在对话中）。

输入 `/pause` 时也可以显式指定暂停方式，例如 `/pause force` 或 `/pause safe wait`；输入框会提示可用参数：

![通过斜杠命令调用任务控制](fig/commond%20illustrate.png)

**暂停语义（默认跟随设置，出厂为 safe wait）**：`/pause`（及 dock 暂停按钮）未显式指定模式时，按设置 →「任务控制」中的默认粒度执行（默认 `safe wait`：等推理/工具完成后才落地，不中断工作）。显式 `/pause force` 立即中断当前回合：在途工具被取消、LLM 输出被切断，暂停快照记录被中断的工具（`interruptedTool`）；恢复时需先确认：`/resume confirm rerun`（重新执行被中断的工具）/ `/resume confirm skip`（跳过该工具）；工具实际已完成的自动跳过、绝不重跑。`/pause safe [stop|wait]` 显式指定安全暂停：`safe wait` 落在推理完成后、工具派发前，未派发的工具记录为 `deferredTools`，恢复同样需确认。

## 结构

```
dsh-task-control/
├── package.json          # dsh.bundle.patch + dsh.client(platform: web) 声明
├── cordis.patch.yml      # 一个双面行：- id: task-control / name: dsh-task-control
├── lib/
│   ├── index.js          # 宿主端：/pause /resume /cancel 命令 + taskControl 服务 + 持久化状态/设置 store + /task-control/state、/task-control/settings 路由
│   └── client.js         # 浏览器端：composer 工具行按钮组 + 状态轮询 + 设置页「任务控制」面板（__ModuleLoader__ 格式）
└── test/
    └── host-smoke.mjs    # 宿主端逻辑冒烟测试（node test/host-smoke.mjs）
```

## 宿主服务（供其他插件调用）

宿主端发布 `taskControl` 服务，其他插件可按 **sessionId** 调用同一套实现（命令与按钮内部也走它）：

```ts
taskControl.pause(sessionId)  → { ok, text } | { ok: false, error }   // 按设置默认粒度暂停（默认 safe wait）+ 标记暂停
taskControl.resume(sessionId) → { ok, text } | { ok: false, error }   // 清除标记 + 从暂停点继续（不重发原始提示词）
taskControl.cancel(sessionId) → { ok, text } | { ok: false, error }   // 中断回合 + 清除标记
taskControl.state(sessionId)  → { status, paused, forced, interruptedTool, deferredTools, resumeContent }  // status: idle|running|offline（离线也能读暂停态）
```

消费方（例如 `dsh-task-batch` 的「全部暂停/恢复/取消」）用 `ctx.get("taskControl")` 读取，不要复制实现——本服务的语义即唯一事实来源。

## 已知限制

- **暂停期间的新输入**：暂停只拦截"当前回合"，不拦截新消息——界面在暂停态仍允许发送（发送会开启新回合）。如需"暂停=彻底冻结会话"，需要额外的 composer 提交闸门，暂未实现。
- **schedule 定时提醒**：暂停不会拦截 `dsh-schedule` 到期的提醒回合（会照常唤醒）；goal 自动轮次会被拦截（见上）。
- **子代理**：暂停父回合不会中断已派发的子代理，其汇报可能在恢复后到达。
- **恢复语义**：恢复 = 从暂停点继续执行（不重发原始提示词、不重跑已完成工作）；被强制暂停中断的工具由用户选择重新执行（`rerun`）或跳过（`skip`）。工具的副作用状态按会话日志中的实际结果判断：有完成结果 → 视为已执行；中止/无结果 → 状态未知，提醒用户后由用户决定。
- **状态位置（Route A）**：暂停状态在插件的持久化 store 里，不在会话日志里——这是有意为之（自定义会话事件会让 harness 拒绝加载该会话）。代价：浏览器 dock 靠 2 秒轮询 `/task-control/state` 获取状态，而非投影订阅；trace-repeat 的暂停标记版本在「暂停/恢复后的下一个会话事件」时写入，纯暂停+恢复且中间无任何事件时不会产生标记版本。暂停粒度默认值存于同一 store 根的 `settings.json`（默认 `safe` + `wait`），修改后立即生效、无需重启。
- **safe wait + 推理输出工具调用（deferredTools）**：在默认（`safe wait`）或显式 `/pause safe wait` 时生效，落在推理完成后、工具派发前。此时模型刚输出的工具调用会被内核标记为 `ABORTED_BEFORE_DISPATCH`（未派发、无副作用），并记录为暂停快照的 `deferredTools`。恢复时**必须先确认**（`/resume confirm rerun` 重新执行 / `/resume confirm skip` 跳过；工具实际已完成的自动跳过，绝不重跑）。若浏览器 dock 的 client bundle 未随 `lib/client.js` 更新（需重启 dsh web 生效），dock 的恢复按钮仍会直接发不带 `confirm` 的 `/resume`，host 返回 `needConfirmation` 拒绝——此时请手动输入 `/resume confirm rerun`。注意：这些被 abort 的工具调用仍会以失败记录留在会话日志中（内核 `appendSkippedToolCall` 写入），这是方案一（记录+重放）的固有形态；如要彻底消除失败观感需在核心 agent-loop 实现"工具派发前冻结"（方案二，未实施）。**裸 `/pause` 跟随设置中的默认粒度（出厂 `safe wait`），显式 `force`/`safe` 才走对应路径**。
