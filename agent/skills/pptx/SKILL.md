---
name: pptx
description: Work with PowerPoint presentations. Use when the user asks to create, read, summarize, inspect, edit, merge, split, repair, convert, or QA a PPT/PPTX deck; mentions slides, slide deck, presentation, template, speaker notes, or a .ppt/.pptx file; or wants research/content converted into slides.
---

# PPTX / PowerPoint Skill

Use this skill whenever a PowerPoint deck is input or output. Prefer `.pptx` for generated or edited files; `.ppt` may need conversion with LibreOffice first.

## Core Principles

- Understand the deck purpose, audience, language, tone, and expected length before creating or editing.
- For existing decks, inspect both textual content and visual layout before making changes.
- Preserve template structure, theme, fonts, slide masters, aspect ratio, and visual language unless the user asks for redesign.
- Keep the deck visually clean and coherent: use a unified font system, consistent spacing, clear alignment, and a restrained color palette.
- Avoid generic bullet-only slides. Every slide should have a clear visual structure: cards, comparison columns, timelines, process flows, charts, icons, images, or strong callouts.
- Review each slide individually as a visual composition. Do not leave overlapping elements, inconsistent fonts, clipped text, excessive unused whitespace, cramped blocks, or unclear hierarchy.
- Do not invent factual claims, metrics, citations, logos, or image sources. If content is missing, ask or mark it as a placeholder.

## Common Tools

Align with pi's Python policy: **use `uv` / `uvx` for all Python work**. Do not use bare `python`, `pip`, or global Python installs in skill workflows.

Use available local tools as appropriate:

```bash
# Extract text from a deck using an ephemeral uv environment
uvx --with 'markitdown[pptx]' python -m markitdown input.pptx

# Run one-off Python inspection or manipulation scripts with explicit deps
uv run --with python-pptx --with lxml --with pillow script.py

# Convert PPT/PPTX to PDF or images for inspection
soffice --headless --convert-to pdf input.pptx --outdir .
pdftoppm -jpeg -r 150 input.pdf slide
```

Preferred Python packages:

- `markitdown[pptx]` for text extraction
- `python-pptx` for creating and modifying simple decks
- `lxml` / `defusedxml` for careful OOXML inspection or advanced edits
- `pillow` for image sizing and thumbnails

If a dependency is missing, use `uvx` or `uv run --with ...` for temporary tooling. Ask before installing global packages. Use Node/PptxGenJS only when the user explicitly wants it or when Python tooling cannot satisfy the layout requirement.

## Reading / Analyzing a Deck

1. Extract text with `markitdown` or unzip the PPTX and inspect XML when detailed structure matters.
2. Render slides to images for visual inspection when layout, design, or QA matters. Prefer LibreOffice-based rendering when available because it catches many real PowerPoint layout issues.
3. Inspect each slide image for structure, spacing, typography consistency, overlaps, clipping, readability, and excessive blank areas.
4. Summarize:
   - deck title and purpose
   - slide-by-slide content
   - narrative flow
   - design strengths and issues
   - missing or inconsistent elements

## Editing an Existing Deck

Recommended workflow:

1. Back up the original file or create a new output file.
2. Inspect text and rendered slide images.
3. Map requested changes to exact slides.
4. For light edits, modify via office tools or by unpacking the `.pptx` archive and editing XML carefully.
5. For major redesigns, prefer `python-pptx` via `uv run --with python-pptx ...` when it is sufficient; use another generator only when it materially improves fidelity or layout control.
6. Re-render changed slides and verify visually. When possible, use LibreOffice to convert the deck to PDF/images and inspect the rendered output before finalizing.

When editing unpacked PPTX XML:

- Keep namespaces and relationship IDs valid.
- Edit slide XML, relationships, media, and content types consistently.
- Use valid XML escaping for `&`, `<`, `>`, quotes, and apostrophes.
- Avoid manually deleting referenced media or relationships without checking references.

## Creating a Deck From Scratch

Prefer a Python/uv workflow unless there is a strong reason to use another stack:

```bash
uv run --with python-pptx --with pillow create_deck.py
```

Before generating, form a slide plan:

```text
Audience:
Goal:
Tone:
Aspect ratio:
Slide count:
Visual theme:
Slide outline:
Data / citations needed:
```

Suggested structure:

1. Title / hook
2. Context or problem
3. Key insight / thesis
4. Supporting evidence or framework
5. Method / plan / product / solution
6. Comparison, results, or business impact
7. Risks / limitations / next steps
8. Conclusion / call to action

Adjust this structure to the user's domain.

## Design Guidelines

- Use one dominant color, one supporting neutral, and one accent color.
- Maintain strong contrast and at least ~0.5 inch margins.
- Use a unified font family and consistent font sizes throughout the deck unless intentional emphasis is needed.
- Use clear hierarchy: title 34–44 pt, section labels 18–24 pt, body 13–18 pt.
- Keep text concise: one message per slide; split overloaded slides.
- Prefer left-aligned body text; reserve centered text for covers, dividers, and big statements.
- Use consistent spacing, alignment, footer/citation placement, and chart styling.
- Balance each slide composition: avoid both overcrowding and large unexplained blank areas.
- For charts, label units and sources; avoid misleading axes or unlabeled percentages.

## QA Checklist

Always perform at least one QA pass before saying a deck is complete:

- Text extraction: no missing slides, wrong order, typos, stale placeholders, or hallucinated facts.
- LibreOffice render when available: convert the PPTX to PDF/images and verify that the rendered output succeeds.
- Slide-by-slide visual review: each slide has an intentional structure, readable hierarchy, balanced whitespace, and no element collisions.
- Typography consistency: fonts, sizes, weights, and line spacing are unified unless a difference is intentional and visually justified.
- Visual render: no overlaps, clipped text, unreadable contrast, cramped spacing, broken images, inconsistent alignment, or large unexplained blank areas.
- Template hygiene: no leftover lorem ipsum, template labels, empty placeholders, or duplicated slide numbers.
- File integrity: the PPTX opens, converted PDF/images render, and all linked media are embedded or intentionally linked.

When possible, use subagents or a fresh pass for visual review because deck layout issues are easy to miss after editing.
