/**
 * VaultMindAdapter -- the plugin interface.
 *
 * Each adapter provides access to one knowledge source.
 * Implement only the capabilities you support.
 * Missing capabilities are silently skipped by the unified query layer.
 */

export type AdapterCapability =
  | "search"
  | "read"
  | "write"
  | "graph"
  | "events"
  | "embeddings";

export interface SearchResult {
  /** Source adapter name */
  source: string;
  /** Path or identifier within the adapter */
  path: string;
  /** Matched content snippet */
  content: string;
  /** Relevance score 0-1 (adapter-specific) */
  score: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export interface SearchOpts {
  /** Glob pattern to filter paths */
  glob?: string;
  /** Max results per adapter */
  maxResults?: number;
  /** Lines of context around match */
  context?: number;
  /** Case sensitive search */
  caseSensitive?: boolean;
}

export interface GraphNode {
  path: string;
  title?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: "link" | "backlink" | "tag";
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface FileEvent {
  type: "create" | "modify" | "delete" | "rename";
  path: string;
  oldPath?: string;
  timestamp: number;
}

export interface Disposable {
  dispose(): void;
}

export interface VaultMindAdapter {
  /** Unique adapter name (e.g. "filesystem", "obsidian", "memu") */
  readonly name: string;

  /** Declared capabilities -- unified query checks these before calling methods */
  readonly capabilities: readonly AdapterCapability[];

  // --- Core (implement what you can) ---

  search?(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  read?(path: string): Promise<string>;
  write?(path: string, content: string, dryRun?: boolean): Promise<void>;

  // --- Graph ---

  graph?(): Promise<GraphData>;

  // --- Events ---

  onFileChange?(callback: (event: FileEvent) => void): Disposable;

  // --- Lifecycle ---

  init(): Promise<void>;
  dispose(): Promise<void>;
}
