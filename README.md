# dsh-task-control

任务控制插件（DSH Web）：提交对话任务后，除了现有的"停止/取消"，还提供 **暂停任务**、**恢复任务** 两个控制，以 Cordis 双面插件（宿主端 + 浏览器端）实现。

## 功能

| 操作 | 行为 |
|---|---|
| **暂停** (Pause) | 两种模式：**安全暂停**（默认）与**强制暂停**。 |
| 　· 安全暂停 | 从不中断工作：有**工具在执行** → 延迟到**安全界限**（工具执行完毕、`tool/result` 落地且无更多 in-flight 工具）才真正暂停；有**推理在执行** → 按配置粒度：`stop`（默认，终止当前 LLM 输出，恢复时重新推理）或 `wait`（不中断 LLM，等推理完成后再暂停）。期间 trace 持续记录。 |
| 　· 强制暂停 | 立即**取消正在执行的工具**、**中断推理输出**；暂停状态记住被中断的工具（`interruptedTool`），**恢复时要求用户确认**（工具可能已部分执行/产生副作用），确认后**从被中断的工具调用重新执行**。 |
| **恢复** (Resume) | 清除暂停标记，重发记住的提示词。普通暂停：从历史继续；**强制暂停**：必须先确认（回复会点名被中断的工具并说明其目的），确认后 followup 指示 agent 从该工具调用重新执行。 |
| **取消** (Cancel) | **立即**中断当前回合（保留输入队列），清除暂停标记；若有工具在执行，**立即终止**并在回复中说明其**预期目的**、**提醒检查副作用**（文件/进程/网络等）。 |

> 暂停模式选择：命令 `/pause`（安全）或 `/pause force`（强制）；`/pause wait` 表示推理粒度 wait。`taskControl` 服务：`pause(sessionId, { mode, reason })`、`resume(sessionId, { confirm })`。浏览器按钮默认安全暂停；强制暂停后恢复按钮会先弹确认。

暂停/恢复状态通过会话日志中的 `task-control/paused` / `task-control/resumed` 事件**持久化**，并折叠为 `taskControl` session projection 供界面实时读取（刷新/重连后状态一致）。

## 安装

插件包位于本目录（`dsh-task-control`），已安装到 web profile：

```bash
# 需要 pnpm（npm install -g pnpm）
dsh plugin --profile web add /Users/wx/Desktop/DSH/dsh-task-control
```

安装后**重启 dsh web 服务**生效（宿主插件不支持运行时热装）：

```bash
# 找到并结束占用 3080 的进程后
cd /Users/wx && dsh web
```

## 使用

1. 刷新浏览器（`http://127.0.0.1:3080`）。
2. 提交一个任务，agent 运行期间，发送按钮左侧会出现三个图标按钮：
   - ⏸ 暂停（运行中可用）
   - ▶ 恢复（已暂停时可用）
   - ⏹ 取消（运行中或已暂停时可用）
3. 空闲时按钮组自动隐藏。

也可以直接在输入框输入斜杠命令：`/pause`、`/resume`、`/cancel`（命令结果会以普通命令行形式出现在对话中）。

## 结构

```
dsh-task-control/
├── package.json          # dsh.bundle.patch + dsh.client(platform: web) 声明
├── cordis.patch.yml      # 一个双面行：- id: task-control / name: dsh-task-control
├── lib/
│   ├── index.js          # 宿主端：/pause /resume /cancel 命令 + taskControl projection
│   └── client.js         # 浏览器端：composer 工具行按钮组（__ModuleLoader__ 格式）
└── test/
    └── host-smoke.mjs    # 宿主端逻辑冒烟测试（node test/host-smoke.mjs）
```

## 宿主服务（供其他插件调用）

宿主端发布 `taskControl` 服务，其他插件可按 **sessionId** 调用同一套实现（命令与按钮内部也走它）：

```ts
taskControl.pause(sessionId)  → { ok, text } | { ok: false, error }   // 中断当前回合 + 标记暂停
taskControl.resume(sessionId) → { ok, text } | { ok: false, error }   // 清除标记 + 重发记住的提示词
taskControl.cancel(sessionId) → { ok, text } | { ok: false, error }   // 中断回合 + 清除标记
taskControl.state(sessionId)  → { status, paused, resumeContent }     // status: idle|running|offline
```

消费方（例如 `dsh-task-batch` 的「全部暂停/恢复/取消」）用 `ctx.get("taskControl")` 读取，不要复制实现——本服务的语义即唯一事实来源。

## 已知限制

- **暂停期间的新输入**：暂停只拦截"当前回合"，不拦截新消息——界面在暂停态仍允许发送（发送会开启新回合）。如需"暂停=彻底冻结会话"，需要额外的 composer 提交闸门，暂未实现。
- **schedule 定时提醒**：暂停不会拦截 `dsh-schedule` 到期的提醒回合（会照常唤醒）；goal 自动轮次会被拦截（见上）。
- **子代理**：暂停父回合不会中断已派发的子代理，其汇报可能在恢复后到达。
- **恢复语义**：恢复 = 以原始提示词重开一个回合（模型从历史中继续），不是从中断的中间步骤原地续跑。
