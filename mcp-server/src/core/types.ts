// vault-mind shared types

export interface VaultMindConfig {
  vault_path: string;
  auth_token?: string;
  adapters?: string[];
  /** Per-adapter score weight multipliers */
  adapter_weights?: Record<string, number>;
  config_path?: string;
}

export type ParamType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface ParamDef {
  type: ParamType;
  required?: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
}

export interface Operation {
  name: string;
  namespace: 'vault' | 'compile' | 'query' | 'agent' | 'recipe';
  description: string;
  params: Record<string, ParamDef>;
  handler: (ctx: OperationContext, params: Record<string, unknown>) => Promise<unknown>;
  mutating?: boolean;
}

export interface OperationContext {
  vault: VaultExecutor;
  adapters: unknown | null;   // AdapterRegistry -- not imported here to avoid circular dep
  config: VaultMindConfig;
  logger: Logger;
  dryRun: boolean;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface SearchMatch {
  line: number;
  text: string;
}

export interface SearchResult {
  path: string;
  matches: SearchMatch[];
}

export interface FileStat {
  type: 'file' | 'folder';
  path: string;
  name: string;
  ext?: string;
  size?: number;
  ctime?: number;
  mtime?: number;
  children?: number;
}

export interface GraphNode {
  path: string;
  exists: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  count: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  orphans: string[];
}

export interface BacklinkResult {
  from: string;
  count: number;
}

export interface SearchOpts {
  maxResults?: number;
  caseSensitive?: boolean;
  regex?: boolean;
  glob?: string;
}

// VaultBackend -- the abstraction both WsTransport and FsTransport implement
export interface VaultBackend {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  search(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  list(dir: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<FileStat | null>;
  exists(path: string): Promise<boolean>;
  graph(): Promise<GraphData>;
  backlinks(path: string): Promise<BacklinkResult[]>;
  // Generic dispatch for vault.* methods not covered by typed methods above
  execute(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Narrow interface for OperationContext.vault — only execute() is required by operation handlers. */
export interface VaultExecutor {
  execute(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export function makeErr(code: number, message: string): { code: number; message: string } {
  return { code, message };
}
