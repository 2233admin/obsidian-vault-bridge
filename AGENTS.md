# vault-bridge

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
    "vault-bridge": {
      "command": "node",
      "args": ["/path/to/obsidian-llm-wiki/connector.js"]
    }
  }
}
```

Config file locations:
- Claude Code: `.mcp.json` (project) or `~/.claude.json`
- Codex CLI: `.codex/config.toml` — `[mcp_servers.vault-bridge]`
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
