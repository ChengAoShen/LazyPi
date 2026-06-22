// Background jobs extension.
//
// Agent-facing tools:
// - bg_shell_* for long-running shell commands
// - sub_agent for parallel headless Pi workers
//
// User-facing UI:
// - /jobs unified observation panel

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installBackgroundShell } from "./background-shell.ts";
import { createJobsMonitor } from "./job-monitor.ts";
import { installSubAgents } from "./sub-agents.ts";

export default function backgroundJobs(pi: ExtensionAPI) {
	const monitor = createJobsMonitor(pi);
	installBackgroundShell(pi, monitor);
	installSubAgents(pi, monitor);
}
