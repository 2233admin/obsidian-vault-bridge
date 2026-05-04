# llm-wiki

Obsidian plugin that turns a vault into compiled LLM knowledge infrastructure. MCP server exposes vault CRUD, search, graph, lint, and init. A separate Python compiler engine handles deterministic operations (diffing, hashing, link validation, topology analysis).

## MCP Server

Transport: stdio (via connector) or WebSocket (localhost:48765). Filesystem fallback when Obsidian is closed.

15 tools: `vault.read`, `vault.create`, `vault.modify`, `vault.append`, `vault.delete`, `vault.rename`, `vault.mkdir`, `vault.search`, `vault.searchByTag`, `vault.searchByFrontmatter`, `vault.graph`, `vault.backlinks`, `vault.batch`, `vault.lint`, `vault.init`

All write operations are dry-run gated by default. Pass `dryRun: false` to execute.

## Configuration

Add to your agent's MCP config:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/path/to/obsidian-llm-wiki/connector.js"]
    }
  }
}
```

Config file locations:
- Claude Code: `.mcp.json` (project) or `~/.claude.json`
- Codex CLI: `.codex/config.toml` — `[mcp_servers.llm-wiki]`
- Gemini CLI: `.gemini/settings.json`
- Cursor: `.cursor/mcp.json`

## Compiler Engine

`py ~/.claude/scripts/kb/kb_meta.py <command> <topic>`

Key commands: `diff` (change detection), `update-hash` (mark compiled), `update-index` (rebuild index), `check-links` (validate wikilinks), `vitality` (access scoring), `topology` (graph analysis), `concept-graph` (adjacency).

These are deterministic. Do not use LLMs for them.

## Workflow

1. `vault.init {topic}` -- scaffold raw/, wiki/, schema/, kb.yaml
2. Ingest sources to raw/ (URL, PDF, file)
3. `kb_meta.py diff` then compile changed sources to wiki/
4. Query against compiled wiki with [[wikilink]] citations
5. Lint for broken links, orphans, contradictions, gaps
6. Evolve by analyzing topology for missing connections

## Conventions

- `[[wikilinks]]` for all internal references
- YAML frontmatter with `coverage: high|medium|low` on compiled articles
- Wiki is LLM-maintained. Edit raw/, recompile. Do not hand-edit wiki/.

## Build

```bash
cd /path/to/obsidian-llm-wiki
npm run build    # esbuild -> main.js
npm run dev      # watch mode
```

## Tests

```bash
py ~/.claude/scripts/kb/test_kb.py    # compiler engine tests
```

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **obsidian-vault-bridge** (1888 symbols, 3632 relationships, 103 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/obsidian-vault-bridge/context` | Codebase overview, check index freshness |
| `gitnexus://repo/obsidian-vault-bridge/clusters` | All functional areas |
| `gitnexus://repo/obsidian-vault-bridge/processes` | All execution flows |
| `gitnexus://repo/obsidian-vault-bridge/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
