---
name: vault-graduate
description: >
  Promote scattered vault mentions into dedicated notes.
  When an idea, pattern, or concept reaches critical mass (3+ mentions across contexts),
  it deserves its own page. Graduate it from scattered references to first-class citizen.
---

# /vault-graduate [concept]

Promote a recurring concept from scattered mentions to a dedicated vault page.

## Modes

- **Concept given**: Graduate that specific concept.
- **No concept given**: Scan vault for concepts that SHOULD be graduated but aren't. Present candidates.

## Steps -- Scan Mode (no concept given)

1. **Read `_CLAUDE.md`** and `index.md`.

2. **Scan for candidates** -- spawn **3 parallel agents**:
   - **Frequency agent**: Grep vault for terms appearing in 3+ different notes across 2+ folders.
   - **Orphan agent**: Find concepts in `[[wiki links]]` that don't have their own page yet.
   - **Emerge agent**: Check last vault-emerge results for patterns not yet formalized.

3. **Present candidates** ranked by readiness:

   ```
   | Concept | Mentions | Folders | Has Page? | Readiness |
   |---------|----------|---------|-----------|-----------|
   | [name]  | 5        | 3       | No        | Ready     |
   ```

4. **Ask user** which to graduate.

## Steps -- Graduate Mode (concept given)

1. **Read `_CLAUDE.md`** and `index.md`.

2. **Collect all mentions** -- search entire vault for the concept.

3. **Synthesize** into a dedicated note:
   - **Choose location** based on `_CLAUDE.md` folder map
   - **Frontmatter**: date, tags, `status: active`, `graduated_from: [source notes]`
   - **Structure**:
     ```markdown
     # [Concept Name]

     > [One-line definition]

     ## Origin
     First appeared: [[source note]] on YYYY-MM-DD

     ## What It Means
     [Synthesized understanding from all mentions]

     ## Where It Shows Up
     - [[note 1]] -- [how it manifests]
     - [[note 2]] -- [how it manifests]

     ## Connections
     - Related to [[X]] because [reason]

     ## Open Questions
     - [Things not yet resolved]
     ```

4. **Update all source notes** -- ensure `[[Concept Name]]` wiki link exists in each.

5. **Update index.md** and daily note.

6. **Append to log.md**: `## [YYYY-MM-DD] graduate | [concept] -- promoted from [N] mentions`

## Rules

- **All output in the user's language** (from `_CLAUDE.md` Language section). Concept page title, headings ("## 起源", "## 含义", "## 出现位置", "## 开放问题"), and body all in user's language. When a concept has terms in multiple languages, use primary language for title and note alternates. Search covers all languages in the vault.
- **3+ mentions minimum** to graduate
- **Cross-folder mentions are stronger signal**
- **Preserve origin story** -- where the concept first appeared
- **Link bidirectionally** -- new page links to sources, sources link back
