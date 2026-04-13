# vault-mind — Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-13)

**Core value:** 知识不编译就是垃圾
**Current milestone:** v2.0 — Contract-first + Hybrid Search + Recipes
**Current focus:** Phase 1A — Contract-first operations.ts

## v1.0.0 Status (shipped 2026-04-08)

- ✅ MCP server + 4 adapters (filesystem/obsidian/memU/gitnexus)
- ✅ KB 编译管线 (compile.py + kb_meta.py)
- ✅ connector.js (llm-wiki MCP)
- ✅ 8 vault skills + 4 hooks
- ✅ ObsidianAdapter (2026-04-13, 20/20 tests)
- ✅ GitHub release v1.0.0 (5 stars, 3 forks)

## v2.0 Status

| Phase | Name | Status | Notes |
|-------|------|--------|-------|
| **1A** | Contract-first | 🔵 Next | operations.ts 消灭 15 个重复 tool |
| 1B | Recipe 框架 | ⚪ Pending | x-to-vault 首发 |
| 2 | PGLite 引擎 | ⚪ Pending | 依赖 1A |
| 3 | Hybrid Search + RRF | ⚪ Pending | 依赖 2 |
| 4 | 更多 Recipes | ⚪ Pending | 依赖 1B |

## 今日已修复的问题 (2026-04-13)

| 问题 | 修复 | 文件 |
|------|------|------|
| PostCompact hook 路径断线 | skills/ → skills-cold/ | ~/.claude/settings.json |
| 迷路的 MEMORY.md | 清空 | commands/.claude/agent-memory/MEMORY.md |
| 全局记忆主干缺失 | 创建 ~/.claude/MEMORY.md (~60行) | ~/.claude/MEMORY.md |
| vault-bg-agent 写入冲突 | 加 WRITE PARTITION 约束 | skills-cold/vault-brain/hooks/vault-bg-agent.ps1 |
| vault-mind 缺 CLAUDE.md | 创建项目级 CLAUDE.md | D:/projects/vault-mind/CLAUDE.md |

## 设计决策 (2026-04-13)

1. **学 gbrain 模式，不用代码** — garrytan/gbrain 7K stars，三个模式值得偷（Contract-first / PGLite / Recipe），但代码绑 Bun + OpenAI，不 fork
2. **Recipe 替代独立 Voile** — Voile 不再是独立项目，而是 vault-mind 的 wechat-to-vault recipe 的后端实现
3. **gbrain 不做独立仓库** — 如果要做"有主见的 Agent 大脑"，做成 vault-mind 的 agent.* namespace 实现
4. **MCP 职责去重** — connector.js 变成 operations.ts 的 vault.* 子集消费者，不再有独立的 VaultFs 类

## Session Log

### 2026-04-07 — Design Session (v1)
- Spec written, PROJECT/REQUIREMENTS/ROADMAP created
- Key decisions: adapter 体系, filesystem 为默认

### 2026-04-08 — v1.0.0 shipped
- 18 commits, GitHub release, 5 stars/3 forks

### 2026-04-13 — v2 Architecture Session
- 审查 Knowledge OS 全组件现状
- 画架构图 (Excalidraw + Draw.io)
- 诊断四个核心问题 (MCP 重叠/记忆碎片/断线/写冲突)
- 修复 P0 (hook 路径) + P1b (全局 MEMORY.md) + P2 (写冲突/CLAUDE.md)
- 研究 garrytan/gbrain 三个模式
- 研究 gbrain 7 个 recipes
- 输出 v2 Roadmap: Phase 1A-1B-2-3-4
- 项目整合判断: vault-mind 做中枢，Voile/gbrain 做外围
