---
name: vault-emerge
description: >
  Surface unnamed patterns from recent vault activity.
  Reads N days of notes and finds recurring themes you haven't explicitly named.
  The vault notices what you don't.
---

# /vault-emerge [days=30]

Find patterns hiding in your vault that you haven't named yet.

## Steps

1. **Read `_CLAUDE.md`** at vault root for folder map.

2. **Collect raw material** -- spawn **parallel reader agents** (one per major folder):
   - Read daily notes from last N days. Extract: topics, decisions, blockers, mood signals.
   - Read project notes modified in last N days. Extract: status changes, recurring blockers, tools mentioned.
   - Read research notes modified in last N days. Extract: themes, frameworks, open questions.
   - Read other domain folders modified in last N days. Extract: patterns, failures, workarounds.

3. **Pattern detection** -- look for:
   - **Recurring topics** appearing 3+ times across unrelated contexts
   - **Unnamed workflows** -- action sequences that keep happening but have no name
   - **Shifting priorities** -- what's getting more attention over time? Less?
   - **Unresolved tensions** -- contradictions between different notes
   - **Emerging expertise** -- domains where depth is growing but not acknowledged
   - **Abandoned threads** -- topics that appeared briefly then vanished

4. **Present findings** as named patterns:

   ```
   ## Emerged Patterns (last N days)

   ### 1. [Pattern Name] -- [one-line description]
   **Evidence:** [3+ specific notes with dates]
   **Frequency:** [how often, across what contexts]
   **So what:** [why this matters -- actionable implication]
   **Suggestion:** [formalize as protocol? create concept note? investigate deeper?]
   ```

5. **Rank by signal strength** -- more evidence + more diverse sources = higher rank.

6. **Ask**: "Any of these worth naming? I can create concept notes for them."

7. **Append to log.md**: `## [YYYY-MM-DD] emerge | [N] patterns surfaced from [days] days`

## Rules

- **All output in the user's language** (from `_CLAUDE.md` Language section). Translate ALL template headings and labels. E.g., Chinese user sees "## 浮现的模式", "### 1. [模式名]", "**证据：**", not English. Pattern names should be in the user's language. Evidence quotes stay in original language. Search in all languages present in the vault.
- **Minimum 3 independent data points** to call something a pattern
- **Cross-domain signals are gold** -- same pattern in two unrelated areas is more interesting
- **Name patterns concisely** -- if you can't name it in 5 words, you haven't understood it
- **Don't state the obvious** -- "user works on multiple projects" is not a pattern
- **Include counter-evidence** -- if a pattern has exceptions, mention them

## When to Suggest

- Weekly review time
- User feels scattered or directionless
- Before planning sessions
- After vault-health finds many orphan notes
