import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { MARKDOWN_PATCH } from "./constants.ts";

const PLAIN_CODE_LANGS = new Set(["", "text", "plain", "plaintext"]);

type MarkdownToken = {
  type?: string;
  text?: string;
  lang?: string;
  depth?: number;
  tokens?: MarkdownToken[];
  ordered?: boolean;
  start?: number;
  loose?: boolean;
  items?: Array<{ task?: boolean; checked?: boolean; tokens?: MarkdownToken[] }>;
};

type MarkdownRuntime = {
  theme: {
    heading: (text: string) => string;
    codeBlock: (text: string) => string;
    codeBlockBorder: (text: string) => string;
    quote: (text: string) => string;
    quoteBorder: (text: string) => string;
    hr: (text: string) => string;
    listBullet: (text: string) => string;
    bold: (text: string) => string;
    italic: (text: string) => string;
    codeBlockIndent?: string;
    highlightCode?: (code: string, lang?: string) => string[];
  };
  getStylePrefix?: (styleFn: (text: string) => string) => string;
  renderInlineTokens?: (tokens: unknown[], styleContext?: unknown) => string;
};

type RenderToken = (this: MarkdownRuntime, token: unknown, width: number, nextTokenType?: string, styleContext?: unknown) => string[];
type PatchedMarkdownPrototype = { renderToken?: RenderToken; [MARKDOWN_PATCH]?: { original: RenderToken } };

function withGap(lines: string[], nextTokenType?: string): string[] {
  if (nextTokenType && nextTokenType !== "space") lines.push("");
  return lines;
}

function isToken(token: unknown, type: string): token is MarkdownToken {
  return typeof token === "object" && token !== null && (token as MarkdownToken).type === type;
}

function renderCodeBlock(md: MarkdownRuntime, token: MarkdownToken, width: number, next?: string): string[] {
  const code = token.text ?? "";
  const lang = (token.lang ?? "").trim();

  if (PLAIN_CODE_LANGS.has(lang.toLowerCase()) || width < 12) {
    const indent = md.theme.codeBlockIndent ?? "  ";
    return withGap(code.split("\n").map((line) => indent + md.theme.codeBlock(line)), next);
  }

  const innerWidth = Math.max(1, width);
  const label = truncateToWidth(lang ? ` ${lang} ` : " code ", Math.max(0, width - 4), "");
  const topFill = Math.max(0, width - 2 - visibleWidth(label));
  const lines = [md.theme.codeBlockBorder(`╭${label}${"─".repeat(topFill)}╮`)];
  const highlighted = md.theme.highlightCode ? md.theme.highlightCode(code, lang) : code.split("\n").map((line) => md.theme.codeBlock(line));

  for (const line of highlighted.length ? highlighted : [""]) {
    lines.push(truncateToWidth(line, innerWidth, ""));
  }
  lines.push(md.theme.codeBlockBorder(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
  return withGap(lines, next);
}

function renderHeading(md: MarkdownRuntime, token: MarkdownToken, width: number, next?: string, _styleContext?: unknown): string[] {
  const depth = Math.max(1, Math.min(6, Number(token.depth) || 1));
  const headingStyle = (text: string) => md.theme.heading(md.theme.bold(text));
  const headingStyleContext = {
    applyText: headingStyle,
    stylePrefix: md.getStylePrefix?.(headingStyle),
  };
  const text = md.renderInlineTokens?.(token.tokens ?? [], headingStyleContext) ?? headingStyle(token.text ?? "");

  if (depth === 1) {
    return withGap([
      truncateToWidth(text, width, ""),
      md.theme.hr("━".repeat(Math.min(width, Math.max(visibleWidth(token.text ?? text), 12)))),
    ], next);
  }

  const prefixes: Record<number, string> = {
    2: "▌ ",
    3: "▸ ",
    4: "▪ ",
    5: "• ",
    6: "· ",
  };
  return withGap([truncateToWidth(md.theme.heading(prefixes[depth] ?? "▸ ") + text, width, "")], next);
}

function renderList(md: MarkdownRuntime, token: MarkdownToken, width: number, styleContext?: unknown, depth = 0): string[] {
  const lines: string[] = [];
  const original = (Markdown.prototype as unknown as PatchedMarkdownPrototype)[MARKDOWN_PATCH]?.original;
  const indent = "  ".repeat(depth);

  for (let i = 0; i < (token.items ?? []).length; i++) {
    const item = token.items![i]!;
    const marker = item.task ? (item.checked ? "✓ " : "○ ") : token.ordered ? `${(token.start ?? 1) + i}. ` : "• ";
    const firstPrefix = indent + md.theme.listBullet(marker);
    const restPrefix = indent + " ".repeat(Math.max(1, visibleWidth(marker)));
    const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
    let wroteLine = false;

    for (const child of item.tokens ?? []) {
      if (isToken(child, "list")) {
        lines.push(...renderList(md, child, width, styleContext, depth + 1));
        wroteLine = true;
        continue;
      }

      const childLines = renderMarkdownToken(md, child, itemWidth, undefined, styleContext) ?? original?.call(md, child, itemWidth, undefined, styleContext) ?? [];
      for (const childLine of childLines) {
        if (childLine === "") continue;
        for (const wrapped of wrapTextWithAnsi(childLine, itemWidth)) {
          lines.push((wroteLine ? restPrefix : firstPrefix) + wrapped);
          wroteLine = true;
        }
      }
    }

    if (!wroteLine) lines.push(firstPrefix.trimEnd());
    if (token.loose && i < (token.items?.length ?? 0) - 1) lines.push("");
  }

  return lines;
}

function renderBlockquote(md: MarkdownRuntime, token: MarkdownToken, width: number, next?: string, styleContext?: unknown): string[] {
  const quoteWidth = Math.max(1, width - 3);
  const original = (Markdown.prototype as unknown as PatchedMarkdownPrototype)[MARKDOWN_PATCH]?.original;
  const rendered: string[] = [];

  for (const child of token.tokens ?? []) {
    rendered.push(...(renderMarkdownToken(md, child, quoteWidth, undefined, styleContext) ?? original?.call(md, child, quoteWidth, undefined, styleContext) ?? []));
  }
  while (rendered.at(-1) === "") rendered.pop();

  const lines = (rendered.length ? rendered : [""]).flatMap((line) =>
    wrapTextWithAnsi(line, quoteWidth).map((wrapped) => md.theme.quoteBorder("▌ ") + md.theme.quote(md.theme.italic(wrapped))),
  );
  return withGap(lines, next);
}

function renderMarkdownToken(md: MarkdownRuntime, token: unknown, width: number, next?: string, styleContext?: unknown): string[] | undefined {
  const original = (Markdown.prototype as unknown as PatchedMarkdownPrototype)[MARKDOWN_PATCH]?.original;

  if (isToken(token, "code")) return renderCodeBlock(md, token, width, next);
  if (isToken(token, "heading")) return renderHeading(md, token, width, next, styleContext);
  if (isToken(token, "list")) return renderList(md, token, width, styleContext);
  if (isToken(token, "blockquote")) return renderBlockquote(md, token, width, next, styleContext);
  if (isToken(token, "hr")) return withGap([md.theme.hr("╌".repeat(Math.min(width, 96)))], next);
  if (isToken(token, "table") && original) {
    return original.call(md, token, width, next, styleContext).map((line) =>
      line.replace(/[┌┬┐├┼┤└┴┘│─]/g, (char) => md.theme.codeBlockBorder(char)),
    );
  }

  return undefined;
}

export function installMarkdownPatch(): void {
  const proto = Markdown.prototype as unknown as PatchedMarkdownPrototype;
  if (proto[MARKDOWN_PATCH] || typeof proto.renderToken !== "function") return;

  const original = proto.renderToken;
  proto[MARKDOWN_PATCH] = { original };
  proto.renderToken = function (this: MarkdownRuntime, token: unknown, width: number, next?: string, styleContext?: unknown): string[] {
    return renderMarkdownToken(this, token, width, next, styleContext) ?? original.call(this, token, width, next, styleContext);
  };
}
