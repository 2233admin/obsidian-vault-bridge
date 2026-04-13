# Phase 1B Spec: Recipe 框架 + x-to-vault

**Estimated:** 3-4 天
**Dependencies:** 无 (可与 1A 并行)
**Branch:** `feat/recipes`

## 问题

vault-mind 的知识来源只有 Obsidian vault 里已有的文件。没有主动从外部数据源拉数据的能力。gbrain 有 7 个 recipes (email/calendar/X/voice/meeting)，我们需要同样的框架。

## 方案

建立 Recipe 摄入框架（YAML frontmatter + markdown body + collector pattern），实现第一个 recipe (x-to-vault)。

## Recipe 格式

```yaml
---
id: x-to-vault
name: X-to-Vault
version: 0.1.0
description: Twitter timeline + mentions → vault research notes
category: sense                    # infra | sense | reflex
requires: []                       # 依赖的其他 recipe
secrets:
  - name: X_BEARER_TOKEN
    description: Twitter API v2 Bearer token
    where: https://developer.x.com/portal
health_checks:
  - "curl -sf -H 'Authorization: Bearer $X_BEARER_TOKEN' 'https://api.x.com/2/users/me' && echo OK"
setup_time: 15 min
cost_estimate: "$0 (read-only free tier)"
---

# X-to-Vault

You are the installer. Follow these steps precisely.

## Step 1: Verify API Access
...
```

## 文件变更计划

### 新建

| 文件 | 内容 |
|------|------|
| `recipes/_types.ts` | RecipeFrontmatter, RecipeSecret, RecipeStatus, RecipeEvent interfaces |
| `recipes/_framework.ts` | parseRecipe(), getRecipeStatus(), runHealthCheck(), appendHeartbeat() |
| `recipes/_registry.ts` | scanRecipes() → Recipe[], findRecipe(id) |
| `recipes/x-to-vault.md` | 第一个 recipe: Twitter → vault |
| `recipes/collectors/x-collector.ts` | X API v2 collector: timeline + mentions → digest.md |
| `~/.vault-mind/` | 运行时目录（首次 init 创建） |

### 修改

| 文件 | 改动 |
|------|------|
| `mcp-server/src/core/operations.ts` | 新增 recipe.list / recipe.show / recipe.status / recipe.doctor |

## Collector 设计 (code for data)

```typescript
// recipes/collectors/x-collector.ts

interface CollectorConfig {
  bearerToken: string;
  userId: string;           // 自动从 /users/me 获取
  outputDir: string;        // ~/.vault-mind/recipes/x-to-vault/
  vaultDir: string;         // E:/knowledge/ (或配置)
  sinceId?: string;         // 增量同步起点
}

interface CollectorOutput {
  raw: string[];            // raw/{id}.json 文件列表
  digest: string;           // digests/{date}.md 路径
  stats: { fetched: number; new: number; skipped: number };
}

async function collect(config: CollectorConfig): Promise<CollectorOutput> {
  // 1. GET /users/{id}/tweets (paginated, since_id)
  // 2. GET /users/{id}/mentions (paginated, since_id)
  // 3. 去噪: 过滤 retweets, ads, bot accounts
  // 4. 写 raw/{id}.json (原始 API 响应)
  // 5. 生成 digests/{date}.md (人类/agent 可读摘要)
  // 6. 更新 state.json (分页状态、最新 since_id)
  // 7. appendHeartbeat({ event: 'sync', stats })
}
```

## Digest 格式 (给 compile.py 消费)

```markdown
---
date: 2026-04-13
source: x-to-vault
type: digest
tweets_count: 47
mentions_count: 12
---

# X Digest — 2026-04-13

## Timeline Highlights

### @karpathy (4 tweets)
- [14:23] New blog post on LLM memory architectures... [link](https://x.com/...)
- [16:01] Interesting finding: pgvector with HNSW... [link](https://x.com/...)

### @kepano (2 tweets)
- [09:15] Obsidian 1.12 CLI is 54x faster... [link](https://x.com/...)

## Mentions

### @someone mentioned you
- [11:30] "Your vault-mind project looks interesting..." [link](https://x.com/...)

## Topics Detected
- AI memory systems (5 tweets)
- Obsidian ecosystem (3 tweets)
- pgvector performance (2 tweets)
```

## 运行时目录结构

```
~/.vault-mind/
├─ config.yaml              # 全局配置
└─ recipes/
    └─ x-to-vault/
        ├─ heartbeat.jsonl   # append-only 事件日志
        ├─ state.json        # 分页状态、since_id
        ├─ raw/              # 原始 API 响应
        │   └─ {tweet_id}.json
        └─ digests/          # 日期索引摘要
            └─ 2026-04-13.md
```

## Cron 调度

```
# 每 30 分钟拉推文
*/30 * * * * cd ~/vault-mind && node recipes/collectors/x-collector.ts

# 每天 3 次 compile digest → vault
0 8,14,22 * * * cd ~/vault-mind && python compiler/compile.py E:/knowledge/04-Research/x-digest --tier haiku
```

## 验证计划

1. x-collector 能拉取 timeline（mock X API 或 real token）
2. 生成的 digest.md 格式正确
3. recipe.list 返回 x-to-vault + 状态
4. recipe.doctor 检查 token + API
5. compile.py 能消费 digest → 提取概念

## 风险

| 风险 | 缓解 |
|------|------|
| X API rate limit (Free: 1500 tweets/mo) | collector 做 rate limit tracking + backoff |
| X API 可能需要 Basic tier ($200/mo) 才能 search | 首版只做 timeline + mentions，不做 search |
| digest 格式和 compile.py 输入不兼容 | compile.py 已支持任意 .md，只是需要确认 chunk 策略 |
