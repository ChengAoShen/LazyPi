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
- 🚫 **无 permission gate** —— 不再额外拦截 bash 命令，本地行为更直接、更可预期。
- 🧵 **后台 shell 任务** —— 长命令可以后台启动、看日志、等待完成或取消，不阻塞主 agent。
- 🤖 **Headless sub-agents** —— 并发启动只读 Pi worker，用于 research、review、planning、test analysis。
- 💬 **临时 side chat** —— `/side` 和 `/btw` 打开轻量 no-tools 浮层，用来解释概念和处理旁支问题。
- 📦 **可迁移配置** —— clone 到 `~/.pi`，安装扩展包，本地登录，即可恢复工作环境。

---

## 🧩 包含的扩展

| Extension | 用途 |
| --- | --- |
| `agent/extensions/command-aliases.ts` | 把 `exit`、`clear` 这类普通输入映射到内置 slash command。 |
| `agent/extensions/background-shell.ts` | 提供 `bg_shell_start`、`bg_shell_status`、`bg_shell_wait`、`bg_shell_cancel`。 |
| `agent/extensions/sub-agents.ts` | 提供 `sub_agent`，用于启动、等待、查看和取消 headless Pi worker。 |
| `agent/extensions/side-chat.ts` | 提供 `/side` 和 `/btw` 临时解释窗口，不执行工具。 |
| `agent/extensions/ssh.ts` | 本地 SSH helper 扩展。 |
| `agent/extensions/todo.ts` | 简单 todo-list 工具。 |
| `agent/extensions/ui-optimize/` | 本地 UI 渲染优化。 |

---

## 🛠️ 常用工作流

### 后台 shell

预计会跑较久的非交互命令，用后台 shell 工具：

```text
bg_shell_start   启动长时间运行的非交互命令
bg_shell_status  查看某个 job，或列出全部 jobs
bg_shell_wait    等待 job 结束并收集最终输出
bg_shell_cancel  终止正在运行的 job
```

### Sub-agents

当任务可以拆成多个独立只读子任务时，用 `sub_agent`：

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

Side chat 故意没有工具能力：它只负责解释、澄清和辅助思考，不执行命令，也不修改文件。

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

如果包没有自动安装，可以手动安装需要的包：

```bash
pi install npm:pi-web-access
```

然后在这台机器上单独配置 credentials，例如 `pi login`、`/login` 或环境变量。

---

## 🔒 不会提交的内容

LazyPi 会刻意排除本地数据和敏感信息：

| Path | 原因 |
| --- | --- |
| `agent/auth.json` | credentials / login data。 |
| `agent/sessions/` | 对话历史。 |
| `agent/npm/` | 已安装包缓存和 `node_modules`。 |
| `agent/bin/` | 本地二进制文件。 |
| `agent/tmp/` | 运行时日志、prompt、临时任务输出。 |

> 这个仓库可能包含个人工作流偏好，本地 extensions 也拥有完整系统权限。除非你已经仔细 review，否则应把它当作个人配置仓库。

---

## 🏷️ Tags

`pi-coding-agent` · `ai-agent` · `coding-agent` · `typescript` · `tui` · `sub-agents` · `background-jobs` · `developer-tools` · `personal-config`
