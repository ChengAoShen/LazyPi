# Background Jobs

A bundled Pi extension for background execution used by the main agent.

## Responsibilities

- `background-shell.ts`: long-running non-interactive shell commands via `bg_shell_*` tools.
- `sub-agents.ts`: parallel headless Pi workers via the `sub_agent` tool.
- `job-monitor.ts`: shared footer status and focused right-side jobs overlay.
- `index.ts`: plugin entry point.

## Design

The tools are agent-facing infrastructure. Users should normally ask the main agent for an outcome, while the main agent starts, waits for, checks, and cancels background work as needed.

The user-facing UI is observational:

```text
/jobs          open/toggle all background work
/jobs shell    show shell jobs
/jobs agents   show sub-agent jobs
/jobs failed   show failed/timed-out jobs
/jobs close    close the jobs overlay
/jobs clear    acknowledge failed/timed-out footer warnings
```

Inside the overlay, `Esc`/`q` closes it, `↑↓` scrolls, and `a/s/g/f` switches filters.

The footer uses one aggregate status key:

```text
● bg: 2 running
⚠ bg: 1 failed
● bg: 2 running, 1 failed
```

Running jobs are cancelled on `session_shutdown` by their owning module.
