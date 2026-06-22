<div align="center">

# 🦥 LazyPi

**A lazy, personal-first Pi coding-agent setup**

[![Pi Coding Agent](https://img.shields.io/badge/Pi-coding%20agent-7c3aed.svg)](https://github.com/earendil-works/pi)
[![TypeScript](https://img.shields.io/badge/extensions-TypeScript-3178c6.svg?logo=typescript&logoColor=white)](agent/extensions)
[![Agent Tools](https://img.shields.io/badge/tools-background%20shell%20%7C%20sub--agents-blue.svg)](agent/extensions)
[![TUI](https://img.shields.io/badge/TUI-side%20chat-10b981.svg)](agent/extensions/side-chat.ts)
[![Config](https://img.shields.io/badge/config-portable-orange.svg)](agent/settings.json)

A portable `~/.pi` configuration focused on **fast local iteration**, **low-friction agent workflows**, and **small personal extensions** that make Pi feel calmer and more capable.

[**English**](README.md) | [**中文**](README_zh.md)

</div>

---

## 🧭 What is LazyPi?

LazyPi is my portable configuration layer for the [Pi coding agent](https://github.com/earendil-works/pi). It keeps the parts worth versioning — settings, system instructions, and local extensions — while leaving credentials, sessions, caches, and local binaries out of Git.

The goal is simple: open Pi and work. Long commands can run in the background, independent analysis can be delegated to headless sub-agents, and quick side questions can be asked without polluting the main thread.

---

## ✨ Highlights

- 🦥 **Personal-first defaults** — simple command aliases such as `exit → /quit` and `clear → /new`.
- 🧵 **Background shell jobs** — the main agent can start long-running commands, inspect logs, wait for completion, or cancel without blocking; running jobs aggregate in the footer and `/jobs` panel.
- 🤖 **Simple headless sub-agents** — the main agent can launch read-only Pi workers in parallel for research, review, planning, and test analysis; running workers aggregate in the footer and `/jobs` panel.
- 💬 **Ephemeral side chat** — `/side` and `/btw` open a lightweight no-tools overlay for explanations and side questions.
- 📦 **Portable config** — clone into `~/.pi`, install extension packages, log in locally, and restore the working environment.

---

## 🧩 Included extensions

| Extension | Purpose |
| --- | --- |
| `agent/extensions/command-aliases.ts` | Maps bare editor input like `exit` and `clear` to built-in slash commands, installed as a composable editor wrapper. |
| `agent/extensions/background-jobs/` | Bundles background execution: `bg_shell_*`, `sub_agent`, unified footer sync, and the `/jobs` observation panel. |
| `agent/extensions/side-chat.ts` | Adds `/side` and `/btw`, a temporary explanatory overlay with no tool execution. |
| `agent/extensions/ssh.ts` | Local SSH helper extension. |
| `agent/extensions/todo.ts` | Simple todo-list tool. |
| `agent/extensions/ui-optimize/` | Local UI rendering tweaks. |

---

## 🛠️ Workflow shortcuts

### Background shell

These tools are primarily for the main agent to schedule work. For non-interactive commands expected to take more than a few seconds, the main agent can use background shell jobs:

```text
bg_shell_start   start a long-running non-interactive command
bg_shell_status  inspect one job, or list all jobs
bg_shell_wait    wait for a job and collect final output
bg_shell_cancel  terminate a running job
```

In TUI mode, background work appears in the footer. Use `/jobs` to open/toggle a focused right-side overlay with recent jobs and tail output; use `/jobs shell` to filter shell jobs. Inside the overlay, `Esc`/`q` closes it and `a/s/g/f` switches filters.

### Sub-agents

`sub_agent` is also a main-agent concurrency primitive. The main agent can use it when a task can be split into independent read-only work:

```text
start       start one headless Pi worker
start_many  start up to 8 workers concurrently
status      inspect worker status
wait        collect worker results
cancel      stop workers
```

Sub-agents default to read-only tools:

```text
read, grep, find, ls
```

They are started with `--no-session --no-extensions` to avoid polluting the main session or recursively creating more agents.

In TUI mode, background work appears in the footer. Use `/jobs agents` to inspect recent workers and tail output in the focused jobs overlay.

### Side chat

In TUI mode:

```text
/side
/btw why is this implementation structured this way?
```

Inside the overlay:

```text
Enter             send
Esc / Ctrl+C      close
exit / quit       close
↑ / ↓             scroll
PageUp/PageDown   fast scroll
Home / End        jump
```

The side chat is tool-less: it explains, clarifies, and thinks with you, but it does not execute commands or modify files.

---

## 🏁 Install on another machine

Install Pi first, then clone this repository as your Pi config directory:

```bash
git clone https://github.com/ChengAoShen/LazyPi.git ~/.pi
```

Start Pi once, or sync extension packages explicitly:

```bash
pi update --extensions
```

---

## 🏷️ Tags

`pi-coding-agent` · `ai-agent` · `coding-agent` · `typescript` · `tui` · `sub-agents` · `background-jobs` · `developer-tools` · `personal-config`
