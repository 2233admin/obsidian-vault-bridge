---
name: vault-challenge
description: >
  Vault argues back. Pulls your own history to challenge current thinking.
  Use when making decisions, proposing architecture, or before committing to a direction.
  The vault is not a yes-man -- it remembers what you've learned the hard way.
---

# /vault-challenge [topic or decision]

The vault challenges your current thinking using your own history.

## Steps

1. **Read `_CLAUDE.md`** at vault root for folder map.

2. **Identify the claim** -- what is the user proposing, deciding, or assuming?
   If no explicit topic, challenge the most recent significant decision in conversation.

3. **Deep vault search** -- spawn **3 parallel search agents**:

   - **History agent**: Search daily notes (last 30 days) + `log.md` for past instances where the user tried something similar. What happened? What was the lesson?
   - **Decision agent**: Search project + research folders for past decisions on the same topic. Read "Key Decisions" sections. Were there reversals?
   - **Pattern agent**: Search other domain folders for structural analogues. Has this pattern failed in a different domain?

4. **Build the challenge**:

   ```
   ## Challenge: [one-line summary of what's being questioned]

   ### Your Own Words
   > [Direct quotes from vault notes that contradict or complicate the current plan]

   ### What Happened Last Time
   [Concrete outcome from past attempt, with date and source note]

   ### The Steel-Man Counter
   [Strongest possible argument against the current direction, built from vault evidence]

   ### What This Doesn't Mean
   [Acknowledge where the current plan IS strong -- fair challenge, not nihilism]

   ### Questions You Should Answer Before Proceeding
   1. [Specific question derived from evidence]
   2. [Another]
   3. [Another]
   ```

5. **If no counter-evidence found** -- say so honestly. "Vault has nothing against this -- either it's genuinely new territory or your notes don't cover this domain yet."

6. **Append to log.md**: `## [YYYY-MM-DD] challenge | [topic] -- [outcome: challenged/clear]`

## Rules

- **All output in the user's language** (from `_CLAUDE.md` Language section). The templates below are structural examples in English -- translate ALL headings, labels, and descriptions. E.g., Chinese user sees "## 挑战：", "### 你自己说过的话", "### 上次发生了什么", not English headings. Only direct quotes from vault notes stay in their original language.
- **Quote the user's own words** -- this is what makes it hit different from generic critique
- **Never fabricate evidence** -- if the vault doesn't have it, say so
- **Be specific** -- "you tried X on 2026-03-15 and it failed because Y" not "you've had mixed results"
- **Include the source note path** so they can go read the full context
- **This is not a blocker** -- present evidence, let the user decide

## When to Suggest

- User says "I'm going to..." or "let's do..." on something non-trivial
- Architecture decisions that affect multiple projects
- Before committing significant time/resources
