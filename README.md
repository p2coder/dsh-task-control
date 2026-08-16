# dsh-task-control

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](README.en.md) | 中文

<p align="center">
  <img src="fig/dsh-task-control-hero-v2.png" alt="dsh-task-control 鲸鱼娘宣传图" width="720">
</p>

为 DSH Web 增加任务**暂停、恢复和取消**能力。支持安全暂停与强制暂停，恢复时从暂停点继续，不重复已完成的工作。

## 安装

```bash
dsh plugin --profile web add github:p2coder/dsh-task-control
```

安装后请**完整重启 dsh web**，然后刷新浏览器页面。

## 快速使用

任务运行时，输入框旁会显示三个常驻按钮：

| 按钮 | 作用 | 可用状态 |
|---|---|---|
| ⏸ 暂停 | 按默认粒度暂停任务 | 运行中 |
| ▶ 恢复 | 从暂停点继续 | 已暂停 |
| ⏹ 取消 | 立即终止当前回合 | 运行中或已暂停 |

灰色按钮表示当前不可用，黑色按钮表示可点击。

![暂停、恢复、取消按钮的位置与状态](fig/button%20illustrate.png)

## 暂停模式

| 模式 | 行为 | 适合场景 |
|---|---|---|
| `safe wait`（默认） | 等待推理和工具自然完成后暂停 | 长任务、迁移、测试 |
| `safe stop` | 工具完成后暂停；可中断当前推理 | 希望更快暂停 |
| `force` | 立即中断推理及在途工具 | 紧急停止 |

在「设置 → 任务控制」中修改默认模式，保存后立即生效：

![任务暂停粒度配置步骤](fig/Task%20pause%20granularity%20configuration.png)

## 命令

| 命令 | 说明 |
|---|---|
| `/pause` | 按设置中的默认模式暂停 |
| `/pause force` | 强制暂停 |
| `/pause safe wait` | 安全暂停，不中断推理 |
| `/pause safe stop` | 安全暂停，可中断推理 |
| `/resume` | 恢复任务 |
| `/resume confirm rerun` | 重新执行被中断或未派发的工具后恢复 |
| `/resume confirm skip` | 跳过该工具后恢复 |
| `/cancel` | 取消当前回合 |

![通过斜杠命令调用任务控制](fig/commond%20illustrate.png)

## 供其他插件调用

通过 `ctx.get("taskControl")` 获取服务：

| API | 作用 |
|---|---|
| `pause(sessionId, options?)` | 暂停任务 |
| `resume(sessionId, options?)` | 恢复任务 |
| `cancel(sessionId)` | 取消任务 |
| `state(sessionId)` | 查询 `idle`、`running` 或 `offline` 状态及暂停信息 |

暂停状态保存在 `~/.dsh/task-control/`，重启后不会丢失。测试时可用 `DSH_TASK_CONTROL_STATE_DIR` 修改存储目录。

## 注意事项

| 情况 | 说明 |
|---|---|
| 强制暂停 | 工具可能已产生部分副作用；恢复前可选择重新执行、跳过或保持暂停 |
| `safe wait` 的未派发工具 | 恢复时需要选择重新执行或跳过 |
| 暂停期间发送新消息 | 会开启新回合；暂停只控制当前回合 |
| 定时提醒 | `dsh-schedule` 到期后仍会唤醒 |
| 子代理 | 已派发的子代理不会被父任务暂停 |
| 状态同步 | 浏览器每 2 秒轮询一次，修改插件后需重启 dsh web |

## 测试

```bash
node test/host-smoke.mjs
```
