# Local Extensions

This directory is auto-discovered by Pi from `~/.pi/agent/extensions`.

## Layout

| Path | Role | UI surface |
| --- | --- | --- |
| `background-jobs/` | Bundled background execution plugin: long shell jobs, headless sub-agents, shared monitor. | Agent-facing tools plus one unified `/jobs` observation panel. |
| `shared/` | Shared local helpers for editor wrapping and shell/job formatting. | Not auto-loaded; imported by other extensions. |
| `command-aliases.ts` | Maps bare editor input such as `exit` and `clear` to slash commands. | Editor wrapper; composes with other editor extensions. |
| `ui-optimize/` | Markdown polish, compact collapsed tool/thinking groups, image-token paste workflow. | Editor wrapper, renderer patches. |
| `side-chat.ts` | Tool-less explanatory side chat. | `/side` and `/btw` right-side overlay. |
| `todo.ts` | Session-branch-aware todo tool. | `/todos` TUI list. |
| `ssh.ts` | Optional SSH-backed read/write/edit/bash tools via `--ssh`. | Footer SSH status when enabled. |

## Background jobs plugin

`background-jobs/` keeps user-facing controls separate from agent-facing execution:

- `background-shell.ts` registers `bg_shell_start`, `bg_shell_status`, `bg_shell_wait`, and `bg_shell_cancel` for the main agent.
- `sub-agents.ts` registers `sub_agent` for parallel headless Pi workers.
- `job-monitor.ts` aggregates both sources into one footer status and one focused right-side overlay.
- `index.ts` wires the plugin together.

The user should normally ask for outcomes; the main agent decides when to start/wait/cancel background work. User-visible commands are for observation:

```text
/jobs          open/toggle all background work
/jobs shell    open shell jobs
/jobs agents   open sub-agent jobs
/jobs failed   open failed/timed-out jobs
/jobs close    close the jobs overlay
/jobs clear    acknowledge failed/timed-out footer warnings

Inside the overlay: `Esc`/`q` closes it, `↑↓` scrolls, `a/s/g/f` switches filters.
```

## UI conventions

- Session-scoped background work should register with `createJobsMonitor()` from `background-jobs/job-monitor.ts` instead of hand-rolling footer/widget logic.
- Persistent state goes into footer statuses via stable keys, e.g. `background-jobs`, `ssh`.
- Temporary detail views can use focused overlays (`ctx.ui.custom(..., { overlay: true })`) when they should own input and close with `Esc`.
- Editor customizations should wrap `ctx.ui.getEditorComponent()` instead of replacing it, preferably through `shared/editor-wrapper.ts`, so aliases, image paste, and future editor features can compose.
- Long-running local processes are session-scoped and are cancelled on `session_shutdown`.

After editing extensions, run `/reload`. If prototype patches in `ui-optimize/` look stale, restart Pi for a clean process.
