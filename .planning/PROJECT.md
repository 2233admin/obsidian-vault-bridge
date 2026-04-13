# vault-mind

## What This Is

Knowledge OS for AI agents. 四层架构让任何 AI agent 通过标准 MCP 接口操作、编译、摄入、查询知识库。

## Core Value

**知识不编译就是垃圾。** raw notes → compiled concepts/relations/contradictions → 任何 agent 可查询。

## v1.0.0 (已发布 2026-04-08)

MCP server + 4 adapters (filesystem/obsidian/memU/gitnexus) + KB 编译管线 + 8 skills + connector.js。5 stars, 3 forks。

## v2.0 目标 (当前)

学 garrytan/gbrain 三个架构模式，解决四个核心问题：

| 模式 | 解决什么 | 来源 |
|------|---------|------|
| Contract-first | connector.js 和 vault-mind 15 个 tool 重叠 (P1a) | gbrain operations.ts |
| PGLite 嵌入式引擎 | memU 依赖外部 PG，headless-first 不纯粹 | gbrain engine-factory.ts |
| Hybrid Search + RRF | 搜索只有 ripgrep 全文，没向量，没融合 | gbrain search/ |
| Recipe 数据摄入 | vault 只能被动等人写笔记，没有主动摄入 | gbrain recipes/ |

## Constraints

- TypeScript + @modelcontextprotocol/sdk (stdio)
- Python 3.11+ (compiler, zero-dep)
- Bun 可选（gbrain 用 Bun，我们可以兼容但不强依赖）
- Filesystem fallback 是 global invariant
- dryRun=true 默认
- 不 fork gbrain，只学模式
- 不破坏 v1.0.0 已发布的 MCP 接口
