/**
 * Side chat commands.
 *
 * /btw and /side open a temporary no-tools explanatory agent in an overlay.
 * It is intentionally separate from the main conversation and cannot execute tools.
 */

import { complete, type AssistantMessage, type UserMessage } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";

type ChatRole = "user" | "assistant" | "system";

type ChatItem = {
	role: ChatRole;
	text: string;
};

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

type TuiLike = {
	requestRender: () => void;
};

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
		.slice(-20);
	if (!entries.length) return "No main-agent tool executions have been observed yet.";

	const now = Date.now();
	return entries
		.map((entry) => {
			const elapsed = Math.max(0, Math.round(((entry.endedAt ?? now) - entry.startedAt) / 1000));
			const lines = [`- ${entry.toolName} (${entry.status}${entry.isError ? ", error" : ""}, ${elapsed}s, id=${entry.id})`];
			const args = compactValue(entry.args, 700);
			if (args) lines.push(`  args: ${args}`);
			const partial = compactValue(entry.partialResult, 900);
			if (entry.status === "running" && partial) lines.push(`  latest update: ${partial}`);
			const result = compactValue(entry.result, 900);
			if (entry.status === "finished" && result) lines.push(`  result: ${result}`);
			return lines.join("\n");
		})
		.join("\n");
}

function pruneMainToolProgress(): void {
	const entries = [...mainToolProgress.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	for (const entry of entries.slice(40)) mainToolProgress.delete(entry.id);
}

const SYSTEM_PROMPT = `You are a temporary side-chat agent embedded inside pi.

Purpose:
- Explain concepts, clarify trade-offs, answer side questions, and help the user think.
- Stay lightweight and conversational.

Constraints:
- You have no tools and cannot execute commands, inspect files, or modify anything.
- Do not claim that you performed actions. If execution or code inspection is needed, tell the user to ask the main agent.
- Keep answers concise unless the user asks for detail.
- Use the provided recent main conversation context only as background.
- You may also receive a live snapshot of the main agent's current/recent tool executions. Treat it as observational context, not as work you performed.`;

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: string; text?: string };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function recentConversationContext(ctx: ExtensionCommandContext): string {
	const entries = ctx.sessionManager.getBranch();
	const sections: string[] = [];

	for (let i = Math.max(0, entries.length - 16); i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = extractText(message.content).trim();
		if (!text) continue;
		sections.push(`${message.role === "user" ? "User" : "Main assistant"}: ${text}`);
	}

	const context = sections.join("\n\n");
	return context.length > 12000 ? context.slice(-12000) : context;
}

function printableText(data: string): string {
	if (!data || data.startsWith("\x1b")) return "";
	// Keep paste chunks usable, but strip control characters handled as shortcuts above.
	return data.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function deleteLastWord(text: string): string {
	return text.replace(/\s*\S+\s*$/, "");
}

class SideChatComponent implements Component, Focusable {
	focused = false;
	private messages: ChatItem[] = [];
	private input = "";
	private busy = false;
	private error?: string;
	private scrollTop = 0;
	private followBottom = true;
	private lastBodyLength = 0;

	constructor(
		private readonly tui: TuiLike,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly onSend: (text: string) => Promise<string>,
		initialQuestion?: string,
	) {
		if (initialQuestion?.trim()) {
			queueMicrotask(() => void this.send(initialQuestion.trim()));
		}
	}

	private async send(text: string): Promise<void> {
		if (this.busy || !text.trim()) return;
		this.input = "";
		this.error = undefined;
		this.busy = true;
		this.messages.push({ role: "user", text });
		this.tui.requestRender();

		try {
			const answer = await this.onSend(text);
			this.messages.push({ role: "assistant", text: answer.trim() || "(empty response)" });
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			this.messages.push({ role: "system", text: `Error: ${this.error}` });
		} finally {
			this.busy = false;
			this.tui.requestRender();
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
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
			this.followBottom = true;
			this.tui.requestRender();
			return;
		}
		if (this.busy) return;

		if (matchesKey(data, "enter")) {
			const text = this.input.trim();
			if (["exit", "quit", "/exit", "/quit"].includes(text.toLowerCase())) {
				this.done();
				return;
			}
			void this.send(text);
			return;
		}
		if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
			this.input = this.input.slice(0, -1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			this.input = "";
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+w")) {
			this.input = deleteLastWord(this.input);
			this.tui.requestRender();
			return;
		}

		const text = printableText(data).replace(/[\r\n]+/g, " ");
		if (text) {
			this.input += text;
			this.tui.requestRender();
		}
	}

	private scrollBy(delta: number): void {
		const viewportLines = this.bodyViewportLines();
		const maxTop = Math.max(0, this.lastBodyLength - viewportLines);
		this.scrollTop = Math.max(0, Math.min(maxTop, this.scrollTop + delta));
		this.followBottom = this.scrollTop >= maxTop;
		this.tui.requestRender();
	}

	private scrollTo(top: number): void {
		const viewportLines = this.bodyViewportLines();
		const maxTop = Math.max(0, this.lastBodyLength - viewportLines);
		this.scrollTop = Math.max(0, Math.min(maxTop, top));
		this.followBottom = this.scrollTop >= maxTop;
		this.tui.requestRender();
	}

	private bodyViewportLines(): number {
		return 20;
	}

	private buildBody(innerWidth: number): string[] {
		const body: string[] = [];
		const mdTheme = getMarkdownTheme();

		for (const message of this.messages) {
			if (message.role === "system" && !message.text.startsWith("Error:")) continue;

			if (message.role === "user") {
				const wrapped = wrapTextWithAnsi(message.text || " ", Math.max(10, innerWidth - 6));
				const label = this.theme.fg("accent", "you ›");
				body.push(`${label} ${wrapped[0] ?? ""}`);
				for (const line of wrapped.slice(1)) body.push(`      ${line}`);
			} else if (message.role === "assistant") {
				body.push(this.theme.fg("success", "side ›"));
				const markdown = new Markdown(message.text || " ", 0, 0, mdTheme);
				body.push(...markdown.render(Math.max(10, innerWidth - 2)).map((line) => `  ${line}`));
			} else {
				for (const line of wrapTextWithAnsi(message.text, innerWidth)) body.push(this.theme.fg("dim", line));
			}
			body.push("");
		}

		if (this.messages.length === 0) {
			body.push(this.theme.fg("dim", "Ask a quick side question. This chat has no tools and will not touch the main thread."), "");
		}
		if (this.busy) body.push(this.theme.fg("dim", "thinking…"), "");
		return body;
	}

	render(width: number): string[] {
		const divider = this.theme.fg("borderMuted", "│");
		const contentWidth = Math.max(20, width - 2);
		const rule = this.theme.fg("borderMuted", "─".repeat(Math.max(0, contentWidth)));
		const lines: string[] = [];
		const line = (content: string) => truncateToWidth(`${divider} ${content}`, width);

		const body = this.buildBody(contentWidth);
		const viewportLines = this.bodyViewportLines();
		this.lastBodyLength = body.length;
		const maxTop = Math.max(0, body.length - viewportLines);
		if (this.followBottom) this.scrollTop = maxTop;
		this.scrollTop = Math.max(0, Math.min(maxTop, this.scrollTop));

		const range = body.length > viewportLines ? ` · ${this.scrollTop + 1}-${Math.min(body.length, this.scrollTop + viewportLines)}/${body.length}` : "";
		const status = this.busy ? "thinking" : "no tools";
		lines.push(line(`${this.theme.fg("accent", "✦ side")} ${this.theme.fg("dim", `${status} · ↑↓ scroll · esc close${range}`)}`));
		lines.push(line(rule));

		const visibleBody = body.slice(this.scrollTop, this.scrollTop + viewportLines);
		while (visibleBody.length < viewportLines) visibleBody.push("");
		for (const bodyLine of visibleBody) {
			lines.push(line(bodyLine));
		}

		lines.push(line(rule));
		const prompt = this.busy ? this.theme.fg("dim", "waiting for response…") : `${this.theme.fg("accent", "›")} ${this.input}${this.focused ? CURSOR_MARKER : ""}`;
		for (const promptLine of wrapTextWithAnsi(prompt, contentWidth)) {
			lines.push(line(promptLine));
		}
		return lines;
	}

	invalidate(): void {
		// No cached render state.
	}
}

async function openSideChat(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/side requires interactive TUI mode", "error");
		return;
	}
	if (!ctx.model) {
		ctx.ui.notify("No model selected", "error");
		return;
	}

	const model = ctx.model;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		ctx.ui.notify(auth.ok ? `No API key for ${model.provider}` : auth.error, "error");
		return;
	}

	const context = recentConversationContext(ctx);
	const messages: Array<UserMessage | AssistantMessage> = [];
	if (context) {
		messages.push({
			role: "user",
			content: [{ type: "text", text: `Recent main conversation context for background only:\n\n${context}` }],
			timestamp: Date.now(),
		} as UserMessage);
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: "Understood. I will use this only as background context for concise side explanations." }],
			timestamp: Date.now(),
		} as AssistantMessage);
	}

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const send = async (text: string) => {
				const progress = formatMainToolProgress();
				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: `Current main-agent tool progress snapshot:\n\n${progress}\n\nSide-chat question:\n${text}` }],
					timestamp: Date.now(),
				};
				messages.push(userMessage);

				const response = await complete(
					model,
					{ systemPrompt: SYSTEM_PROMPT, messages },
					{ apiKey: auth.apiKey, headers: auth.headers },
				);

				const answer = response.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n");

				messages.push({
					role: "assistant",
					content: [{ type: "text", text: answer }],
					timestamp: Date.now(),
				} as AssistantMessage);
				return answer;
			};

			return new SideChatComponent(tui, theme, done, send, args);
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
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", async () => {
		mainToolProgress.clear();
	});

	pi.on("tool_execution_start", async (event) => {
		mainToolProgress.set(event.toolCallId, {
			id: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			status: "running",
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});
		pruneMainToolProgress();
	});

	pi.on("tool_execution_update", async (event) => {
		const existing = mainToolProgress.get(event.toolCallId);
		if (!existing) {
			mainToolProgress.set(event.toolCallId, {
				id: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
				status: "running",
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
			return;
		}
		existing.args = event.args ?? existing.args;
		existing.partialResult = event.partialResult;
		existing.updatedAt = Date.now();
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
	});

	const command = {
		description: "Open a temporary no-tools side chat for explanations",
		handler: async (args: string, ctx: ExtensionCommandContext) => openSideChat(args, ctx),
	};

	pi.registerCommand("side", command);
	pi.registerCommand("btw", command);
}
