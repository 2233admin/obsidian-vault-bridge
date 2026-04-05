"""MCP stdio server bridging Claude Code / Desktop to Obsidian Vault Bridge.

Usage:
  pip install mcp websockets
  python mcp_server.py

Claude Code config (~/.claude.json):
  "mcpServers": {
    "vault-bridge": {
      "command": "python",
      "args": ["/path/to/obsidian-vault-bridge/mcp_server.py"]
    }
  }
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

from vault_bridge import VaultBridge

app = Server("vault-bridge")
_bridge: VaultBridge | None = None


async def get_bridge() -> VaultBridge:
    global _bridge
    if _bridge is None or _bridge._closed:
        _bridge = VaultBridge.from_discovery()
        await _bridge.connect()
    return _bridge


# -- Tool definitions ------------------------------------------------------

TOOLS = [
    Tool(
        name="vault_read",
        description="Read file content from the Obsidian vault",
        inputSchema={
            "type": "object",
            "properties": {"path": {"type": "string", "description": "File path relative to vault root"}},
            "required": ["path"],
        },
    ),
    Tool(
        name="vault_list",
        description="List files and folders in a vault directory",
        inputSchema={
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Folder path (empty for root)", "default": ""}},
        },
    ),
    Tool(
        name="vault_stat",
        description="Get file/folder metadata (type, size, timestamps)",
        inputSchema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    ),
    Tool(
        name="vault_exists",
        description="Check if a file or folder exists",
        inputSchema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    ),
    Tool(
        name="vault_create",
        description="Create a new file in the vault (dry-run by default)",
        inputSchema={
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string", "default": ""},
                "dryRun": {"type": "boolean", "description": "false to actually create"},
            },
            "required": ["path"],
        },
    ),
    Tool(
        name="vault_modify",
        description="Replace file content (dry-run by default)",
        inputSchema={
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
                "dryRun": {"type": "boolean"},
            },
            "required": ["path", "content"],
        },
    ),
    Tool(
        name="vault_append",
        description="Append content to an existing file (dry-run by default)",
        inputSchema={
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
                "dryRun": {"type": "boolean"},
            },
            "required": ["path", "content"],
        },
    ),
    Tool(
        name="vault_delete",
        description="Delete a file (moves to trash by default, dry-run by default)",
        inputSchema={
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "force": {"type": "boolean", "default": False},
                "dryRun": {"type": "boolean"},
            },
            "required": ["path"],
        },
    ),
    Tool(
        name="vault_rename",
        description="Rename/move a file (dry-run by default)",
        inputSchema={
            "type": "object",
            "properties": {
                "from": {"type": "string", "description": "Current path"},
                "to": {"type": "string", "description": "New path"},
                "dryRun": {"type": "boolean"},
            },
            "required": ["from", "to"],
        },
    ),
    Tool(
        name="vault_search",
        description="Full-text search across vault markdown files",
        inputSchema={
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "regex": {"type": "boolean", "default": False},
                "caseSensitive": {"type": "boolean", "default": False},
                "maxResults": {"type": "integer", "default": 50},
                "glob": {"type": "string", "description": "Filter files by glob pattern"},
                "context": {"type": "integer", "default": 1, "description": "Context lines before/after match"},
            },
            "required": ["query"],
        },
    ),
    Tool(
        name="vault_search_by_tag",
        description="Find all files with a specific tag",
        inputSchema={
            "type": "object",
            "properties": {"tag": {"type": "string", "description": "Tag name (with or without #)"}},
            "required": ["tag"],
        },
    ),
    Tool(
        name="vault_search_by_frontmatter",
        description="Find files by frontmatter property (supports operators: eq/ne/gt/lt/gte/lte/contains/regex/exists)",
        inputSchema={
            "type": "object",
            "properties": {
                "key": {"type": "string"},
                "value": {"description": "Value to compare"},
                "op": {"type": "string", "enum": ["eq", "ne", "gt", "lt", "gte", "lte", "contains", "regex", "exists"], "default": "eq"},
            },
            "required": ["key"],
        },
    ),
    Tool(
        name="vault_get_metadata",
        description="Get parsed metadata for a file (links, tags, headings, frontmatter, sections)",
        inputSchema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    ),
    Tool(
        name="vault_graph",
        description="Get the vault link graph (nodes, edges, orphans)",
        inputSchema={
            "type": "object",
            "properties": {"type": {"type": "string", "enum": ["resolved", "unresolved", "both"], "default": "both"}},
        },
    ),
    Tool(
        name="vault_backlinks",
        description="Get all files that link to a given file",
        inputSchema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    ),
    Tool(
        name="vault_lint",
        description="Health-check the vault: orphans, broken links, empty files, missing frontmatter, duplicate titles",
        inputSchema={
            "type": "object",
            "properties": {
                "requiredFrontmatter": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Frontmatter keys that every file should have",
                },
            },
        },
    ),
    Tool(
        name="vault_batch",
        description="Execute multiple vault operations sequentially",
        inputSchema={
            "type": "object",
            "properties": {
                "operations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "method": {"type": "string"},
                            "params": {"type": "object"},
                        },
                        "required": ["method"],
                    },
                },
                "dryRun": {"type": "boolean"},
            },
            "required": ["operations"],
        },
    ),
]

# Map MCP tool names to vault-bridge RPC methods + param transformers
TOOL_MAP: dict[str, tuple[str, Any]] = {
    "vault_read": ("vault.read", lambda a: {"path": a["path"]}),
    "vault_list": ("vault.list", lambda a: {"path": a.get("path", "")}),
    "vault_stat": ("vault.stat", lambda a: a),
    "vault_exists": ("vault.exists", lambda a: a),
    "vault_create": ("vault.create", lambda a: a),
    "vault_modify": ("vault.modify", lambda a: a),
    "vault_append": ("vault.append", lambda a: a),
    "vault_delete": ("vault.delete", lambda a: a),
    "vault_rename": ("vault.rename", lambda a: a),
    "vault_search": ("vault.search", lambda a: a),
    "vault_search_by_tag": ("vault.searchByTag", lambda a: a),
    "vault_search_by_frontmatter": ("vault.searchByFrontmatter", lambda a: a),
    "vault_get_metadata": ("vault.getMetadata", lambda a: a),
    "vault_graph": ("vault.graph", lambda a: a),
    "vault_backlinks": ("vault.backlinks", lambda a: a),
    "vault_lint": ("vault.lint", lambda a: a),
    "vault_batch": ("vault.batch", lambda a: a),
}


@app.list_tools()
async def list_tools() -> list[Tool]:
    return TOOLS


@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name not in TOOL_MAP:
        return [TextContent(type="text", text=f"Unknown tool: {name}")]

    rpc_method, transform = TOOL_MAP[name]
    params = transform(arguments)

    try:
        vb = await get_bridge()
        result = await vb.call(rpc_method, params)
        text = json.dumps(result, indent=2, ensure_ascii=False) if isinstance(result, (dict, list)) else str(result)
        return [TextContent(type="text", text=text)]
    except Exception as e:
        return [TextContent(type="text", text=f"Error: {e}")]


async def main() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
