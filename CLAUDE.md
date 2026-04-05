# Vault Bridge -- LLM Knowledge Base Schema

Opinionated workflow for maintaining a compiled knowledge wiki via vault-bridge.
Transport: **MCP** (primary) or WebSocket. Filesystem fallback is a **global invariant** -- everything works when Obsidian is closed.

## First Action

Read `kb.yaml` from the vault root. If missing, call `vault.init` and stop.

## Model Routing

| Task | Model | Why |
|------|-------|-----|
| File scanning, link checking, diffing | haiku | Mechanical, no judgment |
| Source summarization, article writing | sonnet | Quality writing at speed |
| Orchestration, synthesis, contradiction detection | opus | Cross-document reasoning |
| Deterministic ops (diff, hash, vitality, topology) | `kb_meta.py` | Zero LLM cost, exact results |

Always set `model` explicitly when dispatching subagents.

## Obsidian Formatting

- `[[wikilinks]]` for ALL internal links -- never `[text](url)` for vault refs
- `[[wikilinks|display text]]` when display differs from target
- YAML frontmatter on every file: `title`, `tags`, `sources`, `coverage`
- `![[image.png]]` for embeds

## Coverage Tags

Every compiled wiki article gets a `coverage` frontmatter field:

| Tag | Meaning | When to use |
|-----|---------|-------------|
| `high` | 3+ independent sources corroborate | Trust the wiki article |
| `medium` | 1-2 sources, no contradictions | Skim raw if precision matters |
| `low` | Single source or LLM-inferred | Always verify against raw/ |

## Workflow 1: Ingest

**Trigger:** "ingest", "add source", user provides URL/file/path.

1. `kb_meta.py init <topic>` (idempotent)
2. Determine source type (URL -> WebFetch, PDF -> extract, file -> copy)
3. Save to `raw/{type}/` with frontmatter: `source`, `ingested`, `source_type`, `authority`
4. `kb_meta.py diff <topic>` -- report new file count
5. Prompt: "Ingested N files. Compile now?"

## Workflow 2: Compile

**Trigger:** "compile", "update the wiki", after ingest.

1. `kb_meta.py diff <topic>` -- parse JSON, identify new/changed/deleted
2. If nothing changed: "Nothing to compile." Stop.
3. Read `wiki/_index.md` for existing concepts
4. Per changed source (sonnet subagents, up to 3 parallel):
   - Read raw file, extract concepts/claims/relationships
   - Return structured JSON: summary + new concepts + concept updates
5. Opus orchestrates: write summaries, create/update concept articles, add backlinks
6. Set `coverage` tag per article based on source count
7. `kb_meta.py update-hash <topic> <file>` for each compiled source
8. `kb_meta.py update-index <topic>` -- rebuild master index
9. `kb_meta.py check-links <topic>` -- report broken links
10. Report: N sources compiled, M new concepts, K updates, L broken links

### Article Template

```markdown
---
title: "Concept Name"
aliases: [abbreviation]
tags: [domain, topic]
sources: ["[[raw/articles/source.md]]"]
coverage: medium
compiled: 2026-04-06
---

# Concept Name

Core explanation.

## Details

Extracted information with source attribution.

## Relationships

- Builds on [[Foundation Concept]]
- Contradicts [[Other Claim]] on X (see [[raw/articles/source.md]])

## Sources

- [[raw/articles/source.md]] -- key claims from this source
```

## Workflow 3: Query

**Trigger:** Question about the knowledge base.

1. Read `wiki/_index.md`, identify 3-8 relevant articles
2. Read those articles. Log access: `kb_meta.py log-access <topic> <article>`
3. Synthesize answer citing `[[wikilinks]]`. Mark coverage confidence.
4. If answer required external data: suggest filing back into raw/ for compilation

**Ask before assuming:** If the question spans multiple topics, ask which topic to query. If wiki coverage is `low`, warn before answering.

## Workflow 4: Lint

**Trigger:** "lint", "health check", or scheduled via cron.

Deterministic checks (parallel, zero LLM cost):
1. `kb_meta.py check-links <topic>` -- broken wikilinks
2. `kb_meta.py diff <topic>` -- uncompiled sources
3. `kb_meta.py vitality <topic>` -- stale/never-accessed articles
4. `kb_meta.py topology <topic>` -- communities, bridges, PageRank, density
5. `kb_meta.py concept-graph <topic>` -- isolated nodes, weak clusters

LLM analysis (sonnet subagents, opus judgment):
6. Redundancy: overlapping concepts that should merge
7. Contradictions: conflicting claims across articles
8. Gaps: referenced concepts without their own article

Output: `wiki/_lint-{date}.md` grouped by severity (critical > warning > info).

## Workflow 5: Evolve

**Trigger:** "evolve", "what's missing", "suggest improvements".

1. Read `_index.md` + `_categories.md` + sample high-vitality articles
2. `kb_meta.py topology <topic>` -- find structural gaps
3. Analyze for:
   - **Gaps**: concepts referenced but lacking articles
   - **Bridges**: cross-category connections not yet explored
   - **Depth**: hub concepts (high PageRank) needing richer treatment
   - **Questions**: research questions that would fill graph holes
4. Present numbered suggestions with rationale
5. User picks items -> execute via ingest, compile, or web search

## Dreamtime Integration

Bidirectional loop (runs headless at 03:00 via filesystem fallback):

- **KB -> Dreamtime**: Compiled concepts + `_index.md` feed proposition judge context
- **Dreamtime -> KB**: Distill outputs auto-written to `raw/dreamtime/` as source files
- After dreamtime writes to raw/, next compile picks them up automatically

## Ask vs Assume

| Situation | Action |
|-----------|--------|
| Single topic, clear intent | Assume, proceed |
| Question spans multiple topics | Ask which topic |
| Destructive operation (delete, overwrite) | Always ask |
| Coverage is `low` on query target | Warn, then answer |
| lint finds critical issues | Report, ask before auto-fix |
| Source type ambiguous | Ask (URL? PDF? local file?) |

## Common Mistakes

1. **Recompiling everything** -- always use `kb_meta.py diff`, never recompile unchanged sources
2. **Skipping index update** -- every compile MUST end with `update-index` + `check-links`
3. **Using markdown links for vault refs** -- `[[wikilinks]]` only, never `[text](path.md)`
4. **Filing every query answer back** -- only file genuinely NEW knowledge (external data, new connections)
5. **Running LLM for deterministic tasks** -- link checking, diffing, hashing, vitality are `kb_meta.py` jobs
6. **Ignoring coverage tags** -- `low` coverage means the wiki might be wrong, always verify
7. **Forgetting `log-access`** -- every query read must log access for vitality scoring
8. **Editing wiki articles manually** -- the wiki is LLM-maintained; edit raw/ and recompile instead
