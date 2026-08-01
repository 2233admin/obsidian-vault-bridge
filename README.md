# Obsidian LLM Wiki

[![CI](https://github.com/2233admin/obsidian-llm-wiki/actions/workflows/ci.yml/badge.svg)](https://github.com/2233admin/obsidian-llm-wiki/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json) [![Python](https://img.shields.io/badge/python-%3E%3D3.11-brightgreen.svg)](kb_meta.py)

**English** | [中文](README.zh-CN.md) | [日本語](README.ja.md)

**让你的 AI 读取、搜索并在你的 Obsidian 笔记上构建。**

受 [Karpathy 的 LLM Wiki](https://www.youtube.com/watch?v=zisonDtp3GQ) 启发——但你可以现在就装上。

![License](https://img.shields.io/badge/license-MIT-blue)
![Stars](https://img.shields.io/github/stars/2233admin/obsidian-vault-bridge)
![Last Commit](https://img.shields.io/github/last-commit/2233admin/obsidian-vault-bridge)
![Node](https://img.shields.io/badge/Node-18+-339933)

- **One-liner**: Turns your Obsidian vault into an MCP server any AI agent can read, search, and write.
- **For**: You want Claude Code / Cursor / Windsurf to work directly on your notes, with dry-run-safe writes.
- **Not for**: You don't use Obsidian, or your tools don't speak MCP.

```
  .obsidian/vault/          MCP stdio           Claude Code
  +-----------------+      +----------+        +-----------+
  | notes/          | <--> | connector| <----> |  agent    |
  | daily/          |      |    .js   |        |           |
  | projects/       |  WS  +----------+        +-----------+
  | [[wikilinks]]   | <-->  Obsidian             Cursor
  +-----------------+       Plugin               Windsurf
```

```
你：    "我上个月写的关于分布式共识的笔记在哪？"
Claude: *搜索你的 vault，读 3 篇笔记，用 [[backlinks]] 合成一个答案*
```

Vault Bridge 把你的 Obsidian vault 变成一个 MCP 服务器，任何 AI agent（Claude Code、Cursor、Windsurf）都能连上。读、写、搜索、编译知识——以你的笔记为事实来源。

---

## Quick Start

```bash
git clone https://github.com/2233admin/obsidian-llm-wiki.git
cd obsidian-llm-wiki && npm install && npm run build
node setup.js
```

`setup.js` auto-detects your Obsidian vault, installs the plugin, and configures Claude Code's MCP -- all in one go. Then ask Claude:

```
"Search my notes for anything about React Server Components"
```

That's it.

<details>
<summary>Manual install (if setup.js doesn't work for you)</summary>

### 1. Install the plugin

Copy `main.js`, `manifest.json`, `styles.css` into your vault's `.obsidian/plugins/llm-wiki/`, then enable it in Obsidian Settings > Community Plugins.

### 2. Connect your agent

Add to `~/.claude/settings.json` (or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/path/to/obsidian-llm-wiki/connector.js", "/path/to/your/vault"]
    }
  }
}
```

### 3. Verify

```bash
node demo.js
```

</details>

---

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

---

## Thinking Tools -- Your Vault Thinks Back

Most tools treat your notes as a database. Vault Bridge treats them as a **second brain** -- one that can argue, notice patterns, and build connections you missed.

| Command | What it does |
|---------|-------------|
| `/vault-challenge` | Your vault **argues back** at your decisions, using quotes from your own notes. "You tried this in March and it failed because..." |
| `/vault-emerge` | Surfaces **unnamed patterns** from the last 30 days. Finds the recurring theme you haven't noticed yet. |
| `/vault-connect` | Finds **structural bridges** between unrelated domains. "Your trading drawdown recovery looks like your tech debt payoff strategy." |
| `/vault-graduate` | Promotes scattered mentions into **first-class concept pages**. When an idea appears 3+ times, it deserves its own note. |
| `/vault-ingest` | Ingests a URL or paper and **rewrites 5-15 existing pages** to integrate it. Not "add a note" -- knowledge by integration, not accumulation. |
| `/vault-save` | Saves conversation knowledge to the right place in your vault. Parallel agents, one per folder. |
| `/vault-world` | Progressive context loading -- boots up your vault state in 1-2K tokens. |

These are Claude Code skills installed by `setup.js`. They work with any vault structure -- your `_CLAUDE.md` file tells them where things live.

---

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
| **Thinking tools** | **7 skills (challenge, emerge, connect, graduate, ingest, save, world)** | **No** | **No** |
| Auth | Token + timing-safe comparison | Token | API key + HTTPS |

---

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

---

## How It Works

```
AI Agent  <--MCP stdio-->  connector.js  <--WebSocket-->  Obsidian Plugin
                               |
                          (filesystem fallback when Obsidian is closed)
```

- **Plugin** runs a WebSocket server inside Obsidian (JSON-RPC 2.0, localhost only)
- **connector.js** is an MCP server that proxies to WebSocket, or reads the vault directly when Obsidian is closed
- Auto-discovery via `~/.obsidian-ws-port` -- no manual port configuration needed

---

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

---

## Security

- **localhost only** -- WebSocket binds to 127.0.0.1, no network exposure
- **Token auth** -- timing-safe comparison, 5s auth timeout, auto-generated 256-bit token
- **Dry-run by default** -- writes are no-ops unless you pass `dryRun: false`
- **Path traversal blocked** -- `..` segments rejected, `.obsidian/` protected from writes
- **Connection limits** -- max 20 clients, 10MB payload cap, ReDoS-safe regex
- **Filesystem fallback** -- same security model when Obsidian is closed

---

## Python Companions (optional)

| File | Purpose | Dependencies |
|------|---------|-------------|
| `kb_meta.py` | Deterministic KB ops: diff, hash, index, lint, vitality | stdlib only |
| `vault_bridge.py` | Async Python WebSocket client | `websockets` |
| `mcp_server.py` | Python MCP server (alternative to connector.js) | `mcp`, `websockets` |

---

## FAQ

**How do I connect Claude Code to my Obsidian vault?**
Install the LLM Wiki plugin, run `node setup.js`, and it auto-configures MCP. Claude Code can then read, search, and write your notes directly.

**How is this different from obsidian-claude-code-mcp?**
LLM Wiki adds filesystem fallback (works without Obsidian running), knowledge compilation (Karpathy-style raw-to-wiki pipeline), graph queries, vault health checks, batch operations, and real-time events. See the comparison table above.

**How is this different from obsidian-local-rest-api?**
local-rest-api uses REST/HTTPS; LLM Wiki uses MCP (the protocol Claude Code and Cursor speak natively). No adapter needed, plus you get search, graph, and knowledge compilation built in.

**Will this break my vault?**
All write operations default to dry-run mode. Your agent must explicitly pass `dryRun: false` to change anything. The `.obsidian/` directory is protected from writes. Path traversal is blocked.

**Does it work when Obsidian is closed?**
Yes. The MCP connector falls back to direct filesystem access automatically. Search, read, and write all work without Obsidian running.

**What is an LLM Wiki?**
A term coined by Andrej Karpathy: use an LLM to "compile" raw sources (articles, papers, notes) into a structured, interlinked wiki with concepts, summaries, and cross-references. This plugin is the installable implementation of that idea.

**What AI agents are supported?**
Any MCP-compatible agent: Claude Code, Claude Desktop, Cursor, Windsurf, and any tool that supports the Model Context Protocol.

---

## Related Projects

- [obsidian-second-brain](https://github.com/2233admin/obsidian-second-brain) — A vault that rewrites itself
- [markdown-memory](https://github.com/2233admin/markdown-memory) — File-driven AI memory bridge
- [voile](https://github.com/2233admin/voile) — Chat logs compiled into Obsidian knowledge

---

## License

MIT
