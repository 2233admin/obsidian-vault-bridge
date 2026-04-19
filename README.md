# obsidian-llm-wiki

> **A faithful reference implementation of [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).**
> Plain markdown, no embeddings at small scale, headless-first MCP, native to any Obsidian vault.

Not a RAG system. Not a vector database. A **compounding knowledge base** that your LLM maintains itself — the three operations Karpathy defined (Ingest / Query / Lint), wired to your Obsidian vault via MCP.

> If you love Karpathy's gist but don't want to run Postgres+pgvector (gbrain) or give up Obsidian's UI, this is for you.

---

## Quick Start (3 Steps)

1. **Clone the Repo**:
   ```bash
   git clone https://github.com/2233admin/obsidian-llm-wiki.git
   cd obsidian-llm-wiki
   ```
2. **Run Setup**:
   ```bash
   bash setup.sh
   ```
3. **Restart Claude Code**:
   Your new skills and MCP tools are now ready. Type `/vault-world` to begin.

> No database required. No embeddings required. Obsidian is **optional** — filesystem fallback always works.

---

## Faithful to Karpathy

| Karpathy's gist says | How obsidian-llm-wiki implements it |
| :--- | :--- |
| Three operations: **Ingest / Query / Lint** | `recipe.run` (Ingest), `vault.search` (Query), `vault.health` + `/vault-reconcile` (Lint) |
| `index.md` + `log.md` as the catalog + chronicle | `.omc/wiki/index.md` + `.omc/wiki/log.md`, auto-maintained |
| "No embedding-based RAG infrastructure at moderate scale" | Filesystem adapter uses ripgrep only. Embeddings/memU/pgvector are **optional** adapters you can ignore |
| Obsidian as the browsing IDE | Native `ObsidianAdapter` over WebSocket — two-way sync without the Local REST API plugin |
| `CLAUDE.md` / `AGENTS.md` as vault schema | Respected as-is, not overridden |
| `qmd` as a search backend (recommended in gist) | `adapters/qmd.ts` coming in v1.1 as an optional plug-in |

---

## Core Capabilities

- **Unified Query**: Search across filesystem, memU (optional), and GitNexus (optional) through a single MCP call.
- **Knowledge Compilation**: Chunk, tag, and cross-link raw notes into concept graphs — no vector DB required.
- **10 Source Collectors**: Gmail, Feishu, X/Twitter, NapCat/QQ, WeChat, AstrBot, WeFlow, Linear, Circleback, Voile — markdown dumps into your vault, incremental with cursor state.
- **Skill-Driven Workflows** (Claude Code):
  - `/vault-health`: audit orphans, broken links, staleness
  - `/vault-reconcile`: resolve knowledge conflicts and contradictions
  - `/vault-save`: intelligently save conversation context to the right folders
  - `/vault-challenge`: let the vault argue back using your own recorded history

---

## Architecture

```text
[ Agent Layer ] <--> [ Claude Code Skills ]
       |
[ MCP Server  ] <--> [ Unified Query Layer ]
       |                      |
[ Adapters    ] <--> [ Filesystem | Obsidian | memU | GitNexus ]
       |
[ Compiler    ] <--> [ Chunking | LLM Tagging | Link Discovery ]
       |
[ Collectors  ] <--> [ Gmail | Feishu | X | Linear | 6 more ]
```

- **Filesystem adapter** is a **global invariant** — always available, pure-file fallback for any operation.
- **Obsidian adapter** is an add-on for live vault sync when Obsidian is running.
- All higher adapters (memU / GitNexus / qmd) are **optional**.

---

## How it compares

The Karpathy LLM Wiki space got crowded fast in April 2026. Here's where obsidian-llm-wiki sits:

| | obsidian-llm-wiki | [gbrain](https://github.com/garrytan/gbrain) | [qmd](https://github.com/tobi/qmd) | Other Karpathy forks (kytmanov / NiharShrotri / julianoczkowski / yhay81) |
| :--- | :---: | :---: | :---: | :---: |
| Karpathy LLM Wiki three-ops pattern | ✅ full | partial | search-only | varies |
| No embeddings required at small scale | ✅ | ❌ (pgvector) | ✅ (BM25) | mixed |
| Storage | plain markdown | Postgres + files | files + index | files |
| Runs headless (no Obsidian) | ✅ (filesystem fallback) | ✅ | ✅ | usually needs Obsidian |
| Obsidian-native (live two-way sync) | ✅ | ❌ | ❌ | some |
| MCP server | ✅ | ✅ | ✅ | some |
| Multi-source collectors | **10** (Gmail/Feishu/X/QQ/WeChat/Linear/...) | Calendar + email | none | none |
| Chinese ecosystem sources | ✅ (NapCat/WeChat/Feishu/AstrBot) | ❌ | ❌ | ❌ |
| Setup | `bash setup.sh` | Docker + Postgres | `qmd init` | varies |

**Positioning**: gbrain is the "heavy" implementation of Karpathy's pattern (durable Postgres, "dream cycles," 37 operations). obsidian-llm-wiki is the "original orthodoxy" — small scale, no embeddings, plain markdown, runs on a laptop, Obsidian-native. They serve different users.

---

## Configuration

Edit `vault-mind.yaml` to enable/disable adapters and adjust weights:

```yaml
vault_path: E:/knowledge
adapters:
  filesystem: { enabled: true }
  obsidian:   { enabled: true, port_file: ~/.obsidian-ws-port }
  memu:       { enabled: false }       # optional
  gitnexus:   { enabled: false }       # optional
```

See `docs/config.md` for the full schema.

---

## Status

- **v1.0.0** shipped 2026-04-08 (headless-first MCP architecture, 64 tests green)
- **Current focus**: Track C — make the Compiler layer actually generate concept graphs and link suggestions (not just diagrams). See [roadmap](#roadmap).
- **Not production-ready for enterprises.** This is a personal-scale knowledge OS, designed for single-user vaults of ~100-10k markdown files.

## Roadmap

Public roadmap tracks live in `progress.txt`. Strategic direction documented at
`~/.claude/plans/breezy-stargazing-chipmunk.md` (local to maintainer).

- **Q2 2026**: link_discovery + concept_graph (Compiler made actual)
- **Q2-Q3 2026**: three collectors activated with cron (Gmail first)
- **Q3 2026**: qmd adapter (ally strategy — Shopify's `tobi/qmd` as optional search backend)

---

## License
GPL-3.0

Inspired by [Andrej Karpathy's LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (April 2026).
