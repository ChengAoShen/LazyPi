<div align="center">

# 🦥 LazyPi

**一个懒人优先、个人优先的 Pi coding-agent 配置**

[![Pi Coding Agent](https://img.shields.io/badge/Pi-coding%20agent-7c3aed.svg)](https://github.com/earendil-works/pi)
[![TypeScript](https://img.shields.io/badge/extensions-TypeScript-3178c6.svg?logo=typescript&logoColor=white)](agent/extensions)
[![Agent Tools](https://img.shields.io/badge/tools-background%20shell%20%7C%20sub--agents-blue.svg)](agent/extensions)
[![TUI](https://img.shields.io/badge/TUI-side%20chat-10b981.svg)](agent/extensions/side-chat.ts)
[![Config](https://img.shields.io/badge/config-portable-orange.svg)](agent/settings.json)

一个可迁移的 `~/.pi` 配置仓库，专注于 **更快的本地迭代**、**更少打断的 Agent 工作流**，以及一些让 Pi 更顺手的小扩展。

[**English**](README.md) | [**中文**](README_zh.md)

</div>

---

## 🧭 LazyPi 是什么？

LazyPi 是我给 [Pi coding agent](https://github.com/earendil-works/pi) 准备的个人配置层。它只版本化值得保留的部分：settings、追加系统提示词、本地 extensions；而 credentials、sessions、cache、local binaries 等机器相关内容都不会进 Git。

目标很简单：打开 Pi 就能工作。长任务可以丢到后台跑，独立分析可以交给 headless sub-agent 并发做，临时解释类问题可以在旁路窗口里问，不污染主对话。

---

## ✨ 亮点

- 🦥 **个人优先默认值** —— 支持 `exit → /quit`、`clear → /new` 这类简单命令别名。
- 🧵 **后台 shell 任务** —— 主 agent 可把长命令放到后台启动、看日志、等待完成或取消；运行中聚合到底部状态条和 `/jobs` 观察面板。
- 🤖 **简易Headless sub-agents** —— 主 agent 可并发启动只读 Pi worker，用于 research、review、planning、test analysis；运行中聚合到底部状态条和 `/jobs` 观察面板。
- 💬 **临时 side chat** —— `/side` 和 `/btw` 打开轻量 no-tools 浮层，用来解释概念和处理旁支问题。
- 📦 **可迁移配置** —— clone 到 `~/.pi`，安装扩展包，本地登录，即可恢复工作环境。

---

## 🧩 包含的扩展

| Extension                              | 用途                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `agent/extensions/command-aliases.ts`  | 把 `exit`、`clear` 这类普通输入映射到内置 slash command；以 editor wrapper 形式和其他 UI 扩展组合。 |
| `agent/extensions/background-jobs/`    | 打包后台执行能力：`bg_shell_*`、`sub_agent`、统一 footer 和 `/jobs` 观察面板。 |
| `agent/extensions/side-chat.ts`        | 提供 `/side` 和 `/btw` 临时解释窗口，不执行工具。                              |
| `agent/extensions/ssh.ts`              | 本地 SSH helper 扩展。                                                         |
| `agent/extensions/todo.ts`             | 简单 todo-list 工具。                                                          |
| `agent/extensions/ui-optimize/`        | 本地 UI 渲染优化。                                                             |

---

## 🛠️ 常用工作流

### 后台 shell

这些工具主要给主 agent 调度使用。预计会跑较久的非交互命令，主 agent 会使用后台 shell：

```text
bg_shell_start   启动长时间运行的非交互命令
bg_shell_status  查看某个 job，或列出全部 jobs
bg_shell_wait    等待 job 结束并收集最终输出
bg_shell_cancel  终止正在运行的 job
```

TUI 中运行时会在底部状态条显示后台概况；输入 `/jobs` 可打开/切换一个聚焦的右侧 overlay，查看最近任务和 tail 输出；用 `/jobs shell` 只看 shell jobs。overlay 内 `Esc`/`q` 关闭，`a/s/g/f` 切换过滤。

### Sub-agents

`sub_agent` 也是主 agent 的并发分析能力。当任务可以拆成多个独立只读子任务时，主 agent 会使用：

```text
start       启动一个 headless Pi worker
start_many  一次并发启动最多 8 个 worker
status      查看 worker 状态
wait        收集 worker 结果
cancel      停止 worker
```

Sub-agent 默认只开放只读工具：

```text
read, grep, find, ls
```

启动时使用 `--no-session --no-extensions`，避免污染主 session，也避免递归创建更多 agent。

TUI 中运行时会在底部状态条显示后台概况；输入 `/jobs agents` 可在 jobs overlay 中查看最近 worker 和 tail 输出。

### Side chat

在 TUI 模式下：

```text
/side
/btw 为什么这里要这样设计？
```

浮层内快捷键：

```text
Enter             发送
Esc / Ctrl+C      关闭
exit / quit       关闭
↑ / ↓             滚动
PageUp/PageDown   快速滚动
Home / End        跳转
```

Side chat 没有工具能力：它只负责解释、澄清和辅助思考，不执行命令，也不修改文件。

---

## 🏁 在新机器上安装

先安装 Pi，然后把仓库 clone 成 Pi 配置目录：

```bash
git clone https://github.com/ChengAoShen/LazyPi.git ~/.pi
```

启动 Pi 一次，或手动同步扩展包：

```bash
pi update --extensions
```

---

## 🏷️ Tags

`pi-coding-agent` · `ai-agent` · `coding-agent` · `typescript` · `tui` · `sub-agents` · `background-jobs` · `developer-tools` · `personal-config`
