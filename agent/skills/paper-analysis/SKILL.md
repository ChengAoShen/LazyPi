---
name: paper-analysis
description: Deeply analyze academic papers. Use when the user provides a PDF, arXiv/DOI/link, abstract, or pasted paper text and asks to analyze, explain, summarize, review, critique, reproduce, compare, extract contributions, understand methods/experiments, or prepare literature notes/slides for a research paper.
---

# Paper Analysis Skill

Use this skill for rigorous academic paper understanding. Default to the user's language unless they request otherwise. Preserve original technical terms and translate only when helpful.

## 1. Input Check

Proceed if the user provides any of:

- paper PDF or local file path
- arXiv / DOI / publisher / repository URL
- title plus enough metadata to locate the paper
- abstract, introduction, or pasted full text

If the paper content is unavailable, ask the user to upload the PDF, paste the text, or provide a link. Do not fabricate details from a title alone.

## 2. Read the Paper

Use the best available route:

```bash
# PDF text extraction examples
uvx --with pymupdf python - <<'PY'
import fitz, sys
path = sys.argv[1]
doc = fitz.open(path)
for i, page in enumerate(doc, 1):
    print(f"\n\n--- Page {i} ---\n")
    print(page.get_text())
PY paper.pdf

# General document extraction if available
uvx --with 'markitdown[pdf]' python -m markitdown paper.pdf
```

For web links, fetch the page or paper. For arXiv, prefer the PDF when available. If figures/tables are important and text extraction is insufficient, render pages to images and inspect relevant figures.

## 3. Build an Internal Paper Core

Silently extract this structure before writing the answer:

```text
Paper Core
- title, year, venue, authors
- paper type: method / theory / empirical study / survey / dataset / benchmark / application
- problem and motivation
- prior work and limitations
- central hypothesis or intuition
- claimed contributions, preferably from the introduction
- method pipeline or theoretical argument
- key modules, formulas, algorithms, assumptions
- datasets, tasks, baselines, metrics
- main results with exact numbers and comparison targets
- ablations and sensitivity studies
- failure cases and limitations
- reproducibility: code, data, compute, hyperparameters
- significance and likely impact
- prerequisites and key concepts
- open questions and future work
```

Rules:

- Use exact numbers only when they appear in the paper.
- Distinguish author claims from your own assessment.
- If a field is missing, say “not specified” or “not addressed”, not a guess.
- For surveys, replace “method pipeline” with taxonomy and research trends.
- For dataset/benchmark papers, emphasize collection, annotation, quality control, splits, metrics, and leakage/bias risks.
- For theory papers, emphasize assumptions, theorem statements, proof intuition, and scope of applicability.

## 4. Default Output: Deep Analysis Report

Unless the user asks for a shorter format, produce a structured report:

### 0. Bibliographic Snapshot

Title, authors, year, venue, link/DOI/arXiv if available, paper type, code/data availability.

### 1. One-Sentence Summary

A plain-language core idea in one sentence.

### 2. Motivation and Problem

Explain the research context, why the problem matters, and what limitations in prior work the paper targets.

### 3. Main Contributions

List the paper's claimed contributions. Mark whether each contribution is methodological, empirical, theoretical, dataset-related, or application-related.

### 4. Method / Theory

Explain the approach step by step. Include:

- input and output
- pipeline or architecture
- key modules and their roles
- important formulas or algorithms in plain language
- assumptions and design choices

The user should be able to understand the method without reading the original paper.

### 5. Experiments and Results

Cover datasets, baselines, metrics, setup, main quantitative results, ablations, efficiency, and qualitative examples. Include exact numbers and table references when possible.

### 6. Strengths, Limitations, and Failure Modes

Separate:

- strengths supported by evidence
- author-acknowledged limitations
- your critical assessment
- potential threats to validity or reproducibility

### 7. Relationship to Prior Work

Explain how this paper differs from representative prior methods and what is genuinely new.

### 8. Practical Takeaways

Who should care, where the method is useful, implementation/reproduction notes, and how it might transfer to other settings.

### 9. Questions for Further Reading

List open questions, possible follow-up experiments, and adjacent papers or concepts to study.

## 5. Optional Formats

If requested, transform the analysis into:

- concise summary / TL;DR
- slide deck outline
- reviewer report with strengths, weaknesses, questions, and score rationale
- reproduction checklist
- concept map or mind map
- comparison table across multiple papers
- reading notes for a literature review
- beginner-friendly explanation with analogies

## 6. Quality Requirements

- Be precise, skeptical, and evidence-based.
- Cite section, table, figure, or page when available.
- Do not overstate results beyond the tested setting.
- Clearly label uncertainty and missing information.
- Preserve mathematical notation where useful, then explain it in plain language.
