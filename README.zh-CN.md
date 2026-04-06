# Obsidian LLM Wiki

[![CI](https://github.com/2233admin/obsidian-llm-wiki/actions/workflows/ci.yml/badge.svg)](https://github.com/2233admin/obsidian-llm-wiki/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json) [![Python](https://img.shields.io/badge/python-%3E%3D3.11-brightgreen.svg)](kb_meta.py)

[**English**](README.md) | **中文** | [日本語](README.ja.md)

**让你的 AI 助手读、搜、建立在你的 Obsidian 笔记上。**

灵感来自 [Karpathy 的 LLM Wiki](https://www.youtube.com/watch?v=zisonDtp3GQ) -- 但你现在就能装上用。

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
你说：   "上个月我写过什么关于分布式一致性的东西吗？"
Claude: *搜索你的库，读 3 篇笔记，用 [[反向链接]] 合成一个答案*
```

Vault Bridge 把你的 Obsidian 库变成一个 MCP 服务器，任何 AI 智能体（Claude Code、Cursor、Windsurf）都能连上去。读、写、搜、编译知识 -- 笔记是真实数据源。

---

## 快速开始

```bash
git clone https://github.com/2233admin/obsidian-llm-wiki.git
cd obsidian-llm-wiki && npm install && npm run build
node setup.js
```

`setup.js` 会自动找到你的 Obsidian 库、装插件、配置 Claude Code 的 MCP -- 一条命令搞定。然后问 Claude：

```
"搜搜我的笔记，找找有没有关于 React Server Components 的东西"
```

就这样。

<details>
<summary>手动安装（如果 setup.js 对你不管用）</summary>

### 1. 装插件

把 `main.js`、`manifest.json`、`styles.css` 复制到你的库的 `.obsidian/plugins/vault-bridge/` 里，然后在 Obsidian 的设置 > 社区插件 里启用它。

### 2. 连接你的智能体

加到 `~/.claude/settings.json`（或 `.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "vault-bridge": {
      "command": "node",
      "args": ["/path/to/obsidian-llm-wiki/connector.js", "/path/to/your/vault"]
    }
  }
}
```

### 3. 验证

```bash
node demo.js
```

</details>

---

## 智能体能干什么？

| 功能 | 例子 |
|-----------|---------|
| **读任意笔记** | "读我的 notes/architecture-decisions.md" |
| **全文搜索** | "找找所有提过'auth middleware'的笔记" |
| **按标签搜** | "把所有标了 #project-x 的笔记给我列出来" |
| **按 frontmatter 查** | "列出 status 是'in-progress'的笔记" |
| **顺着图走** | "什么笔记链接到了 [[API Design]]？" |
| **新建笔记** | "给这个 PR 写个总结放我的库里" |
| **编辑笔记** | "把今天的站会笔记加到我的日志里" |
| **编译知识** | "吃掉这篇论文，更新我的知识 wiki" |
| **体检** | "找找我的库里有没有孤儿笔记和坏链接" |

所有写操作**默认都是模拟的** -- 你的智能体必须明确选择才能改东西。你的笔记很安全。

---

## 为什么选 Vault Bridge？

|  | Vault Bridge | [obsidian-claude-code-mcp](https://github.com/iansinnott/obsidian-claude-code-mcp) | [obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api) |
|--|-------------|------------------------|------------------------|
| 协议 | MCP + WebSocket | MCP + WebSocket | REST (HTTPS) |
| Obsidian 不开也能用 | 能（文件系统 fallback） | 不能 | 不能 |
| 搜索 | 全文 + 标签 + frontmatter + 正则 | 基础 | 内容搜索 |
| 知识编译 | 内置（吃进 -> 编译 -> wiki） | 不支持 | 不支持 |
| 图查询 | 链接图 + 反向链接 + 孤儿检测 | 不支持 | 不支持 |
| 写安全 | 模拟优先 | 无防护 | 无防护 |
| 库体检 | 有（坏链、孤儿、缺 frontmatter） | 没有 | 没有 |
| 批量操作 | 支持 | 不支持 | 不支持 |
| 实时事件 | WebSocket 文件变化推送 | 没有 | 没有 |
| 认证 | Token + 时序安全对比 | Token | API key + HTTPS |

---

## 知识编译工作流

这是 [Karpathy LLM Wiki](https://www.youtube.com/watch?v=zisonDtp3GQ) 的想法，真实了：

```
原始源（论文、文章、笔记）
    |
    v  [vault.init] 给一个话题搭好框架
    |
    v  把源文件丢进 raw/
    |
    v  [kb_meta.py diff] 发现新源
    |
    v  LLM 提出概念、总结、关系
    |
    v  [kb_meta.py update-hash] 标记已编译
    |
    v  [kb_meta.py update-index] 重建 wiki 索引
    |
    v  [kb_meta.py check-links] 验证完整性
    |
已编译的 wiki，带上 [[wiki链接]]、frontmatter、覆盖标签
```

你的智能体负责提取。`kb_meta.py` 处理记账工作（diff、hash、索引） -- 零依赖，纯 Python。

---

## 怎么工作的

```
AI 智能体  <--MCP stdio-->  connector.js  <--WebSocket-->  Obsidian 插件
                               |
                          (Obsidian 关闭时用文件系统 fallback)
```

- **插件**在 Obsidian 里跑一个 WebSocket 服务器（JSON-RPC 2.0，仅本地）
- **connector.js** 是个 MCP 服务器，代理到 WebSocket，或者 Obsidian 关闭时直接读库
- 通过 `~/.obsidian-ws-port` 自动发现 -- 不需要手动配端口

---

## API 参考

20 个工具可通过 MCP 用。都用 JSON-RPC 2.0。

<details>
<summary>读操作</summary>

| 方法 | 参数 | 描述 |
|--------|--------|-------------|
| `vault.read` | `path` | 读一篇笔记的内容 |
| `vault.list` | `path?` | 列出文件和文件夹 |
| `vault.stat` | `path` | 文件/文件夹元数据（大小、日期） |
| `vault.exists` | `path` | 检查路径存不存在 |
| `vault.getMetadata` | `path` | 解析过的 frontmatter、链接、标签、标题 |

</details>

<details>
<summary>写操作（默认模拟）</summary>

| 方法 | 参数 | 描述 |
|--------|--------|-------------|
| `vault.create` | `path, content?, dryRun?` | 新建笔记 |
| `vault.modify` | `path, content, dryRun?` | 覆盖一篇笔记 |
| `vault.append` | `path, content, dryRun?` | 追加到笔记 |
| `vault.delete` | `path, force?, dryRun?` | 删笔记或文件夹 |
| `vault.rename` | `from, to, dryRun?` | 移动/重命名文件 |
| `vault.mkdir` | `path, dryRun?` | 新建目录 |

</details>

<details>
<summary>搜索 & 图</summary>

| 方法 | 参数 | 描述 |
|--------|--------|-------------|
| `vault.search` | `query, regex?, caseSensitive?, maxResults?, glob?` | 全文搜索 |
| `vault.searchByTag` | `tag` | 找有某标签的笔记 |
| `vault.searchByFrontmatter` | `key, value?, op?` | 按 frontmatter 字段查 |
| `vault.graph` | `type?` | 链接图（节点、边、孤儿） |
| `vault.backlinks` | `path` | 找链接到一篇笔记的笔记 |

</details>

<details>
<summary>批量 & 体检</summary>

| 方法 | 参数 | 描述 |
|--------|--------|-------------|
| `vault.batch` | `operations, dryRun?` | 一次调用多个操作 |
| `vault.lint` | `requiredFrontmatter?` | 库体检 |
| `vault.init` | `topic` | 搭好知识库结构框架 |

</details>

---

## 安全

- **仅本地** -- WebSocket 绑到 127.0.0.1，不暴露到网络
- **Token 认证** -- 时序安全对比、5s 认证超时、自动生成 256 比特 token
- **模拟优先** -- 写操作默认不执行，除非你传 `dryRun: false`
- **路径遍历被挡** -- `..` 段被拒、`.obsidian/` 写操作被保护
- **连接限制** -- 最多 20 个客户端、10MB 有效负载上限、ReDoS 安全的正则
- **文件系统 fallback** -- Obsidian 关闭时也是同样的安全模型

---

## Python 伴侣（可选）

| 文件 | 用途 | 依赖 |
|------|---------|-------------|
| `kb_meta.py` | 确定性知识库操作：diff、hash、索引、体检、活力检查 | 只用 stdlib |
| `vault_bridge.py` | 异步 Python WebSocket 客户端 | `websockets` |
| `mcp_server.py` | Python MCP 服务器（connector.js 的替代品） | `mcp`, `websockets` |

---

## License

MIT
