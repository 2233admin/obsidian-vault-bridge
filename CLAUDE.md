# CLAUDE.md — vault-mind

## What This Is

Knowledge OS for AI agents. 四层架构:
1. **MCP Server** (TypeScript, stdio) — 统一接口
2. **Adapter Registry** — filesystem(default) / obsidian(WS) / memU(pgvector) / gitnexus(graph)
3. **KB Compiler** (Python, zero-dep) — raw/ → wiki/ 单向编译
4. **Agent Scheduler** — compile/emerge/reconcile/prune/challenge 自动调度

核心命题: **知识不编译就是垃圾。**

## Stack

- TypeScript + @modelcontextprotocol/sdk (stdio transport)
- Python 3.11+ (kb_meta.py / compile.py, zero-dep)
- ripgrep subprocess (filesystem adapter search)
- esbuild bundler

## Architecture

```
Claude Code ─stdio→ MCP Server ─┬─ vault.* (CRUD + search + graph)
                                 ├─ compile.* (status/run/diff/abort)
                                 ├─ query.* (unified/search/explain)
                                 └─ agent.* (status/trigger/schedule)
                                      │
                          AdapterRegistry
                          ├─ filesystem (default, always on)
                          ├─ obsidian (WS → vault-bridge)
                          ├─ memU (subprocess → pgvector)
                          └─ gitnexus (subprocess → graph)
```

## Key Invariants

1. **Filesystem fallback is global invariant** — Obsidian 不开也能用
2. **编译是单向的** — raw/ → compile.py → wiki/，不反向污染源
3. **adapter 失败不阻塞** — Promise.allSettled 隔离，静默降级
4. **dryRun=true 默认** — 所有写操作

## Repo Layout

- `mcp-server/src/` — MCP server + adapters
- `compiler/` — Python 编译管线 (kb_meta.py, compile.py, chunker, extractor)
- `skills/` — 8 vault skills (save/world/challenge/emerge/connect/graduate/ingest/bridge)
- `hooks/` — cron hooks (nightly/weekly/bg-agent)
- `connector.js` — llm-wiki MCP (轻量前端, vault.* CRUD)

## Branches

- `main` — vault-mind headless MCP (v1.0.0 shipped 2026-04-08)
- `legacy-v0.1.0-obsidian-plugin` — 归档

## Known Issues

- connector.js 和 MCP server 有 15 个 vault.* tool 完全重叠 — 待去重
- main/master 分支策略未定 (master = obsidian-vault-bridge 在同仓库)

## Run

```bash
# MCP server (TypeScript)
cd mcp-server && npm run dev

# KB 编译 (Python)
python compiler/compile.py E:/knowledge/KB/brillm --tier haiku

# kb_meta CLI
python compiler/kb_meta.py diff E:/knowledge KB/brillm
```

## Test

```bash
cd mcp-server && npm test    # adapter tests
cd compiler && python -m pytest tests/
```
