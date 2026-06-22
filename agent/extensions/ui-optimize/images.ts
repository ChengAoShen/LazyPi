import { spawnSync } from "node:child_process";

import type { AppKeybinding, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, getKeybindings, matchesKey, truncateToWidth, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

import { CLIPBOARD_PATH_RE, IMAGE_FILE_RE, MACOS_CLIPBOARD_FILE_PATHS_SCRIPT, TOKEN_LINE_RE, TOKEN_RE } from "./constants.ts";

type Attachment = { token: string; path: string };
type EditorInternals = {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  historyIndex: number;
  lastAction: string | null;
  pushUndoSnapshot: () => void;
  setCursorCol: (col: number) => void;
};

function imageToken(id: number): string {
  return `[image${id}]`;
}

function renderImageToken(token: string, theme: Theme): string {
  return theme.fg("toolDiffAdded", theme.inverse(token));
}

function readClipboardFilePaths(): string[] {
  if (process.platform !== "darwin") return [];

  const result = spawnSync("osascript", ["-l", "JavaScript", "-e", MACOS_CLIPBOARD_FILE_PATHS_SCRIPT], {
    encoding: "utf8",
    timeout: 700,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return [];

  try {
    const parsed: unknown = JSON.parse(result.stdout.trim() || "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((path): path is string => typeof path === "string" && path.length > 0))];
  } catch {
    return [];
  }
}

class ImageTokenController {
  constructor(private readonly attachments: Map<string, Attachment>) {}

  render(lines: string[], theme: Theme, width: number): string[] {
    if (this.attachments.size === 0) return lines;

    let rendered = lines;
    for (const attachment of this.attachments.values()) {
      rendered = rendered.map((line) => line.replaceAll(attachment.token, renderImageToken(attachment.token, theme)));
    }
    return rendered.map((line) => truncateToWidth(line, width, ""));
  }

  replaceClipboardPaths(text: string, existingText = ""): string {
    const usedIds = this.collectUsedIds(`${existingText}\n${text}`);
    return text.replace(CLIPBOARD_PATH_RE, (path) => this.create(path, usedIds));
  }

  formatClipboardPaths(paths: string[], existingText = ""): string {
    const usedIds = this.collectUsedIds(existingText);
    const pieces = paths.map((path) => IMAGE_FILE_RE.test(path) ? this.create(path, usedIds).trimEnd() : path);
    return pieces.length > 0 ? `${pieces.join(paths.length > 1 ? "\n" : "")} ` : "";
  }

  replaceClipboardPathsInEditor(editor: EditorComponent, tui: TUI): void {
    const current = editor.getText();
    const next = this.replaceClipboardPaths(current);
    if (next === current) return;
    editor.setText(next);
    tui.requestRender();
  }

  deleteTokenAtCursor(editor: EditorComponent, data: string, tui: TUI): boolean {
    const keybindings = getKeybindings();
    const backward = keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace");
    const forward = keybindings.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete");
    if (!backward && !forward) return false;

    const writable = editor as unknown as Partial<EditorInternals>;
    if (!writable.state || !writable.pushUndoSnapshot || !writable.setCursorCol) return false;

    const line = writable.state.lines[writable.state.cursorLine] || "";
    const range = this.findDeleteRange(line, writable.state.cursorCol, backward);
    if (!range) return false;

    writable.historyIndex = -1;
    writable.lastAction = null;
    writable.pushUndoSnapshot();
    writable.state.lines[writable.state.cursorLine] = line.slice(0, range.start) + line.slice(range.end);
    writable.setCursorCol(range.start);
    this.attachments.delete(range.token);
    editor.onChange?.(editor.getText());
    tui.requestRender();
    return true;
  }

  private collectUsedIds(text: string): Set<number> {
    const ids = new Set<number>();
    for (const match of text.matchAll(TOKEN_RE)) ids.add(Number(match[1]));
    return ids;
  }

  private create(path: string, usedIds: Set<number>): string {
    let id = 1;
    while (usedIds.has(id)) id++;
    usedIds.add(id);
    const token = imageToken(id);
    this.attachments.set(token, { token, path });
    return `${token} `;
  }

  private findDeleteRange(line: string, cursorCol: number, backward: boolean): { start: number; end: number; token: string } | undefined {
    for (const match of line.matchAll(TOKEN_LINE_RE)) {
      const token = match[0];
      const start = match.index;
      let end = start + token.length;
      if (backward) {
        if (start < cursorCol && cursorCol <= end) return { start, end, token };
        if (cursorCol === end + 1 && line[end] === " ") return { start, end: end + 1, token };
      } else if (start <= cursorCol && cursorCol < end) {
        if (line[end] === " ") end++;
        return { start, end, token };
      }
    }
    return undefined;
  }
}

function pasteClipboardPaths(editor: EditorComponent, imageTokens: ImageTokenController, tui: TUI): boolean {
  const paths = readClipboardFilePaths();
  if (paths.length === 0) return false;

  const text = imageTokens.formatClipboardPaths(paths, editor.getText());
  if (!text) return false;

  if (editor.insertTextAtCursor) editor.insertTextAtCursor(text);
  else {
    editor.setText(editor.getText() + text);
    editor.onChange?.(editor.getText());
  }
  tui.requestRender();
  return true;
}

type AppActionTarget = {
  keybindings: KeybindingsManager;
  actionHandlers: Map<AppKeybinding, () => void>;
  onEscape?: () => void;
  onCtrlD?: () => void;
  getText: () => string;
  isShowingAutocomplete: () => boolean;
};

function handleAppAction(target: AppActionTarget, data: string): boolean {
  if (target.keybindings.matches(data, "app.interrupt") && !target.isShowingAutocomplete()) {
    const handler = target.onEscape ?? target.actionHandlers.get("app.interrupt");
    if (handler) {
      handler();
      return true;
    }
  }

  if (target.keybindings.matches(data, "app.exit") && target.getText().length === 0) {
    const handler = target.onCtrlD ?? target.actionHandlers.get("app.exit");
    if (handler) {
      handler();
      return true;
    }
  }

  for (const [action, handler] of target.actionHandlers) {
    if (action !== "app.interrupt" && action !== "app.exit" && target.keybindings.matches(data, action)) {
      handler();
      return true;
    }
  }
  return false;
}

class ImageEditor extends Editor {
  actionHandlers = new Map<AppKeybinding, () => void>();
  private scanTimers: Array<ReturnType<typeof setTimeout>> = [];
  onEscape: (() => void) | undefined;
  onCtrlD: (() => void) | undefined;
  onPasteImage: (() => void) | undefined;
  onExtensionShortcut: ((data: string) => boolean) | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    readonly keybindings: KeybindingsManager,
    private readonly imageTokens: ImageTokenController,
    private readonly getTheme: () => Theme,
  ) {
    super(tui, theme);
  }

  onAction(action: AppKeybinding, handler: () => void): void {
    this.actionHandlers.set(action, handler);
  }

  handleInput(data: string): void {
    if (this.onExtensionShortcut?.(data)) return;
    if (this.imageTokens.deleteTokenAtCursor(this, data, this.tui)) return;

    if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
      if (pasteClipboardPaths(this, this.imageTokens, this.tui)) return;
      this.onPasteImage?.();
      this.scheduleScan();
      return;
    }

    if (this.handleAppAction(data)) return;
    super.handleInput(data);
  }

  insertTextAtCursor(text: string): void {
    super.insertTextAtCursor(this.imageTokens.replaceClipboardPaths(text, this.getText()));
  }

  render(width: number): string[] {
    return this.imageTokens.render(super.render(width), this.getTheme(), width);
  }

  private handleAppAction(data: string): boolean {
    return handleAppAction(this, data);
  }

  private scheduleScan(): void {
    for (const timer of this.scanTimers) clearTimeout(timer);
    this.scanTimers = [80, 250, 600].map((delay) => setTimeout(() => this.imageTokens.replaceClipboardPathsInEditor(this, this.tui), delay));
  }
}

class ImageEditorWrapper implements EditorComponent {
  actionHandlers = new Map<AppKeybinding, () => void>();
  private scanTimers: Array<ReturnType<typeof setTimeout>> = [];
  private _onSubmit: ((text: string) => void) | undefined;
  private _onChange: ((text: string) => void) | undefined;
  onEscape: (() => void) | undefined;
  onCtrlD: (() => void) | undefined;
  onPasteImage: (() => void) | undefined;
  onExtensionShortcut: ((data: string) => boolean) | undefined;

  constructor(
    private readonly inner: EditorComponent,
    private readonly tui: TUI,
    readonly keybindings: KeybindingsManager,
    private readonly imageTokens: ImageTokenController,
    private readonly getTheme: () => Theme,
  ) {}

  get focused(): boolean { return Boolean((this.inner as EditorComponent & { focused?: boolean }).focused); }
  set focused(value: boolean) { (this.inner as EditorComponent & { focused?: boolean }).focused = value; }
  get borderColor(): ((str: string) => string) | undefined { return this.inner.borderColor; }
  set borderColor(value: ((str: string) => string) | undefined) { this.inner.borderColor = value; }
  get onSubmit(): ((text: string) => void) | undefined { return this._onSubmit; }
  set onSubmit(handler: ((text: string) => void) | undefined) { this._onSubmit = handler; this.inner.onSubmit = handler; }
  get onChange(): ((text: string) => void) | undefined { return this._onChange; }
  set onChange(handler: ((text: string) => void) | undefined) { this._onChange = handler; this.inner.onChange = handler; }

  getText(): string { return this.inner.getText(); }
  setText(text: string): void { this.inner.setText(text); }
  getExpandedText(): string { return this.inner.getExpandedText?.() ?? this.inner.getText(); }
  addToHistory(text: string): void { this.inner.addToHistory?.(text); }
  setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]): void { this.inner.setAutocompleteProvider?.(provider); }
  setPaddingX(padding: number): void { this.inner.setPaddingX?.(padding); }
  setAutocompleteMaxVisible(maxVisible: number): void { this.inner.setAutocompleteMaxVisible?.(maxVisible); }
  onAction(action: AppKeybinding, handler: () => void): void { this.actionHandlers.set(action, handler); }
  invalidate(): void { this.inner.invalidate?.(); }

  insertTextAtCursor(text: string): void {
    const next = this.imageTokens.replaceClipboardPaths(text, this.inner.getText());
    if (this.inner.insertTextAtCursor) this.inner.insertTextAtCursor(next);
    else {
      this.inner.setText(this.inner.getText() + next);
      this.inner.onChange?.(this.inner.getText());
    }
  }

  render(width: number): string[] {
    return this.imageTokens.render(this.inner.render(width), this.getTheme(), width);
  }

  handleInput(data: string): void {
    if (this.onExtensionShortcut?.(data)) return;
    if (this.imageTokens.deleteTokenAtCursor(this.inner, data, this.tui)) return;

    if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
      if (pasteClipboardPaths(this, this.imageTokens, this.tui)) return;
      this.onPasteImage?.();
      this.scheduleScan();
      return;
    }

    if (this.handleAppAction(data)) return;
    this.inner.handleInput(data);
  }

  private handleAppAction(data: string): boolean {
    return handleAppAction(this, data);
  }

  isShowingAutocomplete(): boolean {
    return (this.inner as EditorComponent & { isShowingAutocomplete?: () => boolean }).isShowingAutocomplete?.() ?? false;
  }

  private scheduleScan(): void {
    for (const timer of this.scanTimers) clearTimeout(timer);
    this.scanTimers = [80, 250, 600].map((delay) => setTimeout(() => this.imageTokens.replaceClipboardPathsInEditor(this.inner, this.tui), delay));
  }
}

function collectImageAttachments(text: string, attachments: Map<string, Attachment>): Attachment[] {
  const selected: Attachment[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = imageToken(Number(match[1]));
    const attachment = attachments.get(token);
    if (!attachment || seen.has(token)) continue;
    seen.add(token);
    selected.push(attachment);
  }
  return selected;
}

export function createImageIntegration() {
  const attachments = new Map<string, Attachment>();

  return {
    clear(): void {
      attachments.clear();
    },

    createEditorFactory(ctx: { ui: { getEditorComponent: () => (((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined); theme: Theme } }) {
      const previousEditorFactory = ctx.ui.getEditorComponent();
      const imageTokens = new ImageTokenController(attachments);
      return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager): EditorComponent => {
        if (!previousEditorFactory) return new ImageEditor(tui, theme, keybindings, imageTokens, () => ctx.ui.theme);
        return new ImageEditorWrapper(previousEditorFactory(tui, theme, keybindings), tui, keybindings, imageTokens, () => ctx.ui.theme);
      };
    },

    transformInput(text: string): { action: "continue" } | { action: "transform"; text: string } {
      const selected = collectImageAttachments(text, attachments);
      if (selected.length === 0) return { action: "continue" };

      const transformed = text.replace(TOKEN_RE, (full, id) => attachments.get(imageToken(Number(id)))?.path ?? full);
      for (const attachment of selected) attachments.delete(attachment.token);
      return { action: "transform", text: transformed };
    },
  };
}
