import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";

export type MonitoredJob = {
	id: string;
	status: string;
	startedAt: number;
	endedAt?: number;
	label: string;
	tail?: string;
};

export type JobSource = {
	id: string;
	title: string;
	emptyText: string;
	getJobs: () => MonitoredJob[];
};

type Filter = "all" | "failed" | string;

const STATUS_KEY = "background-jobs";
const FAILED_STATUSES = new Set(["failed", "timed_out"]);

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

function compactText(text: string, maxLength = 32): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function lastNonEmptyLines(text: string | undefined, maxLines: number): string[] {
	const lines = (text ?? "").trimEnd().split(/\r?\n/).filter((line) => line.trim().length > 0);
	return lines.slice(-maxLines);
}

function statusColor(theme: ExtensionContext["ui"]["theme"], status: string): Parameters<typeof theme.fg>[0] {
	if (status === "running") return "accent";
	if (status === "exited") return "success";
	if (status === "cancelled") return "dim";
	return "warning";
}

function jobKey(sourceId: string, jobId: string): string {
	return `${sourceId}:${jobId}`;
}

type TuiLike = {
	requestRender: () => void;
};

class JobsOverlay implements Component, Focusable {
	focused = false;
	private scrollTop = 0;
	private lastBodyLength = 0;
	private followTop = true;

	constructor(
		private readonly tui: TuiLike,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly getFilter: () => Filter,
		private readonly setFilter: (filter: Filter) => void,
		private readonly renderBody: () => string[],
		private readonly sourceIds: () => string[],
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.done();
			return;
		}
		if (matchesKey(data, "up")) {
			this.scrollBy(-1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.scrollBy(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollBy(-8);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollBy(8);
			return;
		}
		if (matchesKey(data, "home")) {
			this.scrollTo(0);
			return;
		}
		if (matchesKey(data, "end")) {
			this.scrollTo(Number.MAX_SAFE_INTEGER);
			return;
		}

		const sourceIds = this.sourceIds();
		const key = data.toLowerCase();
		const nextFilter = key === "a" ? "all" : key === "f" ? "failed" : key === "s" && sourceIds.includes("shell") ? "shell" : key === "g" && sourceIds.includes("agents") ? "agents" : undefined;
		if (nextFilter) {
			this.setFilter(nextFilter);
			this.followTop = true;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const divider = this.theme.fg("borderMuted", "│");
		const contentWidth = Math.max(20, width - 2);
		const rule = this.theme.fg("borderMuted", "─".repeat(Math.max(0, contentWidth)));
		const line = (content: string) => truncateToWidth(`${divider} ${content}`, width);
		const body = this.renderBody();
		const viewportLines = 20;
		this.lastBodyLength = body.length;
		const maxTop = Math.max(0, body.length - viewportLines);
		if (this.followTop) this.scrollTop = 0;
		this.scrollTop = Math.max(0, Math.min(maxTop, this.scrollTop));

		const range = body.length > viewportLines ? ` · ${this.scrollTop + 1}-${Math.min(body.length, this.scrollTop + viewportLines)}/${body.length}` : "";
		const filter = this.getFilter();
		const sourceKeys = this.sourceIds();
		const filterHelp = [`a all`, sourceKeys.includes("shell") ? "s shell" : undefined, sourceKeys.includes("agents") ? "g agents" : undefined, "f failed"]
			.filter(Boolean)
			.join(" · ");
		const lines = [
			line(`${this.theme.fg("accent", "● jobs")} ${this.theme.fg("dim", `${filter} · ${filterHelp} · ↑↓ scroll · esc close${range}`)}`),
			line(rule),
		];

		const visibleBody = body.slice(this.scrollTop, this.scrollTop + viewportLines);
		while (visibleBody.length < viewportLines) visibleBody.push("");
		for (const bodyLine of visibleBody) lines.push(line(bodyLine));
		lines.push(line(rule));
		return lines;
	}

	invalidate(): void {
		// No cached render state.
	}

	private scrollBy(delta: number): void {
		const viewportLines = 20;
		const maxTop = Math.max(0, this.lastBodyLength - viewportLines);
		this.scrollTop = Math.max(0, Math.min(maxTop, this.scrollTop + delta));
		this.followTop = false;
		this.tui.requestRender();
	}

	private scrollTo(top: number): void {
		const viewportLines = 20;
		const maxTop = Math.max(0, this.lastBodyLength - viewportLines);
		this.scrollTop = Math.max(0, Math.min(maxTop, top));
		this.followTop = top <= 0;
		this.tui.requestRender();
	}
}

export function createJobsMonitor(pi: ExtensionAPI) {
	const sources = new Map<string, JobSource>();
	const acknowledgedFailures = new Set<string>();
	let statusCtx: ExtensionContext | undefined;
	let statusTimer: NodeJS.Timeout | undefined;
	let overlayVisible = false;
	let overlayDone: (() => void) | undefined;
	let overlayTui: TuiLike | undefined;
	let filter: Filter = "all";

	const stopTimer = () => {
		if (!statusTimer) return;
		clearInterval(statusTimer);
		statusTimer = undefined;
	};

	const sourceEntries = () => [...sources.values()];
	const sourceJobs = (source: JobSource) => source.getJobs().sort((a, b) => b.startedAt - a.startedAt);
	const allJobs = () => sourceEntries().flatMap((source) => sourceJobs(source).map((job) => ({ source, job })));
	const runningJobs = () => allJobs().filter(({ job }) => job.status === "running");
	const unacknowledgedFailures = () => allJobs().filter(({ source, job }) => FAILED_STATUSES.has(job.status) && !acknowledgedFailures.has(jobKey(source.id, job.id)));

	const visibleSources = () => {
		if (filter === "all" || filter === "failed") return sourceEntries();
		const source = sources.get(filter);
		return source ? [source] : sourceEntries();
	};

	const visibleJobs = (source: JobSource) => {
		const jobs = sourceJobs(source);
		if (filter === "failed") return jobs.filter((job) => FAILED_STATUSES.has(job.status));
		return jobs;
	};

	const renderJobs = (ctx: ExtensionContext): string[] => {
		const theme = ctx.ui.theme;
		const lines: string[] = [];
		let wroteAny = false;

		for (const source of visibleSources()) {
			const jobs = visibleJobs(source);
			lines.push(theme.fg("muted", ` ${source.title}`));
			if (jobs.length === 0) {
				lines.push(theme.fg("dim", `  ${source.emptyText}`));
				continue;
			}

			wroteAny = true;
			for (const job of jobs.slice(0, 5)) {
				const elapsedUntil = job.endedAt ?? Date.now();
				const elapsed = formatDuration(elapsedUntil - job.startedAt);
				lines.push(`${theme.fg(statusColor(theme, job.status), job.status.padEnd(9))} ${job.id} ${theme.fg("dim", elapsed.padStart(6))} ${compactText(job.label, 72)}`);

				for (const tailLine of lastNonEmptyLines(job.tail, 2)) {
					lines.push(theme.fg("dim", `  │ ${compactText(tailLine, 86)}`));
				}
			}
			if (jobs.length > 5) lines.push(theme.fg("dim", `  … ${jobs.length - 5} more`));
		}

		if (!wroteAny && filter === "failed") lines.push(theme.fg("dim", "  no failed background jobs"));
		return lines;
	};

	const updateOverlay = () => {
		if (!overlayVisible || !statusCtx?.hasUI) return;
		overlayTui?.requestRender();
	};

	const update = (ctx?: ExtensionContext) => {
		if (ctx?.hasUI) statusCtx = ctx;
		if (!statusCtx?.hasUI) return;

		const running = runningJobs();
		const failed = unacknowledgedFailures();
		const theme = statusCtx.ui.theme;

		if (running.length === 0 && failed.length === 0) {
			statusCtx.ui.setStatus(STATUS_KEY, undefined);
			updateOverlay();
			stopTimer();
			return;
		}

		const parts: string[] = [];
		if (running.length > 0) parts.push(`${running.length} running`);
		if (failed.length > 0) parts.push(`${failed.length} failed`);
		const icon = failed.length > 0 && running.length === 0 ? "⚠ " : running.length > 0 ? "● " : "⚠ ";
		const iconColor: Parameters<typeof theme.fg>[0] = failed.length > 0 && running.length === 0 ? "warning" : "accent";
		statusCtx.ui.setStatus(STATUS_KEY, theme.fg(iconColor, icon) + theme.fg("dim", `bg: ${parts.join(", ")}`));
		updateOverlay();

		if (running.length > 0 && !statusTimer) {
			statusTimer = setInterval(() => update(), 1000);
			statusTimer.unref?.();
		}
		if (running.length === 0) stopTimer();
	};

	const show = async (ctx: ExtensionContext, nextFilter: Filter = filter) => {
		filter = nextFilter;
		statusCtx = ctx;
		update(ctx);

		if (overlayVisible) {
			updateOverlay();
			return;
		}

		overlayVisible = true;
		try {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					overlayTui = tui;
					overlayDone = done;
					return new JobsOverlay(
						tui,
						theme,
						done,
						() => filter,
						(next) => {
							filter = next;
						},
						() => renderJobs(ctx),
						() => [...sources.keys()],
					);
				},
				{
					overlay: true,
					onHandle: (handle) => handle.focus(),
					overlayOptions: {
						anchor: "right-center",
						width: "48%",
						minWidth: 50,
						maxHeight: "85%",
						margin: 1,
					},
				},
			);
		} finally {
			overlayVisible = false;
			overlayDone = undefined;
			overlayTui = undefined;
		}
	};

	const hide = () => {
		overlayDone?.();
		overlayVisible = false;
		overlayTui = undefined;
		overlayDone = undefined;
	};

	const clearFailures = () => {
		for (const { source, job } of allJobs()) {
			if (FAILED_STATUSES.has(job.status)) acknowledgedFailures.add(jobKey(source.id, job.id));
		}
	};

	const handleCommand = async (args: string, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const action = args.trim().toLowerCase();

		if (action === "clear") {
			clearFailures();
			update(ctx);
			return;
		}
		if (action === "close" || action === "hide") {
			hide();
			return;
		}
		if (action === "open") {
			await show(ctx, "all");
			return;
		}
		if (action === "failed") {
			await show(ctx, "failed");
			return;
		}
		if (sources.has(action)) {
			await show(ctx, action);
			return;
		}

		if (overlayVisible && filter === "all") hide();
		else await show(ctx, "all");
	};

	pi.on("session_start", (_event, ctx) => {
		update(ctx);
	});

	pi.on("session_shutdown", async () => {
		statusCtx?.ui.setStatus(STATUS_KEY, undefined);
		hide();
		statusCtx = undefined;
		stopTimer();
	});

	pi.registerCommand("jobs", {
		description: "Show background work started by the main agent",
		handler: async (args, ctx) => handleCommand(args, ctx),
	});

	return {
		registerSource(source: JobSource) {
			sources.set(source.id, source);
			return { update };
		},
		update,
	};
}
