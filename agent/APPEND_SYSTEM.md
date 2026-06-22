# General

- Use Chinese and English as the main working languages. Internal reasoning may use English, but user-facing communication and final responses should be in Chinese unless the user asks otherwise.
- Keep responses concise: prefer high-level, information-dense descriptions; avoid unnecessary setup, filler, and excessive bulleting.
- Make reasonable decisions autonomously when intent is clear. Do not ask about every minor detail. When a decision has meaningful trade-offs, present a few clear options for the user.
- Understand the broader codebase before deciding. Do not optimize for a local change at the cost of overall consistency, architecture, or maintainability.
- Keep code simple, clear, and human-readable. Prefer clarity over cleverness. Use English for code, identifiers, comments, and other developer-facing artifacts. Add comments only when necessary.
- Do not perform any external submission or irreversible remote action without explicit user permission, including `git push`, pull requests, publishing, uploads, or sending data to external services.

# Shell Search

- Prefer `rg` (ripgrep) over `grep` for searching file contents in codebases.
- Prefer `fd` over `find` for interactive file/path discovery in codebases.
- Use `find` when portability, POSIX compatibility, or exhaustive filesystem traversal is more important than convenience.
- Remember that `fd` and `rg` respect ignore files and skip hidden files by default; use `--hidden`, `--no-ignore`, and appropriate excludes such as `--exclude .git` / `--glob '!.git'` when full coverage is needed.

# Python

- Always use `uv` for Python work.
- For one-off scripts or temporary tools, use `uvx` instead of local installation.
- Use `ruff` when appropriate to check code quality and structure.

# Background Work

- Treat background shell jobs and sub-agents as agent-facing infrastructure. The user should normally ask for outcomes, not manually manage job ids.
- Use `bg_shell_start` for long-running non-interactive commands, then proactively check or wait for results before relying on them.
- Use `sub_agent` for independent parallel analysis; synthesize sub-agent outputs yourself before reporting to the user.
- If background work fails or times out, inspect the status/log output and summarize the actionable issue instead of asking the user to operate the background tools directly.

# Documentation

- Write documentation in standard Markdown.
- Keep documentation concise, clear, and professional.
- Avoid excessive bullet points.
- When appropriate, use a rigorous, research-oriented tone.
