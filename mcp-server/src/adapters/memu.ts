/**
 * adapter-memu -- bridges to memU's Python retrieve API via subprocess.
 *
 * Reuses memU's full retrieval pipeline (graph PPR + vector cosine + text)
 * rather than reimplementing PG queries in Node.js.
 *
 * Requires: memU installed (`pip install -e .` in memU repo), PG running.
 * Gracefully returns [] if memU is unavailable.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  VaultMindAdapter,
  AdapterCapability,
  SearchResult,
  SearchOpts,
} from "./interface.js";

const exec = promisify(execFile);

export interface MemUAdapterConfig {
  /** Python executable (default: "python") */
  python?: string;
  /** memU user_id (default: "boris") */
  userId?: string;
  /** Maximum results per query (default: 20) */
  maxResults?: number;
  /** Timeout in ms (default: 10000) */
  timeout?: number;
}

export class MemUAdapter implements VaultMindAdapter {
  readonly name = "memu";
  readonly capabilities: readonly AdapterCapability[] = ["search"];

  private readonly python: string;
  private readonly userId: string;
  private readonly defaultMax: number;
  private readonly timeout: number;
  private available = false;

  get isAvailable(): boolean { return this.available; }

  constructor(config?: MemUAdapterConfig) {
    this.python = config?.python ?? "python";
    this.userId = config?.userId ?? "boris";
    this.defaultMax = config?.maxResults ?? 20;
    this.timeout = config?.timeout ?? 10_000;
  }

  async init(): Promise<void> {
    try {
      await exec(this.python, ["-c", "import memu"], { timeout: 5000 });
      this.available = true;
    } catch {
      process.stderr.write("vault-mind: [warn] memU not importable, adapter disabled\n");
    }
  }

  async dispose(): Promise<void> {}

  async search(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    if (!this.available) return [];
    const limit = opts?.maxResults ?? this.defaultMax;

    // Query passed via sys.argv to avoid injection
    const script = `
import json, sys
try:
    from memu.app.retrieve import retrieve
    query = sys.argv[1]
    user_id = sys.argv[2]
    top_k = int(sys.argv[3])
    results = retrieve(query=query, user_id=user_id, top_k=top_k)
    items = []
    for r in results:
        items.append({
            "path": r.get("key", r.get("id", "unknown")),
            "content": r.get("content", r.get("text", ""))[:500],
            "score": float(r.get("score", r.get("relevance", 0.5))),
            "metadata": {"category": r.get("category", ""), "item_id": r.get("id", "")}
        })
    print(json.dumps(items))
except Exception as e:
    print(json.dumps([]), file=sys.stdout)
    print(f"memU error: {e}", file=sys.stderr)
`;

    try {
      const { stdout } = await exec(
        this.python,
        ["-c", script, query, this.userId, String(limit)],
        { timeout: this.timeout, maxBuffer: 5 * 1024 * 1024 },
      );

      const items: Array<{
        path: string;
        content: string;
        score: number;
        metadata?: Record<string, unknown>;
      }> = JSON.parse(stdout.trim() || "[]");

      return items.map((item) => ({
        source: this.name,
        path: item.path,
        content: item.content,
        score: item.score,
        metadata: item.metadata,
      }));
    } catch {
      return [];
    }
  }
}
