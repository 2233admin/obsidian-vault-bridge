# Phase 1A Spec: Contract-first operations.ts

**Estimated:** 2-3 天
**Dependencies:** 无
**Branch:** `feat/contract-first`

## 问题

connector.js (32KB) 和 vault-mind MCP server 有 15 个 vault.* tool 的实现逻辑完全重复（VaultFs 类 vs handler 代码同构）。两套代码各自演化，已经开始分叉。

## 方案

定义一个 `Operation` interface，所有 tool 在 `operations.ts` 中定义一次。MCP server 和 connector 都是 operations 数组的消费者。

## 文件变更计划

### 新建

| 文件 | 内容 |
|------|------|
| `mcp-server/src/core/operations.ts` | Operation interface + ParamDef + OperationContext + 全部 30+ tool 定义 |
| `mcp-server/src/core/types.ts` | 共享类型：SearchResult, PageMeta, GraphNode 等 |
| `mcp-server/src/core/validate.ts` | 参数验证（从 ParamDef 自动校验） |
| `mcp-server/src/mcp/server.ts` | 重写：从 operations[] 生成 MCP tools |
| `mcp-server/src/connector/connector.ts` | 重写：只注册 vault.* namespace，双 transport |
| `mcp-server/src/connector/ws-transport.ts` | 提取：WebSocket → vault-bridge 连接逻辑 |
| `mcp-server/src/connector/fs-transport.ts` | 提取：Filesystem fallback 逻辑 |

### 删除

| 文件 | 原因 |
|------|------|
| `connector.js` (根目录, 32KB) | 被 connector/connector.ts 替代 |

### 修改

| 文件 | 改动 |
|------|------|
| `mcp-server/src/index.ts` | 入口改为加载 operations → 创建 MCP server |
| `mcp-server/package.json` | 加 connector 的 bin entry |
| `package.json` (根目录) | MCP config 指向新 connector |

## 核心接口

```typescript
// core/operations.ts

interface ParamDef {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
}

interface Operation {
  name: string;                     // e.g. 'vault.read'
  namespace: 'vault' | 'compile' | 'query' | 'agent' | 'recipe';
  description: string;
  params: Record<string, ParamDef>;
  handler: (ctx: OperationContext, params: Record<string, unknown>) => Promise<unknown>;
  mutating?: boolean;               // true → dryRun 拦截
}

interface OperationContext {
  vault: VaultBackend;              // WS transport 或 FS transport
  adapters: AdapterRegistry;        // 多 adapter 并行查询
  config: VaultMindConfig;
  logger: Logger;
  dryRun: boolean;
}

// VaultBackend — connector 双 transport 的抽象
interface VaultBackend {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  search(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  list(dir: string): Promise<string[]>;
  stat(path: string): Promise<FileStat | null>;
  exists(path: string): Promise<boolean>;
  graph(): Promise<GraphData>;
  backlinks(path: string): Promise<BacklinkResult[]>;
}
```

## MCP Server 生成逻辑

```typescript
// mcp/server.ts
import { operations } from '../core/operations';

// ListTools — 从 operations 自动生成
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: operations.map(op => ({
    name: op.name,
    description: op.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(op.params).map(([k, v]) => [k, {
          type: v.type,
          description: v.description,
          default: v.default,
          enum: v.enum,
        }])
      ),
      required: Object.entries(op.params)
        .filter(([_, v]) => v.required)
        .map(([k]) => k),
    },
  })),
}));

// CallTool — 查找 operation → 验证 → handler
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const op = operations.find(o => o.name === req.params.name);
  if (!op) throw new McpError(METHOD_NOT_FOUND);
  
  const params = validateParams(op.params, req.params.arguments);
  
  if (op.mutating && ctx.dryRun) {
    return { content: [{ type: 'text', text: '[dry-run] would execute: ' + op.name }] };
  }
  
  const result = await op.handler(ctx, params);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});
```

## Connector 生成逻辑

```typescript
// connector/connector.ts
import { operations } from '../core/operations';

// 只注册 vault.* namespace
const vaultOps = operations.filter(op => op.namespace === 'vault');

// 双 transport: WS 优先, FS 降级
const backend = await createVaultBackend();  // 读 ~/.obsidian-ws-port → WS / FS

const ctx: OperationContext = {
  vault: backend,
  adapters: null,  // connector 不需要 adapter registry
  config: loadConfig(),
  logger: stderrLogger,
  dryRun: false,
};

// 注册 tools（同 server.ts 的逻辑，但只用 vaultOps）
```

## 验证计划

1. 现有 343 tests 全部迁移到新 server.ts 跑通
2. 手动测试 connector: Obsidian 开着 → WS transport → vault.read/search
3. 手动测试 connector: Obsidian 关着 → FS fallback → vault.read/search
4. 确认 `.mcp.json` 指向新 connector → Claude Code 能调通

## 风险

| 风险 | 缓解 |
|------|------|
| 343 tests 依赖旧 handler 签名 | 先跑一遍确认 test 调用的是什么接口 |
| connector.js 的 FsTransport 有大量边界处理 | 不重写逻辑，只搬家到 fs-transport.ts |
| WsTransport 的 JSON-RPC 复用 | 直接搬，不改协议 |
| 根目录 connector.js 被多处引用 | grep 确认所有引用点 |
