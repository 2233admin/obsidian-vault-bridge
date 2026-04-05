---
name: vault-bridge
description: "Obsidian vault as compiled knowledge base. Use when user says ingest, compile, query, lint, evolve, or asks questions that should come from a knowledge base. Also triggers on 'init kb', 'new topic', 'health check', 'what's missing'."
context: fork
model: sonnet
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, WebFetch
---

Read `kb.yaml` from the vault root before doing anything. Missing? Call MCP `vault.init` with the topic name, then proceed.

## MCP Tools

All vault operations go through MCP. Filesystem fallback when Obsidian is closed -- same interface, direct file I/O.

| Method | Does what |
|--------|-----------|
| `vault.init` | Scaffold topic: raw/, wiki/, schema/, Log.md, kb.yaml |
| `vault.read` / `vault.create` / `vault.modify` / `vault.append` / `vault.delete` | CRUD (writes are dry-run gated) |
| `vault.search` / `vault.searchByTag` / `vault.searchByFrontmatter` | Find notes |
| `vault.graph` / `vault.backlinks` | Link graph |
| `vault.batch` | Multiple ops in one round-trip |
| `vault.lint` | Structural health check |
| `vault.list` / `vault.stat` / `vault.exists` | Navigation |

## kb_meta.py (deterministic, zero LLM cost)

```
KB_META = python /path/to/obsidian-vault-bridge/kb_meta.py
$KB_META <command> <vault_root> <topic> [args...]
```

| Command | What |
|---------|------|
| `init` | Create _meta.json |
| `diff` | Hash-diff raw/ against compiled state |
| `update-hash <file>` | Mark a raw file as compiled |
| `update-index` | Rebuild _index.md from wiki/ |
| `check-links` | Validate [[wikilinks]] resolve |
| `vitality` | Access-weighted article scores |
| `log-access <article>` | Record a read event |

Never use an LLM for these. They are exact.

## Workflows

### Ingest

Trigger: "ingest", "add source", user provides URL/file/path.

1. `kb_meta.py init` (no-op if exists)
2. Source type: URL -> WebFetch. PDF -> extract text. File -> copy.
3. Save to `raw/{type}/` with frontmatter: `source`, `ingested`, `source_type`, `authority`
4. `kb_meta.py diff` -- report count
5. Ask: "Compile now?"

### Compile

Trigger: "compile", "update wiki".

**Gate**: `kb_meta.py diff` -- if `new` and `changed` are both empty, stop.

**Config**: Read `{topic}/schema/compile-config.yaml`. Missing? Use `templates/base/compile-config.yaml`. Config has the extraction prompt, coverage thresholds, and parallelism settings.

**Existing state**: Read `wiki/_index.md` to get existing concept names (prevents duplicate creation).

**Extract**: Per changed source, dispatch a subagent (model per config `model_tier`):
- Send config's `extraction.prompt` + raw file content + existing concept names
- Subagent returns JSON: `{ summary, concepts[], relationships[] }`
- Invalid JSON? Skip source, warn, continue.

**Write summaries**: One per source at `wiki/summaries/{source-slug}.md`. Overwrite if exists.

```markdown
---
source: "[[raw/{source_file}]]"
compiled: {date}
---
# {title}
{one_liner}
## Key Points
- {point1}
- {point2}
## Related Concepts
- [[concepts/{concept-slug}]] -- {one_liner}
```

**Write concepts**: At `wiki/concepts/{name-slug}.md`.
- New concept: write full article (overview + properties + sources).
- Existing concept: append new properties and source. Do NOT rewrite overview.

**Coverage tags**: Count sources referencing each concept. Per config thresholds (default: 1=low, 2=medium, 4+=high).

**Metadata**: For each compiled source:
```bash
$KB_META update-hash "$VAULT" "$TOPIC" "raw/{file}"
$KB_META update-index "$VAULT" "$TOPIC"
$KB_META check-links "$VAULT" "$TOPIC"
```

**Report**: sources compiled, summaries written, new/updated concepts, broken links, coverage distribution.

See `templates/examples/` for real output from the brillm topic.

### Query

Trigger: question about knowledge base content.

1. Read `wiki/_index.md`, pick 3-8 relevant articles
2. Read articles. `kb_meta.py log-access` for each
3. Synthesize with [[wikilink]] citations. State coverage confidence.
4. If external data was needed: suggest filing to raw/ for compilation

### Lint

Trigger: "lint", "health check".

Deterministic (free):
- `check-links` -- broken wikilinks
- `diff` -- uncompiled sources
- `vitality` -- stale/dead articles

LLM (sonnet scan, opus judgment):
- Redundant concepts to merge
- Contradicting claims across articles
- Referenced concepts with no article

Output: `wiki/_lint-{date}.md`

### Evolve

Trigger: "evolve", "what's missing".

1. Read _index.md + high-vitality articles
2. `vault.graph` -- find orphans, weak clusters
3. Identify: missing articles, shallow hubs, research questions
4. Present ranked suggestions. User picks, agent executes.

## Formatting

- `[[wikilinks]]` for all vault refs. Never markdown links for internal.
- YAML frontmatter: sources, coverage, compiled date.
- `[[link|display text]]` when display differs from target.

## Mistakes That Will Waste Your Time

1. Recompiling unchanged sources -- `kb_meta.py diff` first, always
2. Skipping `update-index` + `check-links` after compile -- index goes stale
3. Using `[text](path)` instead of `[[wikilinks]]` -- Obsidian won't resolve
4. Running LLM for diffing or link checking -- kb_meta.py does it in milliseconds
5. Editing wiki articles by hand -- edit raw/, recompile. Wiki is LLM-maintained.
6. Forgetting `log-access` on query reads -- vitality scoring goes blind
