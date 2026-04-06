/**
 * adapter-gitnexus -- bridges to GitNexus knowledge graph via subprocess.
 *
 * GitNexus runs as a separate MCP server with Neo4j/graph backend.
 * This adapter calls `gitnexus query` CLI for code-level search results
 * and maps them into the unified SearchResult format.
 *
 * Gracefully returns [] if gitnexus CLI is unavailable.
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

export interface GitNexusAdapterConfig {
  /** Path to gitnexus CLI binary (default: "gitnexus") */
  binary?: string;
  /** Repository filter -- only search these repos */
  repos?: string[];
  /** Timeout in ms (default: 15000) */
  timeout?: number;
}

export class GitNexusAdapter implements VaultMindAdapter {
  readonly name = "gitnexus";
  readonly capabilities: readonly AdapterCapability[] = ["search"];

  private readonly binary: string;
  private readonly repos: string[];
  private readonly timeout: number;
  private available = false;

  get isAvailable(): boolean { return this.available; }

  constructor(config?: GitNexusAdapterConfig) {
    this.binary = config?.binary ?? "gitnexus";
    this.repos = config?.repos ?? [];
    this.timeout = config?.timeout ?? 15_000;
  }

  async init(): Promise<void> {
    try {
      await exec(this.binary, ["--version"], { timeout: 5000 });
      this.available = true;
    } catch {
      process.stderr.write("vault-mind: [warn] gitnexus CLI not found, adapter disabled\n");
    }
  }

  async dispose(): Promise<void> {}

  async search(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    if (!this.available) return [];
    const limit = opts?.maxResults ?? 20;
    const args = ["query", "--json", "--limit", String(limit), "--", query];

    if (this.repos.length > 0) {
      for (const repo of this.repos) {
        args.push("--repo", repo);
      }
    }

    try {
      const { stdout } = await exec(this.binary, args, {
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024,
      });

      const parsed = JSON.parse(stdout.trim() || "[]");
      const items: Array<{ file?: string; path?: string; snippet?: string; score?: number }> =
        Array.isArray(parsed) ? parsed : parsed.results ?? [];

      return items.map((item) => ({
        source: this.name,
        path: item.file ?? item.path ?? "unknown",
        content: (item.snippet ?? "").slice(0, 500),
        score: item.score ?? 0.7,
      }));
    } catch {
      return [];
    }
  }
}
