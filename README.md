# Vault Bridge

Obsidian plugin that exposes your entire vault to AI agents via WebSocket and MCP (Model Context Protocol).

**Why?** AI agents need to read, write, search, and analyze your notes. Vault Bridge gives them a structured API to do it -- with authentication, dry-run safety, and filesystem fallback when Obsidian is closed.

## How It Works

```
AI Agent  <--MCP stdio-->  connector.js  <--WebSocket-->  Obsidian Plugin
                               |
                          (filesystem fallback when Obsidian is closed)
```

- **Plugin** runs a WebSocket server inside Obsidian with JSON-RPC 2.0
- **connector.js** is an MCP server that proxies to WebSocket, or falls back to direct filesystem access
- **Agents** (Claude Code, Cursor, Windsurf, etc.) connect via MCP config

## Install

### Manual (recommended)

1. Download `main.js`, `manifest.json`, `styles.css` from [Releases](https://github.com/2233admin/obsidian-vault-bridge/releases)
2. Create `<vault>/.obsidian/plugins/vault-bridge/`
3. Copy the three files into that folder
4. Enable "Vault Bridge" in Obsidian Settings > Community Plugins

### From Source

```bash
git clone https://github.com/2233admin/obsidian-vault-bridge.git
cd obsidian-vault-bridge
npm install
npm run build
# Copy main.js, manifest.json, styles.css to your vault's plugins/vault-bridge/
```

## Connect Your Agent

### Claude Code / Cursor / Windsurf (MCP)

Add to your MCP config (`~/.claude/settings.json`, `.cursor/mcp.json`, etc.):

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

The vault path argument is only needed when Obsidian is closed (filesystem fallback). When Obsidian is running, connector.js auto-detects the WebSocket port.

### Direct WebSocket

```javascript
const ws = new WebSocket('ws://127.0.0.1:<port>');
// Port and token are in ~/.obsidian-ws-port
ws.send(JSON.stringify({
  jsonrpc: '2.0',
  method: 'authenticate',
  params: { token: '<token from port file>' },
  id: 1
}));
```

## API Reference

All methods use JSON-RPC 2.0. Via MCP, call them as tools (`vault.read`, `vault.search`, etc.).

### Read Operations

| Method | Params | Description |
|--------|--------|-------------|
| `vault.read` | `path` | Read a note's content |
| `vault.list` | `path?` | List files and folders |
| `vault.stat` | `path` | File/folder metadata (size, dates) |
| `vault.exists` | `path` | Check if path exists |
| `vault.getMetadata` | `path` | Parsed frontmatter, links, tags, headings |

### Write Operations (dry-run by default)

| Method | Params | Description |
|--------|--------|-------------|
| `vault.create` | `path, content?, dryRun?` | Create a new note |
| `vault.modify` | `path, content, dryRun?` | Overwrite an existing note |
| `vault.append` | `path, content, dryRun?` | Append to a note |
| `vault.delete` | `path, force?, dryRun?` | Delete a note or folder |
| `vault.rename` | `from, to, dryRun?` | Move/rename a file |
| `vault.mkdir` | `path, dryRun?` | Create a directory |

All write operations default to `dryRun: true`. Pass `dryRun: false` to execute.

### Search & Graph

| Method | Params | Description |
|--------|--------|-------------|
| `vault.search` | `query, regex?, caseSensitive?, maxResults?, glob?` | Fulltext search |
| `vault.searchByTag` | `tag` | Find notes with a tag |
| `vault.searchByFrontmatter` | `key, value?, op?` | Query by frontmatter fields |
| `vault.graph` | `type?` | Link graph (nodes, edges, orphans) |
| `vault.backlinks` | `path` | Find notes linking to a note |

### Batch & Health

| Method | Params | Description |
|--------|--------|-------------|
| `vault.batch` | `operations, dryRun?` | Multiple operations in one call |
| `vault.lint` | `requiredFrontmatter?` | Vault health check |
| `vault.init` | `topic` | Scaffold a knowledge base structure |

`vault.lint` reports: orphan files, broken wikilinks, empty files, missing frontmatter, duplicate titles.

## Settings

In Obsidian Settings > Vault Bridge:

- **Port**: WebSocket port (default: 27124, 0 = auto)
- **Token**: Authentication token (auto-generated)
- **Dry-run default**: Whether write operations require explicit `dryRun: false` (default: on)

## Security

- **localhost only** -- WebSocket binds to 127.0.0.1
- **Token auth** -- every connection must authenticate first
- **Dry-run by default** -- writes are no-ops unless explicitly enabled
- **Path traversal blocked** -- `..` segments are rejected

## Architecture

```
src/
  main.ts          Plugin lifecycle, server startup
  server.ts        WebSocket server, auth, JSON-RPC dispatch
  bridge.ts        Vault operations (wraps Obsidian API)
  handlers.ts      RPC method handlers
  protocol.ts      JSON-RPC constants and types
  types.ts         Settings, type definitions
  settings.ts      Settings UI tab
  port-file.ts     Port file management (~/.obsidian-ws-port)
  events.ts        Internal event system (not exposed)
connector.js       MCP stdio server with WS proxy + filesystem fallback
```

## Python Companions

| File | Purpose | Dependencies |
|------|---------|-------------|
| `vault_bridge.py` | Async Python WebSocket client for vault-bridge | `websockets` |
| `mcp_server.py` | Python MCP server (alternative to connector.js) | `mcp`, `websockets` |
| `kb_meta.py` | Deterministic KB ops: diff, hash, index, lint, topology | stdlib only |

These are optional. The plugin and connector.js work standalone.

For the full KB compilation workflow (LLM-powered raw->wiki pipeline), see [CLAUDE.md](CLAUDE.md).

## License

MIT
