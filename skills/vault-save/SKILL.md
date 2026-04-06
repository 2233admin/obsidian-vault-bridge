---
name: vault-save
description: >
  Save everything worth keeping from the current conversation to the Obsidian vault.
  Use when conversation produces decisions, research, tasks, project updates, or insights.
  Also triggers on session wrap-up ("done", "that's it", "thanks").
---

# /vault-save

Save conversation knowledge to your Obsidian vault.

## Steps

1. **Read `_CLAUDE.md`** at the vault root for operating rules and folder map.

2. **Read `index.md`** to understand what already exists.

3. **Scan the conversation** and identify all vault-worthy items:
   - Decisions made or confirmed
   - Project status changes or milestones
   - Research findings or analysis results
   - Engineering insights or patterns discovered
   - Tasks created, assigned, or completed
   - Ideas, learnings, or connections

4. **Group items by type** and spawn parallel subagents:
   - One agent per target folder (as defined in `_CLAUDE.md` folder map)
   - Each agent: search target folder for existing notes, create or update

5. **After all agents complete**: update today's daily note
   - Create from template if it doesn't exist
   - Link everything that was saved

6. **Append to log.md**: `## [YYYY-MM-DD] save | Brief description`

7. **Update index.md** if any new notes were created

8. **Report back**: clean list of what was saved and where

## Rules

- **All output in the user's language** (from `_CLAUDE.md` Language section). Note content, status reports, and log entries all in user's language. When updating an existing note, match that note's language.
- **Search before creating** -- duplicate notes are vault rot
- **Propagate every write** -- daily note + linked notes + index
- **Never create orphans** -- every note linked from somewhere
- **Match existing style** -- read 1-2 notes in target folder first
- **Frontmatter mandatory** -- at minimum: date + tags
- Do not ask where to save -- infer from `_CLAUDE.md` folder map. Only ask if genuinely ambiguous.

## Proactive Reminders

Suggest saving when:
- 10+ exchanges without a save
- User signals wrap-up
- A logical work block completes (feature shipped, decision made, problem solved)
