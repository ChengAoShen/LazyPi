/**
 * Background shell tools.
 *
 * Starts long-running shell commands as session-scoped jobs, then lets the agent
 * poll, wait for completion, or cancel them without blocking a tool call forever.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { createJobsMonitor } from "./job-monitor.ts";

const LOG_DIR = join(homedir(), ".pi", "agent", "tmp", "background-shell");
const TAIL_LIMIT_BYTES = 64 * 1024;
const RESULT_LIMIT_BYTES = 50 * 1024;
const TERM_GRACE_MS = 3000;

type JobStatus = "running" | "exited" | "failed" | "timed_out" | "cancelled";

type BackgroundJob = {
	id: string;
	command: string;
	cwd: string;
	label?: string;
	logPath: string;
	child: ChildProcessWithoutNullStreams;
	log: WriteStream;
	startedAt: number;
	endedAt?: number;
	status: JobStatus;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	error?: string;
	tail: string;
	timeout?: NodeJS.Timeout;
	waiters: Array<() => void>;
};

function appendTail(job: BackgroundJob, data: Buffer): void {
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

function shellQuote(path: string): string {
	return JSON.stringify(path);
}

function killProcessGroup(job: BackgroundJob, signal: NodeJS.Signals): void {
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

function finishJob(job: BackgroundJob, status: JobStatus, exitCode: number | null, signal: NodeJS.Signals | null, error?: string): void {
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

function summarizeJob(job: BackgroundJob, includeOutput = true): string {
	const elapsedUntil = job.endedAt ?? Date.now();
	const output = truncateTail(job.tail.trimEnd());
	const lines = [
		`Job: ${job.id}${job.label ? ` (${job.label})` : ""}`,
		`Status: ${job.status}`,
		`Command: ${job.command}`,
		`CWD: ${job.cwd}`,
		`Elapsed: ${formatDuration(elapsedUntil - job.startedAt)}`,
		`Exit code: ${job.exitCode ?? "n/a"}`,
		`Signal: ${job.signal ?? "n/a"}`,
		`Log: ${job.logPath}`,
	];
	if (job.error) lines.push(`Error: ${job.error}`);
	if (includeOutput) {
		lines.push("", output.truncated ? `[Output truncated to last ${RESULT_LIMIT_BYTES} bytes]` : "Output:", output.text || "(no output yet)");
	}
	return lines.join("\n");
}

function waitForJob(job: BackgroundJob, timeoutSeconds: number | undefined, signal: AbortSignal | undefined): Promise<"done" | "timeout" | "aborted"> {
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

type JobsMonitor = ReturnType<typeof createJobsMonitor>;

export function installBackgroundShell(pi: ExtensionAPI, jobsMonitor: JobsMonitor) {
	let nextJobNumber = 1;
	const jobs = new Map<string, BackgroundJob>();
	const monitor = jobsMonitor.registerSource({
		id: "shell",
		title: "shell jobs",
		emptyText: "no shell jobs",
		getJobs: () => [...jobs.values()].map((job) => ({
			id: job.id,
			status: job.status,
			startedAt: job.startedAt,
			endedAt: job.endedAt,
			label: job.label ?? job.command,
			tail: job.tail,
		})),
	});

	pi.registerTool({
		name: "bg_shell_start",
		label: "Background Shell Start",
		description: "Start a non-interactive shell command in the background and immediately return a job id. Output is captured to a log file and a tail buffer.",
		promptSnippet: "Start long-running non-interactive shell commands as background jobs",
		promptGuidelines: [
			"Use bg_shell_start for long-running commands such as builds, tests, dev servers, migrations, downloads, or commands expected to take more than about 10 seconds.",
			"Use the regular bash tool for short one-off shell commands.",
			"After bg_shell_start, call bg_shell_status or bg_shell_wait before relying on the command result.",
			"Do not use bg_shell_start for commands that require interactive stdin.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run via the user's shell." }),
			cwd: Type.Optional(Type.String({ description: "Working directory. Relative paths are resolved against the current cwd." })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Optional maximum runtime. If exceeded, the job is terminated and marked timed_out." })),
			label: Type.Optional(Type.String({ description: "Optional human-readable label." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled before start" }], details: {} };

			await mkdir(LOG_DIR, { recursive: true });

			const id = `bg_${String(nextJobNumber++).padStart(3, "0")}`;
			const cwd = resolve(ctx.cwd, params.cwd ?? ".");
			const logPath = join(LOG_DIR, `${id}.log`);
			const log = createWriteStream(logPath, { flags: "a" });
			const shell = process.env.SHELL || "/bin/bash";
			const child = spawn(shell, ["-lc", params.command], {
				cwd,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env,
			});

			const job: BackgroundJob = {
				id,
				command: params.command,
				cwd,
				label: params.label,
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
			monitor.update(ctx);

			log.write(`$ cd ${shellQuote(cwd)} && ${params.command}\n\n`);
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
				monitor.update(ctx);
			});
			child.on("close", (code, closeSignal) => {
				const timedOut = job.status === "timed_out";
				const cancelled = job.status === "cancelled";
				if (timedOut || cancelled) return;
				finishJob(job, code === 0 ? "exited" : "failed", code, closeSignal);
				monitor.update(ctx);
				try {
					ctx.ui.notify(`Background job ${id} finished: ${job.status}${code === null ? "" : ` (${code})`}`, code === 0 ? "info" : "warning");
				} catch {
					// UI may no longer be available.
				}
			});

			if (params.timeoutSeconds && params.timeoutSeconds > 0) {
				job.timeout = setTimeout(() => {
					finishJob(job, "timed_out", null, "SIGTERM", `Timed out after ${params.timeoutSeconds}s`);
					monitor.update(ctx);
					killProcessGroup(job, "SIGTERM");
					setTimeout(() => killProcessGroup(job, "SIGKILL"), TERM_GRACE_MS);
				}, params.timeoutSeconds * 1000);
			}

			return {
				content: [{ type: "text", text: `Started background job ${id}\nCommand: ${params.command}\nCWD: ${cwd}\nLog: ${logPath}` }],
				details: { id, command: params.command, cwd, logPath, status: "running" },
			};
		},
	});

	pi.registerTool({
		name: "bg_shell_status",
		label: "Background Shell Status",
		description: "Check the status and recent output of one background shell job, or list all jobs if no jobId is provided.",
		promptSnippet: "Check background shell job status and recent output",
		parameters: Type.Object({
			jobId: Type.Optional(Type.String({ description: "Job id returned by bg_shell_start. Omit to list all jobs." })),
		}),
		async execute(_toolCallId, params) {
			if (!params.jobId) {
				const lines = [...jobs.values()].map((job) => {
					const elapsedUntil = job.endedAt ?? Date.now();
					return `${job.id}\t${job.status}\t${formatDuration(elapsedUntil - job.startedAt)}\t${job.label ?? job.command}`;
				});
				return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No background jobs." }], details: { jobs: lines.length } };
			}

			const job = jobs.get(params.jobId);
			if (!job) throw new Error(`Unknown background job: ${params.jobId}`);
			return { content: [{ type: "text", text: summarizeJob(job) }], details: { id: job.id, status: job.status, exitCode: job.exitCode, logPath: job.logPath } };
		},
	});

	pi.registerTool({
		name: "bg_shell_wait",
		label: "Background Shell Wait",
		description: "Wait for a background shell job to finish, then return its exit status and recent output. If waitTimeoutSeconds expires, the job keeps running.",
		promptSnippet: "Wait for a background shell job to complete and return its result",
		parameters: Type.Object({
			jobId: Type.String({ description: "Job id returned by bg_shell_start." }),
			waitTimeoutSeconds: Type.Optional(Type.Number({ description: "Maximum time to wait. If omitted, waits until completion or tool cancellation." })),
		}),
		async execute(_toolCallId, params, signal) {
			const job = jobs.get(params.jobId);
			if (!job) throw new Error(`Unknown background job: ${params.jobId}`);

			const result = await waitForJob(job, params.waitTimeoutSeconds, signal);
			if (result === "aborted") return { content: [{ type: "text", text: `Wait cancelled. Job ${job.id} is still ${job.status}.\nLog: ${job.logPath}` }], details: { id: job.id, status: job.status } };
			if (result === "timeout") return { content: [{ type: "text", text: `Wait timed out. Job ${job.id} is still running.\n\n${summarizeJob(job)}` }], details: { id: job.id, status: job.status, logPath: job.logPath } };

			return { content: [{ type: "text", text: summarizeJob(job) }], details: { id: job.id, status: job.status, exitCode: job.exitCode, logPath: job.logPath } };
		},
	});

	pi.registerTool({
		name: "bg_shell_cancel",
		label: "Background Shell Cancel",
		description: "Terminate a running background shell job.",
		promptSnippet: "Cancel a running background shell job",
		parameters: Type.Object({
			jobId: Type.String({ description: "Job id returned by bg_shell_start." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const job = jobs.get(params.jobId);
			if (!job) throw new Error(`Unknown background job: ${params.jobId}`);
			if (job.status !== "running") return { content: [{ type: "text", text: `Job ${job.id} is already ${job.status}.` }], details: { id: job.id, status: job.status } };

			finishJob(job, "cancelled", null, "SIGTERM", "Cancelled by bg_shell_cancel");
			monitor.update(ctx);
			killProcessGroup(job, "SIGTERM");
			setTimeout(() => killProcessGroup(job, "SIGKILL"), TERM_GRACE_MS);
			return { content: [{ type: "text", text: `Cancelled background job ${job.id}.\nLog: ${job.logPath}` }], details: { id: job.id, status: job.status, logPath: job.logPath } };
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
