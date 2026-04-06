/**
 * Unified query -- parallel search across all adapters, weighted fusion merge.
 *
 * Promise.allSettled ensures one adapter failure doesn't block the rest.
 * Results are scored, source-annotated, and merged by descending score.
 */

import type { AdapterRegistry } from "./adapters/registry.js";
import type { SearchResult, SearchOpts } from "./adapters/interface.js";

export interface UnifiedQueryOpts extends SearchOpts {
  /** Only query these adapter names (default: all search-capable) */
  adapters?: string[];
  /** Per-adapter score weight multiplier (default: 1.0) */
  weights?: Record<string, number>;
}

export interface AdapterStats {
  count: number;
  latencyMs: number;
  error?: string;
}

export interface UnifiedQueryResult {
  results: SearchResult[];
  sources: Record<string, AdapterStats>;
  totalResults: number;
}

export async function unifiedQuery(
  registry: AdapterRegistry,
  query: string,
  opts?: UnifiedQueryOpts,
): Promise<UnifiedQueryResult> {
  const searchAdapters = registry.getByCapability("search");
  const filtered = opts?.adapters
    ? searchAdapters.filter((a) => opts.adapters!.includes(a.name))
    : searchAdapters;

  if (filtered.length === 0) {
    return { results: [], sources: {}, totalResults: 0 };
  }

  const weights = opts?.weights ?? {};
  const sources: Record<string, AdapterStats> = {};

  // Per-adapter limit: request ~1.5x share so fusion has headroom to merge
  const totalMax = opts?.maxResults ?? 50;
  const perAdapterMax = Math.ceil((totalMax * 1.5) / filtered.length);

  const settled = await Promise.allSettled(
    filtered.map(async (adapter) => {
      const start = Date.now();
      try {
        const results = await adapter.search!(query, { ...opts, maxResults: perAdapterMax });
        sources[adapter.name] = { count: results.length, latencyMs: Date.now() - start };
        const w = weights[adapter.name] ?? 1.0;
        return results.map((r) => ({ ...r, score: r.score * w, source: adapter.name }));
      } catch (e) {
        sources[adapter.name] = {
          count: 0,
          latencyMs: Date.now() - start,
          error: (e as Error).message,
        };
        return [] as SearchResult[];
      }
    }),
  );

  const merged: SearchResult[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") merged.push(...r.value);
  }

  // Descending score
  merged.sort((a, b) => b.score - a.score);

  const maxResults = opts?.maxResults ?? 50;
  return {
    results: merged.slice(0, maxResults),
    sources,
    totalResults: merged.length,
  };
}
