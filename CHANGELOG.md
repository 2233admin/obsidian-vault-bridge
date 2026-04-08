# Changelog

## v1.0.0 -- 2026-04-08

首次公开发布。vault-mind 是 Knowledge OS for Claude Code + Obsidian，采用四层架构：MCP server + unified query adapters + auto-compile pipeline + Claude 驱动的 agent scheduler。

### Phase 1 -- Foundation
- eee222b feat: Phase 1 scaffold + code migration + adapter interface
- 80f8b42 feat: MCP server index.ts + CI + lint fixes

### Phase 2-3 -- Compiler & MCP Methods
- 64a4bb8 feat(compiler): auto-orchestration pipeline with chunking, extraction, and contradiction detection
- c89ddea feat(mcp): complete vault.* methods + adapter registry
- b3b056f chore: session handoff -- P1-P3 done, next P4 unified query

### Phase 4 -- Unified Query & Compile Triggers
- dfa1106 feat(phase4): unified query + compile triggers + memu/gitnexus adapters
- de7c7fc docs: update progress -- Phase 4 complete, MVP done

### Phase 5 -- Agent Scheduler
- ebef6ef feat(phase5): agent scheduler + evaluate + MCP wiring

### Phase 6 -- Distribution & Skills
- 713d051 feat(phase6): distribution + skills (Gemini + Claude fixes)

### Documentation & Philosophy
- eacba53 docs: 设计哲学 -- 矛盾论+实践论+群众路线
- af48d4a docs: 完整设计哲学 -- 马克思政治经济学 + 毛泽东三论

### Release
- 2db30b2 docs: vault-mind design spec + GSD planning artifacts
- 9139a2b docs: all phases complete -- v1.0 ready

### Post-v1.0 polish (included in the tagged release)
- b5f21a0 chore: gitignore harness runtime state
- 498e3b7 fix(mcp): thread detected config path into agent evaluate.py
- f451d12 ci: cache npm install and align branch to main
