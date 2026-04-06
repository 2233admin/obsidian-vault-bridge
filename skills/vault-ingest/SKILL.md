---
name: vault-ingest
description: >
  Ingest external content and REWRITE existing vault pages with new context.
  Not just "add a note" -- one source touches 5-15 existing pages.
  Resolves contradictions, updates claims, creates synthesis pages.
  The vault grows by integration, not accumulation.
---

# /vault-ingest [URL or file path or pasted content]

Ingest a source and rewrite the vault to integrate it.

## Steps

1. **Read `_CLAUDE.md`** at vault root for folder map and conventions.

2. **Acquire the source**:
   - URL -> fetch and convert to text
   - File path -> read the file
   - Pasted content -> use directly
   - Save raw source with frontmatter:
     ```yaml
     ---
     date: YYYY-MM-DD
     tags: [research, ingested]
     source: [URL or path]
     content_hash: [first 8 chars of sha256]
     status: ingested
     ---
     ```

3. **Extract entities** from the source:
   - Concepts, frameworks, mental models
   - Factual claims that could update or contradict existing notes
   - People, tools, libraries
   - Decisions, opinions, data points

4. **Map entities to vault** -- spawn parallel search agents:
   For each entity, search the vault:
   - Does a note about this already exist?
   - Does the source agree with, update, or contradict what the vault says?

5. **Classify each entity's action**:

   | Situation | Action |
   |-----------|--------|
   | New concept, no vault match | Create note |
   | Existing note, source adds info | **Append** new section |
   | Existing note, source contradicts | **Mark contradiction** with callout, cite both |
   | Existing note, source is newer | **Update** claim, move old to "Historical" section |
   | Concept in 3+ notes | Consider vault-graduate |

6. **Execute rewrites** -- spawn parallel write agents by folder, each must:
   - Read the target note FIRST
   - Find the right section (don't append at bottom blindly)
   - Preserve existing content, weave in new
   - Add source attribution

7. **Create synthesis page** if the source bridges 2+ existing domains.

8. **Update**: daily note, index.md, log.md

9. **Report**:
   ```
   ## Ingestion Report: [source title]

   **Raw saved:** [[raw/source-name]]
   **Notes created:** [list]
   **Notes updated:** [list + what changed]
   **Contradictions found:** [list with both sides]
   **Synthesis pages:** [list]

   Total vault impact: [N] files touched
   ```

## Rules

- **All output in the user's language** (from `_CLAUDE.md` Language section). Translate ALL report headings: "## 摄入报告：", "**已创建：**", "**已更新：**", "**发现矛盾：**" for Chinese users. When ingesting content in a different language than the vault, translate key concepts while preserving original terms in parentheses. When updating existing notes, match that note's language.
- **Rewrite, don't just add** -- integration, not accumulation
- **Never delete silently** -- contradictions show both versions with dates
- **Raw sources are immutable** -- edits happen in derived notes
- **content_hash for drift detection** -- re-ingest detects if source changed
- **Attribution mandatory** -- every claim cites its source
- **Search before create** -- no duplicate notes

## When to Suggest

- User shares a URL or paper
- User pastes a long block of content
- After research returns results worth persisting
