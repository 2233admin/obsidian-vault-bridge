import { App, TFile, TFolder } from "obsidian";
import type { SearchOptions, SearchResult, SearchMatch } from "./types";

function rejectDangerousRegex(pattern: string): void {
  if (/(\([^)]*[+*}]\s*\))[+*{]/.test(pattern))
    throw new Error("regex rejected: nested quantifiers (ReDoS risk)");
  if (/\([^)]*\|[^)]*\)[+*{]/.test(pattern) && /(\w)\|.*\1/.test(pattern))
    throw new Error("regex rejected: overlapping alternation (ReDoS risk)");
}

export class VaultBridge {
  constructor(private app: App) {}

  getVaultName(): string {
    return this.app.vault.getName();
  }

  getVaultPath(): string {
    return (this.app.vault.adapter as any).basePath;
  }

  async read(path: string): Promise<string> {
    return this.app.vault.read(this.resolveFile(path));
  }

  stat(path: string): Record<string, unknown> {
    const af = this.app.vault.getAbstractFileByPath(path);
    if (!af) throw new Error(`Not found: ${path}`);
    if (af instanceof TFile) {
      return {
        type: "file",
        path: af.path,
        name: af.name,
        ext: af.extension,
        size: af.stat.size,
        ctime: af.stat.ctime,
        mtime: af.stat.mtime,
      };
    }
    const folder = af as TFolder;
    return {
      type: "folder",
      path: folder.path,
      name: folder.name,
      children: folder.children.length,
    };
  }

  list(folderPath: string): { files: string[]; folders: string[] } {
    const folder = this.resolveFolder(folderPath);
    const files: string[] = [];
    const folders: string[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile) files.push(child.path);
      else if (child instanceof TFolder) folders.push(child.path);
    }
    files.sort();
    folders.sort();
    return { files, folders };
  }

  exists(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(path) !== null;
  }

  async create(path: string, content: string): Promise<string> {
    const file = await this.app.vault.create(path, content);
    return file.path;
  }

  async modify(path: string, content: string): Promise<void> {
    await this.app.vault.process(this.resolveFile(path), () => content);
  }

  async append(path: string, content: string): Promise<void> {
    await this.app.vault.process(this.resolveFile(path), (existing) => existing + content);
  }

  async remove(path: string, force: boolean): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(path);
    if (!af) throw new Error(`Not found: ${path}`);
    if (force) {
      await this.app.vault.delete(af, true);
    } else {
      await this.app.vault.trash(af, false);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(oldPath);
    if (!af) throw new Error(`Not found: ${oldPath}`);
    await this.app.fileManager.renameFile(af, newPath);
  }

  async mkdir(path: string): Promise<void> {
    await this.app.vault.createFolder(path);
  }

  // -- Phase 3: Search, Graph, Metadata --------------------------------

  async search(query: string, opts: SearchOptions = {}): Promise<{ results: SearchResult[]; totalMatches: number }> {
    const max = opts.maxResults ?? 50;
    const ctx = opts.context ?? 1;
    const flags = opts.caseSensitive ? "g" : "gi";

    if (query.length > 500) throw new Error("Query too long (max 500 chars)");

    let pattern: RegExp;
    try {
      if (opts.regex) {
        rejectDangerousRegex(query);
        pattern = new RegExp(query, flags);
      } else {
        pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      }
    } catch (e) {
      throw new Error(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }

    const files = this.app.vault.getMarkdownFiles();
    const results: SearchResult[] = [];
    let totalMatches = 0;

    for (const file of files) {
      if (opts.glob && !this.matchGlob(file.path, opts.glob)) continue;
      if (totalMatches >= max) break;

      const content = await this.app.vault.cachedRead(file);
      const lines = content.split("\n");
      const matches: SearchMatch[] = [];

      for (let i = 0; i < lines.length; i++) {
        pattern.lastIndex = 0;
        if (pattern.test(lines[i])) {
          const before: string[] = [];
          const after: string[] = [];
          for (let j = Math.max(0, i - ctx); j < i; j++) before.push(lines[j]);
          for (let j = i + 1; j <= Math.min(lines.length - 1, i + ctx); j++) after.push(lines[j]);
          matches.push({
            line: i + 1,
            text: lines[i],
            contextBefore: before.length > 0 ? before : undefined,
            contextAfter: after.length > 0 ? after : undefined,
          });
          totalMatches++;
          if (totalMatches >= max) break;
        }
      }

      if (matches.length > 0) {
        results.push({ path: file.path, matches });
      }
    }

    return { results, totalMatches };
  }

  getMetadata(path: string): Record<string, unknown> | null {
    const cache = this.app.metadataCache.getCache(path);
    if (!cache) return null;
    const out: Record<string, unknown> = {};
    if (cache.links)
      out.links = cache.links.map((l) => ({
        link: l.link,
        displayText: l.displayText,
        position: { line: l.position.start.line },
      }));
    if (cache.embeds)
      out.embeds = cache.embeds.map((e) => ({
        link: e.link,
        position: { line: e.position.start.line },
      }));
    if (cache.tags)
      out.tags = cache.tags.map((t) => ({
        tag: t.tag,
        position: { line: t.position.start.line },
      }));
    if (cache.headings)
      out.headings = cache.headings.map((h) => ({
        heading: h.heading,
        level: h.level,
        position: { line: h.position.start.line },
      }));
    if (cache.frontmatter) out.frontmatter = cache.frontmatter;
    if (cache.sections)
      out.sections = cache.sections.map((s) => ({
        type: s.type,
        position: { start: { line: s.position.start.line }, end: { line: s.position.end.line } },
      }));
    return out;
  }

  searchByTag(tag: string): string[] {
    const bare = tag.startsWith("#") ? tag.slice(1) : tag;
    const hashTag = `#${bare}`;
    const results: string[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) continue;
      // inline tags (#tag in body)
      if (cache.tags?.some((t) => t.tag === hashTag)) {
        results.push(file.path);
        continue;
      }
      // frontmatter tags (tags: [x, y] in YAML)
      const fmTags = cache.frontmatter?.tags ?? cache.frontmatter?.tag;
      if (Array.isArray(fmTags) && fmTags.includes(bare)) {
        results.push(file.path);
      } else if (typeof fmTags === "string" && fmTags === bare) {
        results.push(file.path);
      }
    }
    return results.sort();
  }

  searchByFrontmatter(key: string, value?: unknown): Array<{ path: string; value: unknown }> {
    const results: Array<{ path: string; value: unknown }> = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (fm && key in fm) {
        if (value === undefined || fm[key] === value) {
          results.push({ path: file.path, value: fm[key] });
        }
      }
    }
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  getGraph(type: string = "both"): {
    nodes: Array<{ path: string; exists: boolean }>;
    edges: Array<{ from: string; to: string; count: number }>;
    orphans: string[];
  } {
    const nodeSet = new Set<string>();
    const edges: Array<{ from: string; to: string; count: number }> = [];
    const inbound = new Set<string>();

    const resolved = this.app.metadataCache.resolvedLinks;
    const unresolved = this.app.metadataCache.unresolvedLinks;

    if (type === "resolved" || type === "both") {
      for (const [from, targets] of Object.entries(resolved)) {
        nodeSet.add(from);
        for (const [to, count] of Object.entries(targets)) {
          nodeSet.add(to);
          edges.push({ from, to, count });
          inbound.add(to);
        }
      }
    }

    if (type === "unresolved" || type === "both") {
      for (const [from, targets] of Object.entries(unresolved)) {
        nodeSet.add(from);
        for (const [to, count] of Object.entries(targets)) {
          nodeSet.add(to);
          edges.push({ from, to, count });
        }
      }
    }

    for (const file of this.app.vault.getMarkdownFiles()) {
      nodeSet.add(file.path);
    }

    const nodes = Array.from(nodeSet)
      .sort()
      .map((p) => ({ path: p, exists: this.app.vault.getAbstractFileByPath(p) !== null }));

    // Orphans only meaningful when resolved links are considered
    const orphans =
      type === "resolved" || type === "both"
        ? this.app.vault
            .getMarkdownFiles()
            .filter((f) => !inbound.has(f.path))
            .map((f) => f.path)
            .sort()
        : [];

    return { nodes, edges, orphans };
  }

  getBacklinks(path: string): Array<{ from: string; count: number }> {
    const results: Array<{ from: string; count: number }> = [];
    const resolved = this.app.metadataCache.resolvedLinks;
    for (const [from, targets] of Object.entries(resolved)) {
      if (path in targets) {
        results.push({ from, count: targets[path] });
      }
    }
    return results.sort((a, b) => a.from.localeCompare(b.from));
  }

  // -- Phase 5: lint & advanced query -----------------------------------

  lint(requiredFrontmatter: string[] = []): Record<string, unknown> {
    const files = this.app.vault.getMarkdownFiles();
    const resolved = this.app.metadataCache.resolvedLinks;
    const unresolved = this.app.metadataCache.unresolvedLinks;

    const inbound = new Set<string>();
    for (const targets of Object.values(resolved)) {
      for (const to of Object.keys(targets)) inbound.add(to);
    }
    const orphans = files.filter((f) => !inbound.has(f.path)).map((f) => f.path).sort();

    const brokenLinks: Array<{ from: string; to: string }> = [];
    for (const [from, targets] of Object.entries(unresolved)) {
      for (const to of Object.keys(targets)) brokenLinks.push({ from, to });
    }

    const emptyFiles = files.filter((f) => f.stat.size === 0).map((f) => f.path).sort();

    const missingFm: Array<{ path: string; missing: string[] }> = [];
    if (requiredFrontmatter.length > 0) {
      for (const file of files) {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
        const missing = requiredFrontmatter.filter((k) => !(k in fm));
        if (missing.length > 0) missingFm.push({ path: file.path, missing });
      }
    }

    const titleMap = new Map<string, string[]>();
    for (const file of files) {
      const t = file.basename.toLowerCase();
      const arr = titleMap.get(t) ?? [];
      arr.push(file.path);
      titleMap.set(t, arr);
    }
    const duplicates = Array.from(titleMap.entries())
      .filter(([, paths]) => paths.length > 1)
      .map(([title, paths]) => ({ title, files: paths.sort() }));

    let totalLinks = 0;
    for (const targets of Object.values(resolved)) {
      totalLinks += Object.values(targets).reduce((a, b) => a + b, 0);
    }

    return {
      orphans,
      brokenLinks,
      emptyFiles,
      missingFrontmatter: missingFm,
      duplicateTitles: duplicates,
      stats: {
        totalFiles: files.length,
        totalLinks,
        totalOrphans: orphans.length,
        totalBroken: brokenLinks.length,
        totalEmpty: emptyFiles.length,
        totalDuplicates: duplicates.length,
      },
    };
  }

  searchByFrontmatterAdvanced(
    key: string,
    value?: unknown,
    op: string = "eq",
  ): Array<{ path: string; value: unknown }> {
    const results: Array<{ path: string; value: unknown }> = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;

      if (op === "exists") {
        if (key in fm) results.push({ path: file.path, value: fm[key] });
        continue;
      }

      if (!(key in fm)) continue;
      const v = fm[key];

      let match = false;
      switch (op) {
        case "eq": match = v === value; break;
        case "ne": match = v !== value; break;
        case "gt": match = typeof v === "number" && typeof value === "number" && v > value; break;
        case "lt": match = typeof v === "number" && typeof value === "number" && v < value; break;
        case "gte": match = typeof v === "number" && typeof value === "number" && v >= value; break;
        case "lte": match = typeof v === "number" && typeof value === "number" && v <= value; break;
        case "contains": match = typeof v === "string" && typeof value === "string" && v.includes(value); break;
        case "regex":
          try {
            if (typeof value === "string") rejectDangerousRegex(value);
            match = typeof v === "string" && typeof value === "string" && new RegExp(value).test(v);
          }
          catch { match = false; }
          break;
        default: match = v === value;
      }
      if (match) results.push({ path: file.path, value: v });
    }
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  // -- private helpers --------------------------------------------------

  private resolveFile(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f || !(f instanceof TFile)) throw new Error(`File not found: ${path}`);
    return f;
  }

  private resolveFolder(path: string): TFolder {
    if (!path || path === "/") return this.app.vault.getRoot();
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f || !(f instanceof TFolder)) throw new Error(`Folder not found: ${path}`);
    return f;
  }

  private matchGlob(path: string, glob: string): boolean {
    const re = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\0")
      .replace(/\*/g, "[^/]*")
      .replace(/\0/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${re}$`).test(path);
  }
}
