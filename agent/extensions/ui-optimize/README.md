# UI Optimize

Local Pi UI polish extension installed at:

```text
~/.pi/agent/extensions/ui-optimize
```

Pi auto-discovers this directory through `index.ts`. Use `/reload` after editing; if prototype patches look stale, restart Pi for a clean process.

The collapsed activity grouping in `tool-groups.ts` is a best-effort internal runtime patch against Pi's interactive components. If a future Pi release changes those internal component paths or shapes, the extension skips that patch instead of crashing startup.

## Features

- Markdown rendering polish for headings, code blocks, lists, quotes, rules, and tables.
- Compact pre-answer activity summaries while tools are collapsed:
  - groups consecutive pre-answer `thinking` and tool-call activity until the next assistant text reply;
  - shows a one-line thinking preview inside the summary;
  - preserves expanded thinking/tool output when the user toggles expansion.
- Image paste workflow:
  - clipboard image/file paths become `[imageN]` tokens in the editor;
  - tokens are rendered compactly;
  - tokens expand back to paths on submit;
  - the editor is installed as a wrapper around any existing custom editor, so it can compose with `command-aliases.ts`.

## Files

- `index.ts` wires the extension into Pi events.
- `markdown.ts` patches Pi TUI Markdown rendering.
- `tool-groups.ts` patches Pi interactive tool/thinking rows into compact summaries.
- `images.ts` wraps the editor for image-token paste handling.
- `runtime-imports.ts` centralizes best-effort imports of Pi internal interactive runtime modules.
- `paths.ts` resolves the installed Pi coding-agent root for runtime imports.
- `constants.ts` contains shared patch symbols and image token regexes.
