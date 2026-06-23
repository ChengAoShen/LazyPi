# UI Optimize

Local UI polish extension.

## Features

- Markdown rendering polish.
- Aggregated activity blocks for collapsed tool calls and hidden thinking.
- Hidden thinking is rendered as aligned list rows by default, matching tool rows.
- Compact image paste tokens such as `[image1]`.

## Activity blocks

`tool-groups.ts` groups consecutive hidden thinking and collapsed tool calls until the next assistant text reply. The block stays compact but keeps thinking readable as one row per thinking entry:

```text
╭─ activity ─────────────────────────╮
│ 💭 thinking ×10   10 items         │
│   … 2 earlier thinking items       │
│   · think 3     Need context...    │
│   · think 4     Keep /jobs small   │
│ 🛠 tools ×3      ✓2  …1            │
│   ✓ read        file.ts            │
│   … bash        npm test           │
╰────────────────────────── Ctrl+O/T ╯
```

Both thinking rows and tool rows use the same “show latest rows, fold older rows” policy. Expanded native tool/thinking output is still preserved when Pi expands the original components.

## Files

- `index.ts` wires the extension into Pi events.
- `markdown.ts` patches Pi TUI Markdown rendering.
- `tool-groups.ts` patches Pi interactive tool/thinking rows into compact activity summaries.
- `images.ts` wraps the editor for image-token paste handling.
- `runtime-imports.ts` centralizes best-effort imports of Pi internal interactive runtime modules.
- `paths.ts` resolves the installed Pi coding-agent root for runtime imports.
- `constants.ts` contains shared patch symbols and image token regexes.
