# Vault Bridge

**Let your AI read, search, and build on your Obsidian notes.**

Inspired by [Karpathy's LLM Wiki](https://www.youtube.com/watch?v=zisonDtp3GQ) -- but you can install it right now.

```
You:    "What did I write about distributed consensus last month?"
Claude: *searches your vault, reads 3 notes, synthesizes an answer with [[backlinks]]*
```

Vault Bridge turns your Obsidian vault into an MCP server that any AI agent (Claude Code, Cursor, Windsurf) can connect to. Read, write, search, and compile knowledge -- with your notes as the source of truth.

## Quick Start

**3 steps. 2 minutes.**

### 1. Install the plugin

```bash
git clone https://github.com/2233admin/obsidian-vault-bridge.git
cd obsidian-vault-bridge && npm install && npm run build
```

Copy `main.js`, `manifest.json`, `styles.css` into your vault's `.obsidian/plugins/vault-bridge/`, then enable it in Obsidian Settings > Community Plugins.

### 2. Connect your agent

Add to `~/.claude/settings.json` (or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "vault-bridge": {
      "command": "node",
      "args": ["/path/to/obsidian-vault-bridge/connector.js", "/path/to/your/vault"]
    }
  }
}
```

### 3. Ask something

```
"Search my notes for anything about React Server Components"
"Summarize what I know about Kubernetes networking"
"Create a new note called 'Meeting Notes 2024-01-15' with these bullet points..."
```

That's it. Your agent can now read, search, and write your vault.

**Want to see it work?** Run the demo to verify your setup:

```bash
node demo.js
```

## What Can Your Agent Do?

| Capability | Example |
|-----------|---------|
| **Read any note** | "Read my notes/architecture-decisions.md" |
| **Full-text search** | "Find all notes mentioning 'auth middleware'" |
| **Search by tag** | "Show me all notes tagged #project-x" |
| **Query frontmatter** | "List notes where status is 'in-progress'" |
| **Follow the graph** | "What notes link to [[API Design]]?" |
| **Create notes** | "Create a summary of this PR in my vault" |
| **Edit notes** | "Add today's standup notes to my daily note" |
| **Compile knowledge** | "Ingest this paper and update my knowledge wiki" |
| **Health check** | "Find orphan notes and broken links in my vault" |

All writes are **dry-run by default** -- your agent must explicitly opt in to change anything. Your notes are safe.

## Why Vault Bridge?

|  | Vault Bridge | [obsidian-claude-code-mcp](https://github.com/iansinnott/obsidian-claude-code-mcp) | [obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api) |
|--|-------------|------------------------|------------------------|
| Protocol | MCP + WebSocket | MCP + WebSocket | REST (HTTPS) |
| Works without Obsidian | Yes (filesystem fallback) | No | No |
| Search | Full-text + tag + frontmatter + regex | Basic | Content search |
| Knowledge compilation | Built-in (ingest -> compile -> wiki) | No | No |
| Graph queries | Link graph + backlinks + orphan detection | No | No |
| Write safety | Dry-run by default | No guard | No guard |
| Vault health | Lint (broken links, orphans, missing frontmatter) | No | No |
| Batch operations | Yes | No | No |
| Real-time events | WebSocket push on file changes | No | No |
| Auth | Token + timing-safe comparison | Token | API key + HTTPS |

## The Knowledge Compilation Workflow

This is the [Karpathy LLM Wiki](https://www.youtube.com/watch?v=zisonDtp3GQ) idea, made real:

```
Raw sources (papers, articles, notes)
    |
    v  [vault.init] scaffold a topic
    |
    v  Drop sources into raw/
    |
    v  [kb_meta.py diff] detect new sources
    |
    v  LLM extracts concepts, summaries, relationships
    |
    v  [kb_meta.py update-hash] mark compiled
    |
    v  [kb_meta.py update-index] rebuild wiki index
    |
    v  [kb_meta.py check-links] verify integrity
    |
Compiled wiki with [[wikilinks]], frontmatter, coverage tags
```

Your agent does the extraction. `kb_meta.py` handles the bookkeeping (diffing, hashing, indexing) -- zero dependencies, pure Python.

## How It Works

```
AI Agent  <--MCP stdio-->  connector.js  <--WebSocket-->  Obsidian Plugin
                               |
                          (filesystem fallback when Obsidian is closed)
```

- **Plugin** runs a WebSocket server inside Obsidian (JSON-RPC 2.0, localhost only)
- **connector.js** is an MCP server that proxies to WebSocket, or reads the vault directly when Obsidian is closed
- Auto-discovery via `~/.obsidian-ws-port` -- no manual port configuration needed

## API Reference

20 tools available via MCP. All use JSON-RPC 2.0.

<details>
<summary>Read operations</summary>

| Method | Params | Description |
|--------|--------|-------------|
| `vault.read` | `path` | Read a note's content |
| `vault.list` | `path?` | List files and folders |
| `vault.stat` | `path` | File/folder metadata (size, dates) |
| `vault.exists` | `path` | Check if path exists |
| `vault.getMetadata` | `path` | Parsed frontmatter, links, tags, headings |

</details>

<details>
<summary>Write operations (dry-run by default)</summary>

| Method | Params | Description |
|--------|--------|-------------|
| `vault.create` | `path, content?, dryRun?` | Create a new note |
| `vault.modify` | `path, content, dryRun?` | Overwrite an existing note |
| `vault.append` | `path, content, dryRun?` | Append to a note |
| `vault.delete` | `path, force?, dryRun?` | Delete a note or folder |
| `vault.rename` | `from, to, dryRun?` | Move/rename a file |
| `vault.mkdir` | `path, dryRun?` | Create a directory |

</details>

<details>
<summary>Search & graph</summary>

| Method | Params | Description |
|--------|--------|-------------|
| `vault.search` | `query, regex?, caseSensitive?, maxResults?, glob?` | Full-text search |
| `vault.searchByTag` | `tag` | Find notes with a tag |
| `vault.searchByFrontmatter` | `key, value?, op?` | Query by frontmatter fields |
| `vault.graph` | `type?` | Link graph (nodes, edges, orphans) |
| `vault.backlinks` | `path` | Find notes linking to a note |

</details>

<details>
<summary>Batch & health</summary>

| Method | Params | Description |
|--------|--------|-------------|
| `vault.batch` | `operations, dryRun?` | Multiple operations in one call |
| `vault.lint` | `requiredFrontmatter?` | Vault health check |
| `vault.init` | `topic` | Scaffold a knowledge base structure |

</details>

## Security

- **localhost only** -- WebSocket binds to 127.0.0.1, no network exposure
- **Token auth** -- timing-safe comparison, 5s auth timeout, auto-generated 256-bit token
- **Dry-run by default** -- writes are no-ops unless you pass `dryRun: false`
- **Path traversal blocked** -- `..` segments rejected, `.obsidian/` protected from writes
- **Connection limits** -- max 20 clients, 10MB payload cap, ReDoS-safe regex
- **Filesystem fallback** -- same security model when Obsidian is closed

## Python Companions (optional)

| File | Purpose | Dependencies |
|------|---------|-------------|
| `kb_meta.py` | Deterministic KB ops: diff, hash, index, lint, vitality | stdlib only |
| `vault_bridge.py` | Async Python WebSocket client | `websockets` |
| `mcp_server.py` | Python MCP server (alternative to connector.js) | `mcp`, `websockets` |

## License

MIT
