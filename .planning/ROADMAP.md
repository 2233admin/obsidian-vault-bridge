# Roadmap: vault-mind v2

**Created:** 2026-04-13
**Milestone:** v2.0 — Knowledge OS with Contract-first + Hybrid Search + Recipes

## Design References

- garrytan/gbrain (7K stars): Contract-first operations, PGLite engine, Recipe pattern, Hybrid Search + RRF
- 本次设计 session 完整分析: E:/knowledge/05-Engineering/knowledge-os-architecture.drawio

## Phase Overview

| Phase | Name | Goal | 预估 | Depends |
|-------|------|------|------|---------|
| 1A | Contract-first | 一个 operations.ts 消灭 15 个重复 tool | 2-3 天 | — |
| 1B | Recipe 框架 | 数据摄入能力从 0 到 1 (x-to-vault 首发) | 3-4 天 | — |
| 2 | SearchEngine 抽象 + PGLite | 零配置向量搜索，memU 降级为生产选项 | 1 周 | 1A |
| 3 | Hybrid Search + RRF | vector + keyword + ripgrep → RRF fusion + dedup | 1 周 | 2 |
| 4 | 更多 Recipes | email/calendar/wechat-to-vault | 按需 | 1B |

## Phase 1A: Contract-first operations.ts

**Goal:** 单一事实来源——所有 MCP tool 在 operations.ts 定义一次，connector.js 和 vault-mind MCP server 都是消费者。

**设计来源:** gbrain `src/core/operations.ts` 的 Operation interface + handler pattern

**核心改动:**

1. 新建 `mcp-server/src/core/operations.ts`:
   - 定义 `Operation` interface: `{ name, namespace, description, params, handler, mutating }`
   - 定义 `ParamDef` interface: `{ type, required, description, default }`
   - 定义 `OperationContext`: `{ vault, adapters, config, logger, dryRun }`
   - 导出 `operations: Operation[]` — 所有 30+ tool 的定义和 handler

2. 重写 `mcp-server/src/mcp/server.ts`:
   - `ListTools`: 从 `operations[]` 自动生成 MCP inputSchema
   - `CallTool`: 查找 operation → 验证参数 → 调 handler

3. 重写 `connector.js` → `mcp-server/src/connector/connector.ts`:
   - 从 `operations[]` 过滤 `namespace: 'vault'` → 注册为 MCP tools
   - 保留双 transport: WS → vault-bridge / FS fallback
   - 删除 VaultFs 类（合并到 operations handler 里）

4. 删除重复代码:
   - connector.js 的 32KB VaultFs 类
   - vault-mind index.ts 的 vault.* handler 代码

**Success criteria:**
- [ ] operations.ts 包含全部 30+ tool 定义
- [ ] connector 只注册 vault.* namespace（~20 个 tool）
- [ ] vault-mind MCP server 注册全部 namespace（30+ tool）
- [ ] 两个 MCP server 的参数/返回值完全一致（从同一份 operations 生成）
- [ ] 现有 343 tests 全绿
- [ ] connector.js (旧) 删除，新 connector.ts 替代

## Phase 1B: Recipe 框架 + x-to-vault

**Goal:** 建立 Recipe 摄入框架，实现第一个 recipe (Twitter/X → vault)。

**设计来源:** gbrain `recipes/` YAML frontmatter + fat markdown + collector pattern

**核心改动:**

1. 新建 `recipes/` 目录:
   - `_types.ts`: RecipeFrontmatter interface, RecipeSecret, RecipeStatus
   - `_framework.ts`: YAML 解析 + 状态管理 + health check runner + heartbeat JSONL
   - `_registry.ts`: 扫描 recipes/ 下所有 .md → 返回 Recipe[]

2. 新建 `recipes/x-to-vault.md`:
   - YAML frontmatter: id, name, version, category(sense), requires[], secrets(X_BEARER_TOKEN), health_checks
   - Markdown body: agent 安装指南（step-by-step）
   - Collector 引用: `recipes/collectors/x-collector.ts`

3. 新建 `recipes/collectors/x-collector.ts`:
   - X API v2: GET /users/{id}/tweets + /mentions
   - 输出: `digests/{date}.md` (markdown 摘要) + `raw/{id}.json`
   - 确定性逻辑: 去噪, 去重, pagination state, rate limit handling
   - **code for data, LLM for judgment**

4. operations.ts 新增 recipe namespace:
   - `recipe.list`: 列出所有 recipe + 状态
   - `recipe.show`: 显示某 recipe 的 frontmatter + body
   - `recipe.status`: 健康检查
   - `recipe.doctor`: 全面诊断

5. 新建 `~/.vault-mind/recipes/x-to-vault/`:
   - `heartbeat.jsonl`: 事件日志
   - `state.json`: 分页状态、已知 ID
   - `digests/`: 日期索引的 markdown 摘要

**Success criteria:**
- [ ] `recipe.list` 返回 x-to-vault recipe 及其状态
- [ ] `recipe.show x-to-vault` 返回完整 recipe 内容
- [ ] x-collector.ts 能拉取 Twitter timeline → 生成 digest
- [ ] digest 被 compile.py 消费 → 概念提取
- [ ] heartbeat.jsonl 记录同步事件
- [ ] recipe.doctor 检查 X_BEARER_TOKEN + API 连通性

## Phase 2: SearchEngine 抽象 + PGLite

**Goal:** 引入 SearchEngine 接口 + PGLite 嵌入式引擎，让 vault-mind 零配置就有向量搜索。

**设计来源:** gbrain `src/core/engine.ts` + `engine-factory.ts` + `pglite-engine.ts`

**核心改动:**

1. 定义 `SearchEngine` interface:
   - `searchKeyword(query, opts) → SearchResult[]`
   - `searchVector(embedding, opts) → SearchResult[]`
   - `upsertChunks(path, chunks) → void`
   - `deleteChunks(path) → void`
   - `getStats() → { indexed, embedded }`

2. 实现 `PGLiteSearchEngine`:
   - `@electric-sql/pglite` + pgvector + pg_trgm WASM extensions
   - `~/.vault-mind/search.db/` 持久化目录
   - 文件锁防并发
   - Dynamic import（PGLite ~10MB WASM 只在选用时加载）

3. 实现 `PostgresSearchEngine`:
   - 迁入现有 memU adapter 的搜索逻辑
   - 连接外部 PG 实例

4. `NullSearchEngine`:
   - 所有方法返回空结果
   - 纯 FS 模式的降级选项

5. `engine-factory.ts`:
   - `config.searchEngine: 'pglite' | 'postgres' | 'none'`
   - `createSearchEngine(config) → SearchEngine`

6. Adapter Registry 集成:
   - `adapter-filesystem` 不变（ripgrep 全文）
   - `adapter-search` (NEW): 包装 SearchEngine 接口
   - 替代 `adapter-memu`

**Success criteria:**
- [ ] `vault-mind init` 默认用 PGLite，2 秒启动
- [ ] `vault-mind init --postgres` 用外部 PG
- [ ] PGLite 向量搜索 + 关键词搜索工作
- [ ] 现有 adapter-filesystem 不受影响
- [ ] NullSearchEngine 保持 filesystem fallback invariant

## Phase 3: Hybrid Search + RRF

**Goal:** 多信号融合搜索——vector + keyword + ripgrep → RRF → 4-layer dedup。

**设计来源:** gbrain `src/core/search/` + `expansion.ts`

**核心改动:**

1. `search/hybrid.ts`:
   - 输入: query string + SearchEngine + FilesystemAdapter
   - Multi-query expansion（可选，需 LLM API key，用最便宜的 Haiku）
   - 并行: searchVector × N variants + searchKeyword + ripgrep
   - Promise.allSettled 隔离失败
   - RRF Fusion (K=60)
   - 4-layer dedup: by source → by text (Jaccard) → by type (≤60%) → by page

2. `search/expansion.ts`:
   - 用 Claude Haiku tool_use 生成 2 个替代查询
   - 短查询 (<3 词) 跳过
   - 失败降级为原始 query

3. `search/dedup.ts`:
   - L1: top 3 chunks per source
   - L2: Jaccard > 0.85 去重
   - L3: 单类型 ≤ 60%
   - L4: max 2 chunks per page

4. `query.unified` operation 重写:
   - 现有的 `unified-query.ts`（score × weight 线性叠加）→ 改用 hybrid search
   - 保持 adapter 级别的 Promise.allSettled 隔离

5. Graceful degradation 链:
   - 完整: vector + keyword + ripgrep + expansion → RRF → dedup
   - 无 LLM: 跳过 expansion
   - 无 SearchEngine: 跳过 vector + keyword
   - 纯 FS: ripgrep only

**Success criteria:**
- [ ] hybrid search 在有 PGLite 时返回融合结果
- [ ] 无 PGLite 时自动降级为 ripgrep only
- [ ] expansion 失败不影响搜索
- [ ] 搜索结果去重有效（无近似重复）
- [ ] 延迟 < 2s（100 条笔记规模）

## Phase 4: 更多 Recipes (按需)

| Recipe | 数据源 | 优先级 | 前置 |
|--------|--------|--------|------|
| wechat-to-vault | Voile QQ/WeChat gateway | 高 | Voile 部署 |
| email-to-vault | Gmail API / ClawVisor | 中 | credential-gateway |
| calendar-to-vault | Google Calendar API | 中 | credential-gateway |
| meeting-to-vault | Circleback 转录 | 低 | — |

每个 recipe 遵循同一模式: collector (code for data) → digest.md → compile.py (LLM for judgment) → vault pages。
