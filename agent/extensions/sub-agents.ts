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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const WORK_DIR = join(homedir(), ".pi", "agent", "tmp", "sub-agents");
const TAIL_LIMIT_BYTES = 64 * 1024;
const RESULT_LIMIT_BYTES = 50 * 1024;
const TERM_GRACE_MS = 3000;
const MAX_START_MANY = 8;
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
const DEFAULT_THINKING = "medium";

type AgentStatus = "running" | "exited" | "failed" | "timed_out" | "cancelled";
type Action = "start" | "start_many" | "status" | "wait" | "cancel";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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

function appendTail(job: SubAgentJob, data: Buffer): void {
	job.tail += data.toString("utf8");
	const bytes = Buffer.byteLength(job.tail, "utf8");
	if (bytes <= TAIL_LIMIT_BYTES) return;

	let cut = bytes - TAIL_LIMIT_BYTES;
	let index = 0;
	while (index < job.tail.length && cut > 0) {
		cut -= Buffer.byteLength(job.tail[index], "utf8");
		index++;
	}
	job.tail = job.tail.slice(index);
}

function truncateTail(text: string, maxBytes = RESULT_LIMIT_BYTES): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };

	let bytes = 0;
	let index = text.length;
	while (index > 0 && bytes < maxBytes) {
		index--;
		bytes += Buffer.byteLength(text[index], "utf8");
	}
	return { text: text.slice(index), truncated: true };
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m${rest.toString().padStart(2, "0")}s`;
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

	return `You are a ${role} running as a headless sub-agent for a parent coding agent.

Working directory: ${cwd}

Task:
${input.task}

Operating rules:
- Work independently and stay narrowly focused on the task.
- ${mutationNote}
- Prefer concrete evidence: file paths, symbol names, commands, test results, and concise reasoning.
- Do not ask the user questions. If information is missing, state assumptions.
- Do not spawn additional sub-agents.

Return your final answer in this format:

## Summary
One short paragraph.

## Findings
- Key findings with evidence.

## Suggested Next Steps
- Concrete follow-up actions for the parent agent.
`;
}

export default function (pi: ExtensionAPI) {
	let nextAgentNumber = 1;
	const jobs = new Map<string, SubAgentJob>();

	async function startSubAgent(input: AgentTask, parentCwd: string): Promise<SubAgentJob> {
		await mkdir(WORK_DIR, { recursive: true });

		const running = [...jobs.values()].filter((job) => job.status === "running").length;
		if (running >= MAX_START_MANY) throw new Error(`Too many running sub-agents (${running}). Wait or cancel some before starting more.`);

		const id = `agent_${String(nextAgentNumber++).padStart(3, "0")}`;
		const cwd = resolve(parentCwd, input.cwd ?? ".");
		const tools = input.tools?.length ? input.tools : DEFAULT_TOOLS;
		const thinking = input.thinking ?? DEFAULT_THINKING;
		const promptPath = join(WORK_DIR, `${id}.prompt.md`);
		const logPath = join(WORK_DIR, `${id}.log`);
		const prompt = buildPrompt(input, cwd, tools);
		await writeFile(promptPath, prompt, "utf8");

		const args = ["--print", "--no-session", "--no-extensions", "--tools", tools.join(","), "--thinking", thinking];
		if (input.provider) args.push("--provider", input.provider);
		if (input.model) args.push("--model", input.model);
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
			model: input.model,
			provider: input.provider,
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

		log.write(`$ pi ${args.map((arg) => JSON.stringify(arg)).join(" ")}\n\n`);
		child.stdout.on("data", (data: Buffer) => {
			if (!log.writableEnded && !log.destroyed) log.write(data);
			appendTail(job, data);
		});
		child.stderr.on("data", (data: Buffer) => {
			if (!log.writableEnded && !log.destroyed) log.write(data);
			appendTail(job, data);
		});
		child.on("error", (error) => finishJob(job, "failed", null, null, error.message));
		child.on("close", (code, closeSignal) => {
			if (job.status === "timed_out" || job.status === "cancelled") return;
			finishJob(job, code === 0 ? "exited" : "failed", code, closeSignal);
		});

		if (input.timeoutSeconds && input.timeoutSeconds > 0) {
			job.timeout = setTimeout(() => {
				finishJob(job, "timed_out", null, "SIGTERM", `Timed out after ${input.timeoutSeconds}s`);
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

	pi.registerTool({
		name: "sub_agent",
		label: "Sub Agent",
		description: "Start, inspect, wait for, or cancel headless pi sub-agents. Supports starting many independent sub-agents concurrently for parallel analysis. Sub-agents are read-only by default and run with --no-session --no-extensions.",
		promptSnippet: "Run multiple headless pi sub-agents concurrently for delegated analysis",
		promptGuidelines: [
			"Use sub_agent start_many when a task can be decomposed into independent research, code review, test analysis, or planning subtasks that benefit from concurrent agents.",
			"Prefer default read-only sub-agents. The parent agent should synthesize results and perform final edits.",
			`Do not start more than ${MAX_START_MANY} sub-agents at once unless the user explicitly requests a different approach; this tool enforces a hard limit of ${MAX_START_MANY} running sub-agents.`,
			"After sub_agent start or start_many, call sub_agent wait before relying on the results.",
			"Sub-agents run with --no-extensions, so they cannot recursively create more sub-agents.",
		],
		parameters: Type.Object({
			action: StringEnum(["start", "start_many", "status", "wait", "cancel"] as const),
			task: Type.Optional(Type.String({ description: "Task for action=start." })),
			role: Type.Optional(Type.String({ description: "Optional role for action=start." })),
			label: Type.Optional(Type.String({ description: "Optional label for action=start." })),
			cwd: Type.Optional(Type.String({ description: "Working directory for action=start." })),
			tools: Type.Optional(Type.Array(Type.String(), { description: `Allowed tools. Defaults to ${DEFAULT_TOOLS.join(",")}.` })),
			model: Type.Optional(Type.String({ description: "Optional model for action=start." })),
			provider: Type.Optional(Type.String({ description: "Optional provider for action=start." })),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Maximum runtime for action=start." })),
			tasks: Type.Optional(Type.Array(TaskSchema, { description: `Tasks for action=start_many. Maximum ${MAX_START_MANY}.` })),
			jobId: Type.Optional(Type.String({ description: "Single sub-agent id for status/wait/cancel." })),
			jobIds: Type.Optional(Type.Array(Type.String(), { description: "Multiple sub-agent ids for status/wait/cancel. Omit jobId/jobIds to target all jobs." })),
			waitTimeoutSeconds: Type.Optional(Type.Number({ description: "Maximum time to wait for action=wait. If it expires, running sub-agents continue." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const action = params.action as Action;

			if (action === "start") {
				if (!params.task) throw new Error("sub_agent action=start requires task");
				const job = await startSubAgent(params as AgentTask, ctx.cwd);
				return {
					content: [{ type: "text", text: `Started sub-agent ${job.id}${job.label ? ` (${job.label})` : ""}\nRole: ${job.role ?? "general"}\nCWD: ${job.cwd}\nTools: ${job.tools.join(",")}\nPrompt: ${job.promptPath}\nLog: ${job.logPath}` }],
					details: { id: job.id, status: job.status, promptPath: job.promptPath, logPath: job.logPath },
				};
			}

			if (action === "start_many") {
				if (!params.tasks?.length) throw new Error("sub_agent action=start_many requires tasks");
				if (params.tasks.length > MAX_START_MANY) throw new Error(`start_many supports at most ${MAX_START_MANY} tasks`);
				const started: SubAgentJob[] = [];
				for (const task of params.tasks as AgentTask[]) {
					started.push(await startSubAgent(task, ctx.cwd));
				}
				const lines = started.map((job) => `${job.id}\t${job.status}\t${job.label ?? job.role ?? "sub-agent"}\t${job.logPath}`);
				return { content: [{ type: "text", text: `Started ${started.length} sub-agents concurrently:\n${lines.join("\n")}` }], details: { ids: started.map((job) => job.id) } };
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

				const deadline = params.waitTimeoutSeconds && params.waitTimeoutSeconds > 0 ? Date.now() + params.waitTimeoutSeconds * 1000 : undefined;
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
					finishJob(job, "cancelled", null, "SIGTERM", "Cancelled by sub_agent cancel");
					killProcessGroup(job, "SIGTERM");
					setTimeout(() => killProcessGroup(job, "SIGKILL"), TERM_GRACE_MS);
					lines.push(`${job.id} cancelled`);
				}
				return { content: [{ type: "text", text: lines.join("\n") }], details: { ids } };
			}

			throw new Error(`Unsupported sub_agent action: ${action}`);
		},
	});

	pi.on("session_shutdown", async () => {
		for (const job of jobs.values()) {
			if (job.status !== "running") continue;
			finishJob(job, "cancelled", null, "SIGTERM", "Cancelled by session shutdown");
			killProcessGroup(job, "SIGTERM");
			setTimeout(() => killProcessGroup(job, "SIGKILL"), TERM_GRACE_MS);
		}
	});
}
