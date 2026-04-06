---
name: vault-world
description: >
  Load vault context progressively -- identity, navigation, current state.
  Use at session start or when context about the vault is needed.
  Token-budgeted: start light, go deeper only as needed.
---

# /vault-world

Progressive context loader for your Obsidian vault.

## Steps

1. **Read `_CLAUDE.md`** at vault root -- operating rules and folder map.

2. **L0 -- Navigation (~1-2K tokens)**
   - Read `index.md` -- catalog of all pages (cheaper than searching)
   - Read `log.md` (last 10 entries only) -- what happened recently

3. **L1 -- Current State (~2-5K tokens)**
   - Read dashboard/home page (if listed in `_CLAUDE.md`)
   - Read today's daily note if it exists
   - Read last 3 daily notes for recent momentum
   - Scan task board for in-progress and overdue items

4. **L2 -- Deep Context (on demand, ~5-20K tokens)**
   - Only load if needed for a specific question or task
   - Read active project notes
   - Read relevant research articles
   - Read technical/engineering notes

5. **Present brief status after L0-L1** (do NOT load L2 unless needed):
   - **Current priorities**: top 3-5 active threads
   - **Open threads from last session**: anything unfinished
   - **Overdue / needs attention**: stale tasks or projects
   - **Today so far**: what's already logged

Keep output concise -- this is a boot-up sequence, not a report.
All output (status summary, priority list, labels) in the user's language from `_CLAUDE.md` Language section.

## When to Use

- Session start
- User asks about vault state or what's been happening
- Before making vault writes (to avoid duplicates)
