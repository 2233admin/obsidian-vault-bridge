/**
 * VaultBrainAdapter -- semantic storage adapter backed by PGLite (pgvector + pg_trgm).
 * Hybrid search via RRF fusion of keyword (pg_trgm similarity) and vector (cosine) results.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  VaultMindAdapter,
  AdapterCapability,
  SearchResult,
  SearchOpts,
} from "../interface.js";
import type { VaultBrainEngine, ChunkResult } from "./engine.js";
import { PGliteEngine } from "./pglite-engine.js";
import { chunkMarkdown, embedTexts } from "./ingest.js";

const RRF_K = 60;

export class VaultBrainAdapter implements VaultMindAdapter {
  readonly name = "vaultbrain";
  readonly capabilities: readonly AdapterCapability[] = ["search", "embeddings"];

  private engine: VaultBrainEngine | null = null;

  constructor(private readonly dataDir?: string) {}

  async init(): Promise<void> {
    const dir = this.dataDir ?? join(homedir(), ".vault-mind", "vaultbrain");
    try {
      const engine = new PGliteEngine(dir);
      await engine.connect();
      await engine.initSchema();
      this.engine = engine;
    } catch (err) {
      console.warn(`[vaultbrain] init failed, adapter disabled: ${(err as Error).message}`);
      this.engine = null;
    }
  }

  async dispose(): Promise<void> {
    if (this.engine) {
      try {
        await this.engine.disconnect();
      } catch {
        // non-fatal
      }
      this.engine = null;
    }
  }

  async search(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    if (!this.engine) return [];
    const limit = opts?.maxResults ?? 20;
    const perListLimit = Math.ceil(limit * 2);

    // Keyword search (always runs)
    let kwResults: ChunkResult[] = [];
    try {
      kwResults = await this.engine.searchKeyword(query, perListLimit);
    } catch {
      // non-fatal
    }

    // Vector search (only if API key present)
    let vecResults: ChunkResult[] = [];
    if (process.env.OPENAI_API_KEY) {
      try {
        const embeddings = await embedTexts([query]);
        if (embeddings.length > 0) {
          vecResults = await this.engine.searchVector(embeddings[0], perListLimit);
        }
      } catch {
        // non-fatal, fall back to keyword-only
      }
    }

    // RRF fusion
    const scoreMap = new Map<string, { result: ChunkResult; score: number }>();

    for (let rank = 0; rank < kwResults.length; rank++) {
      const r = kwResults[rank];
      const key = `${r.slug}::${r.chunkIndex}`;
      const rrfScore = 1 / (RRF_K + rank);
      const existing = scoreMap.get(key);
      if (existing) existing.score += rrfScore;
      else scoreMap.set(key, { result: r, score: rrfScore });
    }

    for (let rank = 0; rank < vecResults.length; rank++) {
      const r = vecResults[rank];
      const key = `${r.slug}::${r.chunkIndex}`;
      const rrfScore = 1 / (RRF_K + rank);
      const existing = scoreMap.get(key);
      if (existing) existing.score += rrfScore;
      else scoreMap.set(key, { result: r, score: rrfScore });
    }

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ result, score }) => ({
        source: this.name,
        path: result.slug,
        content: result.chunkText,
        score,
      }));
  }

  /**
   * Ingest a compiled file -- upsert page, re-chunk, re-embed, extract links/tags.
   * Called by compile-trigger in Phase 3 (not wired up yet).
   */
  async ingest(path: string, content: string): Promise<void> {
    if (!this.engine) return;

    const slug = pathToSlug(path);
    const title = extractTitle(content);
    const hash = simpleHash(content);

    await this.engine.upsertPage(slug, title, content, hash);

    await this.engine.deleteChunks(slug);
    const chunks = chunkMarkdown(content);
    const embeddings = await embedTexts(chunks);

    await this.engine.upsertChunks(
      slug,
      chunks.map((chunkText, i) => ({
        chunkIndex: i,
        chunkText,
        embedding: embeddings[i] ?? null,
        tokenCount: Math.ceil(chunkText.length / 4),
      })),
    );

    for (const toSlug of extractWikiLinks(content)) {
      await this.engine.upsertLink(slug, toSlug);
    }

    for (const tag of extractTags(content)) {
      await this.engine.upsertTag(slug, tag);
    }
  }
}

// --- Helpers ---

function pathToSlug(path: string): string {
  return path.replace(/\\/g, "/").replace(/\.md$/, "");
}

function extractTitle(content: string): string {
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  const lines = content.split("\n").filter((l) => l.trim());
  return lines[0]?.slice(0, 80) ?? "";
}

function simpleHash(content: string): string {
  // djb2 -- fast, good enough for change detection
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h) + content.charCodeAt(i);
    h = h & h; // force 32-bit
  }
  return (h >>> 0).toString(16);
}

function extractWikiLinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g);
  return [...matches].map((m) => m[1].trim().toLowerCase().replace(/\s+/g, "-"));
}

function extractTags(content: string): string[] {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return [];
  const inlineTags = frontmatter[1].match(/^tags:\s*\[([^\]]+)\]/m);
  const blockTags = frontmatter[1].match(/^tags:\s*\n((?:\s*-\s*.+\n?)+)/m);
  const tagSource = inlineTags?.[1] ?? blockTags?.[1];
  if (!tagSource) return [];
  return tagSource
    .split(/[\n,]/)
    .map((t) => t.replace(/^-\s*/, "").replace(/['"]/g, "").trim())
    .filter(Boolean);
}
