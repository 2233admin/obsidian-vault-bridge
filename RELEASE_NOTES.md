# vault-mind v1.0.0

**Knowledge OS for Claude Code + Obsidian.**
四层架构：MCP server + unified query adapters + auto-compile pipeline + Claude 驱动的 agent scheduler。

## Highlights

- 21 个 vault.* MCP 方法（search / read / write / graph / lint 等）
- Filesystem fallback -- Obsidian 不开也能正常工作
- 统一查询：memU + GitNexus + vault 三路加权融合
- 自动编译管线：脏队列 + 批处理
- 198 个对抗性测试（51 FS 渗透 + 48 WS 攻击 + 41 fuzzing + 58 E2E）
- 24 个 bug 在硬化期被发现并修复（路径穿越、HTTP 死锁、CLOSE_WAIT、timing-safe auth、CRLF、BOM、原子写等）
- 一键安装脚本 `setup.sh`
- 9 个捆绑 skill：vault-save / vault-world / vault-challenge / vault-emerge / vault-connect / vault-graduate / vault-ingest / vault-health / vault-reconcile

## Quick Start

```bash
git clone <repo-url>
cd vault-mind
bash setup.sh
```

之后在 Claude Code 中重启会话，输入 `/vault-world` 开始使用。详见 README.md。

## Known Limitations

- 并发 create 存在 TOCTOU 竞争（Obsidian API 限制，需 per-path mutex）
- Linux symlink 遍历尚未加固（目前主要在 Windows 上验证）
- dreamtime 集成在 CLAUDE.md 中有描述，核心代码尚未实现

## Credits

- 作者：Curry
- AI 合作伙伴：Claude Code（主力）、Codex、Gemini 4
- 设计哲学：矛盾论 + 实践论 + 群众路线 + 马克思政治经济学
- 开发周期：2026-04-05 立项 -- 2026-04-08 v1.0 完成
