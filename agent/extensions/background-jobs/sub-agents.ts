/**
 * Sub-agent tool.
 *
 * Runs multiple headless pi instances concurrently for delegated research,
 * review, and planning work. Sub-agents are session-scoped and read-only by
 * default; the main agent should synthesize results and perform final edits.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendTail as appendTailText, formatDuration, RESULT_LIMIT_BYTES, timestampForFile, truncateTail } from "../shared/shell.ts";
import type { createJobsMonitor } from "./job-monitor.ts";

const WORK_DIR = join(homedir(), ".pi", "agent", "tmp", "sub-agents");
const MAIN_PROGRESS_PATH = join(WORK_DIR, "main-tool-progress.md");
const TERM_GRACE_MS = 3000;
const MAX_START_MANY = 8;
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
const DEFAULT_THINKING = "medium";

type AgentStatus = "running" | "exited" | "failed" | "timed_out" | "cancelled";
type Action = "start" | "status" | "wait" | "cancel" | "config";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ReturnDelivery = "steer" | "followUp" | "nextTurn";

type SubAgentConfig = {
	defaultTimeoutSeconds?: number;
	defaultWaitTimeoutSeconds?: number;
	defaultReturnToMain: boolean;
	defaultReturnDelivery: ReturnDelivery;
	defaultThinking: ThinkingLevel;
};

const subAgentConfig: SubAgentConfig = {
	defaultReturnToMain: false,
	defaultReturnDelivery: "followUp",
	defaultThinking: DEFAULT_THINKING,
};

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function formatConfig(config: SubAgentConfig): string {
	return [
		"Sub-agent configuration:",
		`defaultTimeoutSeconds: ${config.defaultTimeoutSeconds ?? "none"}`,
		`defaultWaitTimeoutSeconds: ${config.defaultWaitTimeoutSeconds ?? "none"}`,
		`defaultReturnToMain: ${config.defaultReturnToMain}`,
		`defaultReturnDelivery: ${config.defaultReturnDelivery}`,
		`defaultThinking: ${config.defaultThinking}`,
	].join("\n");
}

type MainToolProgress = {
	id: string;
	toolName: string;
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
	status: "running" | "finished";
	startedAt: number;
	updatedAt: number;
	endedAt?: number;
};

type AgentTask = {
	task: string;
	role?: string;
	label?: string;
	cwd?: string;
	tools?: string[];
	model?: string;
	provider?: string;
	thinking?: ThinkingLevel;
	timeoutSeconds?: number;
};

type SubAgentJob = {
	id: string;
	task: string;
	role?: string;
	label?: string;
	cwd: string;
	tools: string[];
	model?: string;
	provider?: string;
	thinking: ThinkingLevel;
	promptPath: string;
	logPath: string;
	child: ChildProcessWithoutNullStreams;
	log: WriteStream;
	startedAt: number;
	endedAt?: number;
	status: AgentStatus;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	error?: string;
	tail: string;
	timeout?: NodeJS.Timeout;
	waiters: Array<() => void>;
};

const TaskSchema = Type.Object({
	task: Type.String({ description: "Independent task for the sub-agent." }),
	role: Type.Optional(Type.String({ description: "Optional role, e.g. frontend reviewer, test analyst, security reviewer." })),
	label: Type.Optional(Type.String({ description: "Short label for status listings." })),
	cwd: Type.Optional(Type.String({ description: "Working directory. Relative paths are resolved against the current cwd." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: `Allowed tools for the sub-agent. Defaults to read-only: ${DEFAULT_TOOLS.join(",")}.` })),
	model: Type.Optional(Type.String({ description: "Optional pi model pattern or provider/model id." })),
	provider: Type.Optional(Type.String({ description: "Optional pi provider name." })),
	thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
	timeoutSeconds: Type.Optional(Type.Number({ description: "Optional maximum runtime before the sub-agent is terminated." })),
});

const mainToolProgress = new Map<string, MainToolProgress>();

function compactValue(value: unknown, maxLength = 1200): string {
	let text: string;
	try {
		const json = typeof value === "string" ? value : JSON.stringify(value);
		text = json ?? String(value);
	} catch {
		text = String(value);
	}
	if (!text) return "";
	text = text.replace(/\s+/g, " ").trim();
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function formatMainToolProgress(): string {
	const entries = [...mainToolProgress.values()]
		.sort((a, b) => a.startedAt - b.startedAt)
		.slice(-30);
	const lines = ["# Parent main-agent tool progress", "", `Updated: ${new Date().toISOString()}`, ""];
	if (!entries.length) {
		lines.push("No main-agent tool executions have been observed yet.");
		return lines.join("\n");
	}

	const now = Date.now();
	for (const entry of entries) {
		const elapsed = Math.max(0, Math.round(((entry.endedAt ?? now) - entry.startedAt) / 1000));
		lines.push(`- ${entry.toolName} (${entry.status}${entry.isError ? ", error" : ""}, ${elapsed}s, id=${entry.id})`);
		const args = compactValue(entry.args, 700);
		if (args) lines.push(`  - args: ${args}`);
		const partial = compactValue(entry.partialResult, 900);
		if (entry.status === "running" && partial) lines.push(`  - latest update: ${partial}`);
		const result = compactValue(entry.result, 900);
		if (entry.status === "finished" && result) lines.push(`  - result: ${result}`);
	}
	return lines.join("\n");
}

function pruneMainToolProgress(): void {
	const entries = [...mainToolProgress.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	for (const entry of entries.slice(60)) mainToolProgress.delete(entry.id);
}

function writeMainProgressSnapshot(): void {
	void mkdir(WORK_DIR, { recursive: true })
		.then(() => writeFile(MAIN_PROGRESS_PATH, `${formatMainToolProgress()}\n`, "utf8"))
		.catch(() => undefined);
}

function appendTail(job: SubAgentJob, data: Buffer): void {
	job.tail = appendTailText(job.tail, data);
}

function killProcessGroup(job: SubAgentJob, signal: NodeJS.Signals): void {
	const pid = job.child.pid;
	if (!pid) return;

	try {
		process.kill(-pid, signal);
	} catch {
		try {
			job.child.kill(signal);
		} catch {
			// Process already exited.
		}
	}
}

function finishJob(job: SubAgentJob, status: AgentStatus, exitCode: number | null, signal: NodeJS.Signals | null, error?: string): void {
	if (job.status !== "running") return;

	job.status = status;
	job.exitCode = exitCode;
	job.signal = signal;
	job.error = error;
	job.endedAt = Date.now();
	if (job.timeout) clearTimeout(job.timeout);
	if (!job.log.writableEnded && !job.log.destroyed) job.log.end();

	const waiters = job.waiters.splice(0);
	for (const resolveWaiter of waiters) resolveWaiter();
}

function summarizeJob(job: SubAgentJob, includeOutput = true): string {
	const elapsedUntil = job.endedAt ?? Date.now();
	const output = truncateTail(job.tail.trimEnd());
	const lines = [
		`Sub-agent: ${job.id}${job.label ? ` (${job.label})` : ""}`,
		`Status: ${job.status}`,
		`Role: ${job.role ?? "general"}`,
		`CWD: ${job.cwd}`,
		`Tools: ${job.tools.join(",")}`,
		`Model: ${job.model ?? "default"}`,
		`Thinking: ${job.thinking}`,
		`Elapsed: ${formatDuration(elapsedUntil - job.startedAt)}`,
		`Exit code: ${job.exitCode ?? "n/a"}`,
		`Signal: ${job.signal ?? "n/a"}`,
		`Prompt: ${job.promptPath}`,
		`Log: ${job.logPath}`,
		`Task: ${job.task}`,
	];
	if (job.error) lines.push(`Error: ${job.error}`);
	if (includeOutput) {
		lines.push("", output.truncated ? `[Output truncated to last ${RESULT_LIMIT_BYTES} bytes]` : "Output:", output.text || "(no output yet)");
	}
	return lines.join("\n");
}

function waitForJob(job: SubAgentJob, timeoutSeconds: number | undefined, signal: AbortSignal | undefined): Promise<"done" | "timeout" | "aborted"> {
	if (job.status !== "running") return Promise.resolve("done");
	if (signal?.aborted) return Promise.resolve("aborted");

	return new Promise((resolveWait) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		let waiter: () => void;

		const done = (result: "done" | "timeout" | "aborted") => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			const index = job.waiters.indexOf(waiter);
			if (index >= 0) job.waiters.splice(index, 1);
			resolveWait(result);
		};

		const onAbort = () => done("aborted");
		waiter = () => done("done");
		job.waiters.push(waiter);
		signal?.addEventListener("abort", onAbort, { once: true });

		if (timeoutSeconds && timeoutSeconds > 0) {
			timer = setTimeout(() => done("timeout"), timeoutSeconds * 1000);
		}
	});
}

function buildPrompt(input: AgentTask, cwd: string, tools: string[]): string {
	const role = input.role ?? "independent coding sub-agent";
	const mutationNote = tools.some((tool) => ["bash", "edit", "write"].includes(tool))
		? "You may use the tools explicitly enabled for you, but avoid unnecessary file mutations and report every mutation you make."
		: "You are read-only. Do not attempt to modify files. Focus on analysis, evidence, and recommendations.";
	const canReadProgress = tools.includes("read");
	const progressSnapshot = formatMainToolProgress();

	return `You are a ${role} running as a headless sub-agent for a parent coding agent.

Working directory: ${cwd}

Task:
${input.task}

Parent main-agent progress:
${progressSnapshot}

${canReadProgress ? `The parent also writes a live progress file at ${MAIN_PROGRESS_PATH}. If your work depends on what the parent is doing now, read that file for a fresher snapshot before finalizing.` : `You do not have the read tool, so you only have the progress snapshot above.`}

Operating rules:
- Work independently and stay narrowly focused on the task.
- ${mutationNote}
- Prefer concrete evidence: file paths, symbol names, commands, test results, and concise reasoning.
- Do not ask the user questions. If information is missing, state assumptions.
- Do not spawn additional sub-agents.
- Use parent progress only as situational awareness; do not claim that you performed the parent's tool calls.

Return your final answer in this format:

## Summary
One short paragraph.

## Findings
- Key findings with evidence.

## Suggested Next Steps
- Concrete follow-up actions for the parent agent.
`;
}

type JobsMonitor = ReturnType<typeof createJobsMonitor>;

export function installSubAgents(pi: ExtensionAPI, jobsMonitor: JobsMonitor) {
	let nextAgentNumber = 1;
	let shuttingDown = false;
	const jobs = new Map<string, SubAgentJob>();
	function cancelJob(id: string, ctx?: ExtensionContext): boolean {
		const job = jobs.get(id);
		if (!job || job.status !== "running") return false;
		finishJob(job, "cancelled", null, "SIGTERM", "Cancelled by background jobs UI");
		monitor.update(ctx);
		killProcessGroup(job, "SIGTERM");
		setTimeout(() => killProcessGroup(job, "SIGKILL"), TERM_GRACE_MS);
		return true;
	}

	const monitor = jobsMonitor.registerSource({
		id: "agents",
		title: "agents",
		getJobs: () => [...jobs.values()].map((job) => ({
			id: job.id,
			status: job.status,
			startedAt: job.startedAt,
			endedAt: job.endedAt,
			label: job.label ?? job.role ?? job.task,
			cwd: job.cwd,
			logPath: job.logPath,
			tail: job.tail,
			canCancel: job.status === "running",
		})),
		getJobDetails: (id) => {
			const job = jobs.get(id);
			if (!job) return [`unknown agent job: ${id}`];
			return [
				`role: ${job.role ?? "general"}`,
				`cwd: ${job.cwd}`,
				`tools: ${job.tools.join(",")}`,
				`model: ${job.model ?? "default"}`,
				`thinking: ${job.thinking}`,
				`prompt: ${job.promptPath}`,
				`log: ${job.logPath}`,
				`exit: ${job.exitCode ?? "n/a"}`,
				`signal: ${job.signal ?? "n/a"}`,
				...(job.error ? [`error: ${job.error}`] : []),
			];
		},
		cancelJob,
	});

	pi.on("agent_start", async () => {
		shuttingDown = false;
		mainToolProgress.clear();
		writeMainProgressSnapshot();
	});

	pi.on("tool_execution_start", async (event) => {
		const now = Date.now();
		mainToolProgress.set(event.toolCallId, {
			id: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			status: "running",
			startedAt: now,
			updatedAt: now,
		});
		pruneMainToolProgress();
		writeMainProgressSnapshot();
	});

	pi.on("tool_execution_update", async (event) => {
		const existing = mainToolProgress.get(event.toolCallId);
		if (!existing) {
			const now = Date.now();
			mainToolProgress.set(event.toolCallId, {
				id: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
				status: "running",
				startedAt: now,
				updatedAt: now,
			});
			writeMainProgressSnapshot();
			return;
		}
		existing.args = event.args ?? existing.args;
		existing.partialResult = event.partialResult;
		existing.updatedAt = Date.now();
		writeMainProgressSnapshot();
	});

	pi.on("tool_execution_end", async (event) => {
		const existing = mainToolProgress.get(event.toolCallId);
		const now = Date.now();
		mainToolProgress.set(event.toolCallId, {
			id: event.toolCallId,
			toolName: event.toolName,
			args: existing?.args,
			partialResult: existing?.partialResult,
			result: event.result,
			isError: event.isError,
			status: "finished",
			startedAt: existing?.startedAt ?? now,
			updatedAt: now,
			endedAt: now,
		});
		pruneMainToolProgress();
		writeMainProgressSnapshot();
	});

	async function startSubAgent(input: AgentTask, parentCwd: string, currentModel?: ExtensionContext["model"]): Promise<SubAgentJob> {
		await mkdir(WORK_DIR, { recursive: true });

		const running = [...jobs.values()].filter((job) => job.status === "running").length;
		if (running >= MAX_START_MANY) throw new Error(`Too many running sub-agents (${running}). Wait or cancel some before starting more.`);

		const id = `agent_${String(nextAgentNumber++).padStart(3, "0")}`;
		const cwd = resolve(parentCwd, input.cwd ?? ".");
		const tools = input.tools?.length ? input.tools : DEFAULT_TOOLS;
		const thinking = input.thinking ?? DEFAULT_THINKING;
		const shouldInheritModel = !input.provider && !input.model;
		const provider = shouldInheritModel ? currentModel?.provider : input.provider;
		const model = shouldInheritModel ? currentModel?.id : input.model;
		const stamp = timestampForFile();
		const promptPath = join(WORK_DIR, `${id}-${stamp}.prompt.md`);
		const logPath = join(WORK_DIR, `${id}-${stamp}.log`);
		await writeFile(MAIN_PROGRESS_PATH, `${formatMainToolProgress()}\n`, "utf8");
		const prompt = buildPrompt(input, cwd, tools);
		await writeFile(promptPath, prompt, "utf8");

		const args = ["--print", "--no-session", "--no-extensions", "--tools", tools.join(","), "--thinking", thinking];
		if (provider) args.push("--provider", provider);
		if (model) args.push("--model", model);
		args.push(`@${promptPath}`);

		const log = createWriteStream(logPath, { flags: "a" });
		const child = spawn("pi", args, {
			cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_SUB_AGENT: "1" },
		});

		const job: SubAgentJob = {
			id,
			task: input.task,
			role: input.role,
			label: input.label,
			cwd,
			tools,
			model,
			provider,
			thinking,
			promptPath,
			logPath,
			child,
			log,
			startedAt: Date.now(),
			status: "running",
			exitCode: null,
			signal: null,
			tail: "",
			waiters: [],
		};
		jobs.set(id, job);
		monitor.update();

		log.write(`$ pi ${args.map((arg) => JSON.stringify(arg)).join(" ")}\n\n`);
		child.stdout.on("data", (data: Buffer) => {
			if (!log.writableEnded && !log.destroyed) log.write(data);
			appendTail(job, data);
		});
		child.stderr.on("data", (data: Buffer) => {
			if (!log.writableEnded && !log.destroyed) log.write(data);
			appendTail(job, data);
		});
		child.on("error", (error) => {
			finishJob(job, "failed", null, null, error.message);
			monitor.update();
		});
		child.on("close", (code, closeSignal) => {
			if (job.status === "timed_out" || job.status === "cancelled") return;
			finishJob(job, code === 0 ? "exited" : "failed", code, closeSignal);
			monitor.update();
		});

		if (input.timeoutSeconds && input.timeoutSeconds > 0) {
			job.timeout = setTimeout(() => {
				finishJob(job, "timed_out", null, "SIGTERM", `Timed out after ${input.timeoutSeconds}s`);
				monitor.update();
				killProcessGroup(job, "SIGTERM");
				setTimeout(() => killProcessGroup(job, "SIGKILL"), TERM_GRACE_MS);
			}, input.timeoutSeconds * 1000);
		}

		return job;
	}

	function resolveJobIds(jobId?: string, jobIds?: string[]): string[] {
		const ids = [...(jobIds ?? [])];
		if (jobId) ids.push(jobId);
		return ids.length ? ids : [...jobs.keys()];
	}

	function returnSubAgentResultsToMain(completedJobs: SubAgentJob[], delivery: ReturnDelivery, instruction?: string): void {
		if (shuttingDown || completedJobs.length === 0) return;

		const summaries = completedJobs.map((job) => summarizeJob(job)).join("\n\n---\n\n");
		const defaultInstruction =
			"Sub-agent work has completed. Read these returned results, synthesize the findings, and continue the original task. Do not ask the user to manually inspect job ids unless more information is needed.";
		pi.sendMessage(
			{
				customType: "sub-agent-return",
				content: `${instruction?.trim() || defaultInstruction}\n\n${summaries}`,
				display: true,
				details: { ids: completedJobs.map((job) => job.id), statuses: completedJobs.map((job) => job.status) },
			},
			{ deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
		);
	}

	function scheduleReturnToMain(completedJobs: SubAgentJob[], delivery: ReturnDelivery, instruction?: string): void {
		void (async () => {
			for (const job of completedJobs) await waitForJob(job, undefined, undefined);
			returnSubAgentResultsToMain(completedJobs, delivery, instruction);
		})().catch(() => undefined);
	}

	pi.registerTool({
		name: "sub_agent",
		label: "Sub Agent",
		description: "Start, inspect, wait for, or cancel headless pi sub-agents. action=start accepts either one task or a tasks array for parallel work; set returnToMain=true to automatically send completed results back to the main agent. Sub-agents are read-only by default, run with --no-session --no-extensions, and receive parent progress.",
		promptSnippet: "Run one or more headless pi sub-agents for delegated analysis",
		promptGuidelines: [
			"Use sub_agent action=start with tasks:[...] when a task can be decomposed into independent research, code review, test analysis, or planning subtasks that benefit from concurrent agents.",
			"Prefer default read-only sub-agents. The parent agent should synthesize results and perform final edits.",
			`Do not start more than ${MAX_START_MANY} sub-agents at once unless the user explicitly requests a different approach; this tool enforces a hard limit of ${MAX_START_MANY} running sub-agents.`,
			"Sub-agents receive parent tool progress as situational awareness; if they need the freshest state and have read access, they can read the provided progress file.",
			"After sub_agent action=start, either call sub_agent action=wait before relying on results, or set returnToMain=true so results are automatically returned as a follow-up to the main agent.",
			"Sub-agents run with --no-extensions, so they cannot recursively create more sub-agents.",
		],
		parameters: Type.Object({
			action: StringEnum(["start", "status", "wait", "cancel", "config"] as const),
			task: Type.Optional(Type.String({ description: "Single task for action=start. Mutually exclusive with tasks." })),
			role: Type.Optional(Type.String({ description: "Optional role for action=start." })),
			label: Type.Optional(Type.String({ description: "Optional label for action=start." })),
			cwd: Type.Optional(Type.String({ description: "Working directory for action=start." })),
			tools: Type.Optional(Type.Array(Type.String(), { description: `Allowed tools. Defaults to ${DEFAULT_TOOLS.join(",")}.` })),
			model: Type.Optional(Type.String({ description: "Optional model for action=start." })),
			provider: Type.Optional(Type.String({ description: "Optional provider for action=start." })),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Maximum runtime for action=start." })),
			tasks: Type.Optional(Type.Array(TaskSchema, { description: `Parallel tasks for action=start. Mutually exclusive with task. Maximum ${MAX_START_MANY}.` })),
			returnToMain: Type.Optional(Type.Boolean({ description: "For action=start, automatically send completed sub-agent results back to the main agent and trigger continuation. Default: false." })),
			returnDelivery: Type.Optional(StringEnum(["steer", "followUp", "nextTurn"] as const, { description: "Delivery mode when returnToMain=true. Default: followUp." })),
			returnInstruction: Type.Optional(Type.String({ description: "Optional instruction prepended to the automatic return message for the parent agent." })),
			jobId: Type.Optional(Type.String({ description: "Single sub-agent id for status/wait/cancel." })),
			jobIds: Type.Optional(Type.Array(Type.String(), { description: "Multiple sub-agent ids for status/wait/cancel. Omit jobId/jobIds to target all jobs." })),
			waitTimeoutSeconds: Type.Optional(Type.Number({ description: "Maximum time to wait for action=wait. If it expires, running sub-agents continue." })),
			defaultTimeoutSeconds: Type.Optional(Type.Number({ description: "For action=config: set default maximum runtime for future sub-agents. Use <=0 to clear." })),
			defaultWaitTimeoutSeconds: Type.Optional(Type.Number({ description: "For action=config: set default maximum wait time for future wait calls. Use <=0 to clear." })),
			defaultReturnToMain: Type.Optional(Type.Boolean({ description: "For action=config: default returnToMain for future start calls." })),
			defaultReturnDelivery: Type.Optional(StringEnum(["steer", "followUp", "nextTurn"] as const, { description: "For action=config: default delivery mode when automatic return is enabled." })),
			defaultThinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, { description: "For action=config: default sub-agent thinking level." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const action = params.action as Action;
			const returnToMain = params.returnToMain ?? subAgentConfig.defaultReturnToMain;
			const returnDelivery = (params.returnDelivery ?? subAgentConfig.defaultReturnDelivery) as ReturnDelivery;
			const returnInstruction = params.returnInstruction as string | undefined;

			if (action === "config") {
				if ("defaultTimeoutSeconds" in params) subAgentConfig.defaultTimeoutSeconds = positiveNumber(params.defaultTimeoutSeconds);
				if ("defaultWaitTimeoutSeconds" in params) subAgentConfig.defaultWaitTimeoutSeconds = positiveNumber(params.defaultWaitTimeoutSeconds);
				if (typeof params.defaultReturnToMain === "boolean") subAgentConfig.defaultReturnToMain = params.defaultReturnToMain;
				if (params.defaultReturnDelivery) subAgentConfig.defaultReturnDelivery = params.defaultReturnDelivery as ReturnDelivery;
				if (params.defaultThinking) subAgentConfig.defaultThinking = params.defaultThinking as ThinkingLevel;
				return { content: [{ type: "text", text: formatConfig(subAgentConfig) }], details: { ...subAgentConfig } };
			}

			if (action === "start") {
				const hasSingle = Boolean(params.task);
				const hasTasks = Boolean(params.tasks?.length);
				if (hasSingle === hasTasks) throw new Error("sub_agent action=start requires exactly one of task or tasks");

				const commonTimeoutSeconds = positiveNumber(params.timeoutSeconds) ?? subAgentConfig.defaultTimeoutSeconds;
				const commonThinking = (params.thinking ?? subAgentConfig.defaultThinking) as ThinkingLevel;
				const rawTasks = hasTasks ? (params.tasks as AgentTask[]) : [params as AgentTask];
				const tasks = rawTasks.map((task) => ({
					...task,
					thinking: task.thinking ?? commonThinking,
					timeoutSeconds: positiveNumber(task.timeoutSeconds) ?? commonTimeoutSeconds,
				}));
				if (tasks.length > MAX_START_MANY) throw new Error(`sub_agent action=start supports at most ${MAX_START_MANY} tasks`);
				const running = [...jobs.values()].filter((job) => job.status === "running").length;
				if (running + tasks.length > MAX_START_MANY) {
					throw new Error(`Cannot start ${tasks.length} sub-agent(s): ${running} already running and the limit is ${MAX_START_MANY}. Wait or cancel some before starting more.`);
				}

				const started: SubAgentJob[] = [];
				for (const task of tasks) started.push(await startSubAgent(task, ctx.cwd, ctx.model));
				if (returnToMain) scheduleReturnToMain(started, returnDelivery, returnInstruction);
				monitor.update(ctx);

				if (started.length === 1) {
					const job = started[0];
					return {
						content: [{ type: "text", text: `Started sub-agent ${job.id}${job.label ? ` (${job.label})` : ""}${returnToMain ? " with automatic return to main agent" : ""}\nRole: ${job.role ?? "general"}\nCWD: ${job.cwd}\nTools: ${job.tools.join(",")}\nPrompt: ${job.promptPath}\nLog: ${job.logPath}\nParent progress: ${MAIN_PROGRESS_PATH}` }],
						details: { id: job.id, status: job.status, promptPath: job.promptPath, logPath: job.logPath, parentProgressPath: MAIN_PROGRESS_PATH, returnsToMain: returnToMain },
					};
				}

				const lines = started.map((job) => `${job.id}\t${job.status}\t${job.label ?? job.role ?? "sub-agent"}\t${job.logPath}`);
				return { content: [{ type: "text", text: `Started ${started.length} sub-agents concurrently${returnToMain ? " with automatic return to main agent" : ""}:\n${lines.join("\n")}\nParent progress: ${MAIN_PROGRESS_PATH}` }], details: { ids: started.map((job) => job.id), parentProgressPath: MAIN_PROGRESS_PATH, returnsToMain: returnToMain } };
			}

			if (action === "status") {
				const ids = resolveJobIds(params.jobId, params.jobIds);
				if (!ids.length) return { content: [{ type: "text", text: "No sub-agents." }], details: { jobs: 0 } };
				const summaries = ids.map((id) => {
					const job = jobs.get(id);
					if (!job) return `Unknown sub-agent: ${id}`;
					return summarizeJob(job, Boolean(params.jobId || params.jobIds?.length));
				});
				return { content: [{ type: "text", text: summaries.join("\n\n---\n\n") }], details: { ids } };
			}

			if (action === "wait") {
				const ids = resolveJobIds(params.jobId, params.jobIds);
				if (!ids.length) return { content: [{ type: "text", text: "No sub-agents to wait for." }], details: { jobs: 0 } };
				const knownJobs = ids.map((id) => jobs.get(id)).filter((job): job is SubAgentJob => Boolean(job));
				if (!knownJobs.length) throw new Error(`No known sub-agents found: ${ids.join(", ")}`);

				const waitTimeoutSeconds = positiveNumber(params.waitTimeoutSeconds) ?? subAgentConfig.defaultWaitTimeoutSeconds;
				const deadline = waitTimeoutSeconds ? Date.now() + waitTimeoutSeconds * 1000 : undefined;
				for (const job of knownJobs) {
					const remaining = deadline ? Math.max(0.001, (deadline - Date.now()) / 1000) : undefined;
					const result = await waitForJob(job, remaining, signal);
					if (result === "aborted") break;
					if (result === "timeout") break;
				}

				const summaries = knownJobs.map((job) => summarizeJob(job));
				return { content: [{ type: "text", text: summaries.join("\n\n---\n\n") }], details: { ids: knownJobs.map((job) => job.id), statuses: knownJobs.map((job) => job.status) } };
			}

			if (action === "cancel") {
				const ids = resolveJobIds(params.jobId, params.jobIds);
				if (!ids.length) return { content: [{ type: "text", text: "No sub-agents to cancel." }], details: { jobs: 0 } };
				const lines: string[] = [];
				for (const id of ids) {
					const job = jobs.get(id);
					if (!job) {
						lines.push(`Unknown sub-agent: ${id}`);
						continue;
					}
					if (job.status !== "running") {
						lines.push(`${job.id} already ${job.status}`);
						continue;
					}
					cancelJob(job.id, ctx);
					lines.push(`${job.id} cancelled`);
				}
				return { content: [{ type: "text", text: lines.join("\n") }], details: { ids } };
			}

			throw new Error(`Unsupported sub_agent action: ${action}`);
		},
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		for (const job of jobs.values()) {
			if (job.status !== "running") continue;
			finishJob(job, "cancelled", null, "SIGTERM", "Cancelled by session shutdown");
			killProcessGroup(job, "SIGTERM");
			setTimeout(() => killProcessGroup(job, "SIGKILL"), TERM_GRACE_MS);
		}
	});
}
