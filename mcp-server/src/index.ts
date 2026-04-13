#!/usr/bin/env node
/**
 * vault-mind MCP server -- stdio transport
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import {
  readFileSync, existsSync, readdirSync, statSync,
  writeFileSync, appendFileSync, rmSync, renameSync, mkdirSync,
} from "node:fs";
import { resolve, join, basename, extname, relative, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FilesystemAdapter } from "./adapters/filesystem.js";
import { MemUAdapter } from "./adapters/memu.js";
import { GitNexusAdapter } from "./adapters/gitnexus.js";
import { ObsidianAdapter } from "./adapters/obsidian.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { unifiedQuery } from "./unified-query.js";
import { CompileTrigger } from "./compile-trigger.js";
import type { VaultMindAdapter } from "./adapters/interface.js";
import { operations } from "./core/operations.js";
import type { OperationContext, Logger, VaultExecutor, VaultMindConfig } from "./core/types.js";
import { validateParams, rejectDangerousRegex } from "./core/validate.js";

const exec = promisify(execFile);

// Config

function loadConfig(): VaultMindConfig {
  const candidates = [
    resolve(process.cwd(), "vault-mind.yaml"),
    resolve(process.cwd(), "../vault-mind.yaml"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { ...parseSimpleYaml(readFileSync(p, "utf-8")), config_path: p };
  }
  const vaultPath = process.env.VAULT_MIND_VAULT_PATH || process.env.VAULT_BRIDGE_VAULT || "";
  if (!vaultPath) throw new Error("No vault-mind.yaml found and VAULT_MIND_VAULT_PATH not set");
  const envWeights = process.env.VAULT_MIND_ADAPTER_WEIGHTS;
  return {
    vault_path: vaultPath,
    auth_token: process.env.VAULT_MIND_AUTH_TOKEN,
    adapter_weights: envWeights ? (JSON.parse(envWeights) as Record<string, number>) : undefined,
    config_path: undefined,
  };
}

function parseSimpleYaml(raw: string): VaultMindConfig {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    result[key] = val;
  }
  const adapterWeights: Record<string, number> = {};
  for (const [k, v] of Object.entries(result)) {
    if (k.startsWith("adapter_weight_")) {
      const n = Number(v);
      if (!isNaN(n)) adapterWeights[k.slice("adapter_weight_".length)] = n;
    }
  }
  return {
    vault_path: result["vault_path"] || "",
    auth_token: result["auth_token"],
    adapters: result["adapters"]?.split(",").map((s) => s.trim()),
    adapter_weights: Object.keys(adapterWeights).length > 0 ? adapterWeights : undefined,
  };
}

// Helpers

const PROTECTED_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);
const VERSION = "0.3.0";

function err(code: number, message: string): { code: number; message: string } {
  return { code, message };
}

function parseYamlValue(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    return s.slice(1, -1);
  return s;
}

// VaultFs -- filesystem operations

class VaultFs {
  private readonly vault: string;
  constructor(vaultPath: string) { this.vault = resolve(vaultPath); }

  resolve(p: string): string {
    if (typeof p !== "string" || !p.trim()) throw err(-32602, "path required");
    const normalized = p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");
    if (normalized.split("/").some((s) => s === ".." || s === "."))
      throw err(-32602, "path traversal blocked");
    const topSegment = normalized.split("/")[0];
    if (PROTECTED_DIRS.has(topSegment)) throw err(-32602, `protected path: ${topSegment}`);
    const full = resolve(this.vault, normalized);
    if (!full.startsWith(this.vault)) throw err(-32602, "path escapes vault");
    return full;
  }

  parseFrontmatter(content: string): Record<string, unknown> | null {
    if (!content.startsWith("---")) return null;
    const end = content.indexOf("\n---", 3);
    if (end === -1) return null;
    const block = content.slice(4, end);
    const fm: Record<string, unknown> = {};
    let currentKey: string | null = null;
    let inArray = false;
    let arrayItems: unknown[] = [];
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (inArray && trimmed.startsWith("- ")) {
        arrayItems.push(parseYamlValue(trimmed.slice(2).trim()));
        continue;
      }
      if (inArray && currentKey) {
        fm[currentKey] = arrayItems;
        inArray = false;
        arrayItems = [];
      }
      const colon = trimmed.indexOf(":");
      if (colon === -1) continue;
      const key = trimmed.slice(0, colon).trim();
      const rawVal = trimmed.slice(colon + 1).trim();
      currentKey = key;
      if (rawVal === "") { inArray = true; arrayItems = []; continue; }
      if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
        fm[key] = rawVal.slice(1, -1).split(",").map((s) => parseYamlValue(s.trim()));
      } else {
        fm[key] = parseYamlValue(rawVal);
      }
    }
    if (inArray && currentKey) fm[currentKey] = arrayItems;
    return fm;
  }

  parseWikilinks(content: string): Array<{ link: string; displayText: string }> {
    const links: Array<{ link: string; displayText: string }> = [];
    const re = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      links.push({ link: m[1], displayText: m[2] || m[1] });
    }
    return links;
  }

  parseTags(content: string): string[] {
    const cleaned = content.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
    const tags: string[] = [];
    const re = /(?:^|\s)#([a-zA-Z_一-鿿][\w/一-鿿-]*)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) { tags.push("#" + m[1]); }
    return [...new Set(tags)];
  }

  parseHeadings(content: string): Array<{ heading: string; level: number; position: { line: number } }> {
    const headings: Array<{ heading: string; level: number; position: { line: number } }> = [];
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const hm = lines[i].match(/^(#{1,6})\s+(.+)/);
      if (hm) headings.push({ heading: hm[2].trim(), level: hm[1].length, position: { line: i } });
    }
    return headings;
  }

  walkMd(fn: (relPath: string, content: string) => void): void {
    const walk = (d: string): void => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, ent.name);
        if (ent.isDirectory() && !PROTECTED_DIRS.has(ent.name)) walk(full);
        else if (ent.isFile() && ent.name.endsWith(".md")) {
          const rel = relative(this.vault, full).replace(/\\/g, "/");
          fn(rel, readFileSync(full, "utf-8"));
        }
      }
    };
    walk(this.vault);
  }

  matchGlob(p: string, glob: string): boolean {
    const re = new RegExp(
      "^" + glob.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".") + "$",
    );
    return re.test(p);
  }

  dispatch(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case "vault.read": {
        const full = this.resolve(p.path as string);
        if (!existsSync(full)) throw err(-32001, `Not found: ${p.path}`);
        return { content: readFileSync(full, "utf-8") };
      }
      case "vault.exists":
        return { exists: existsSync(this.resolve(p.path as string)) };
      case "vault.list": {
        const dir = this.resolve((p.path as string) || "");
        if (!existsSync(dir)) throw err(-32001, `Not found: ${p.path}`);
        const hidden = new Set([".obsidian", ".trash", "node_modules"]);
        const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !hidden.has(e.name));
        return {
          files: entries.filter((e) => e.isFile()).map((e) => posix.join((p.path as string) || "", e.name)).sort(),
          folders: entries.filter((e) => e.isDirectory()).map((e) => posix.join((p.path as string) || "", e.name)).sort(),
        };
      }
      case "vault.stat": {
        const full = this.resolve(p.path as string);
        if (!existsSync(full)) throw err(-32001, `Not found: ${p.path}`);
        const st = statSync(full);
        if (st.isDirectory())
          return { type: "folder", path: p.path, name: basename(p.path as string), children: readdirSync(full).length };
        return {
          type: "file", path: p.path, name: basename(p.path as string),
          ext: extname(p.path as string).slice(1), size: st.size, ctime: st.ctimeMs, mtime: st.mtimeMs,
        };
      }
      case "vault.create": {
        const full = this.resolve(p.path as string);
        if (existsSync(full)) throw err(-32002, `Already exists: ${p.path}`);
        if (p.dryRun !== false) return { dryRun: true, action: "create", path: p.path };
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, (p.content as string) || "", "utf-8");
        return { ok: true, path: p.path };
      }
      case "vault.modify": {
        const full = this.resolve(p.path as string);
        if (!existsSync(full)) throw err(-32001, `Not found: ${p.path}`);
        if (p.dryRun !== false) return { dryRun: true, action: "modify", path: p.path };
        writeFileSync(full, p.content as string, "utf-8");
        return { ok: true, path: p.path };
      }
      case "vault.append": {
        const full = this.resolve(p.path as string);
        if (!existsSync(full)) throw err(-32001, `Not found: ${p.path}`);
        if (p.dryRun !== false) return { dryRun: true, action: "append", path: p.path };
        appendFileSync(full, p.content as string, "utf-8");
        return { ok: true, path: p.path };
      }
      case "vault.delete": {
        const full = this.resolve(p.path as string);
        if (!existsSync(full)) throw err(-32001, `Not found: ${p.path}`);
        if (p.dryRun !== false) return { dryRun: true, action: "delete", path: p.path };
        rmSync(full, { recursive: true });
        return { ok: true, path: p.path };
      }
      case "vault.rename": {
        const from = this.resolve(p.from as string);
        const to = this.resolve(p.to as string);
        if (!existsSync(from)) throw err(-32001, `Not found: ${p.from}`);
        if (existsSync(to)) throw err(-32002, `Already exists: ${p.to}`);
        if (p.dryRun !== false) return { dryRun: true, action: "rename", from: p.from, to: p.to };
        mkdirSync(dirname(to), { recursive: true });
        renameSync(from, to);
        return { ok: true, from: p.from, to: p.to };
      }
      case "vault.search": {
        if (typeof p.query !== "string" || (p.query as string).length > 500)
          throw err(-32602, "query must be a string under 500 chars");
        const results: Array<{ path: string; matches: Array<{ line: number; text: string }> }> = [];
        const max = (p.maxResults as number) || 50;
        let total = 0;
        const flags = p.caseSensitive ? "g" : "gi";
        if (p.regex) rejectDangerousRegex(p.query as string);
        const escaped = p.regex
          ? (p.query as string)
          : (p.query as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(escaped, flags);
        this.walkMd((relPath, content) => {
          if (total >= max) return;
          if (p.glob && !this.matchGlob(relPath, p.glob as string)) return;
          const lines = content.split("\n");
          const matches: Array<{ line: number; text: string }> = [];
          for (let i = 0; i < lines.length && total < max; i++) {
            pattern.lastIndex = 0;
            if (pattern.test(lines[i])) {
              matches.push({ line: i + 1, text: lines[i] });
              total++;
            }
          }
          if (matches.length) results.push({ path: relPath, matches });
        });
        return { results, totalMatches: total };
      }
      case "vault.searchByTag": {
        if (!p.tag) throw err(-32602, "tag required");
        const bare = (p.tag as string).startsWith("#") ? (p.tag as string).slice(1) : (p.tag as string);
        const hashTag = "#" + bare;
        const files: string[] = [];
        this.walkMd((relPath, content) => {
          const tags = this.parseTags(content);
          if (tags.includes(hashTag)) { files.push(relPath); return; }
          const fm = this.parseFrontmatter(content);
          const fmTags = (fm as Record<string, unknown> | null)?.tags ?? (fm as Record<string, unknown> | null)?.tag;
          if (Array.isArray(fmTags) && fmTags.includes(bare)) files.push(relPath);
          else if (typeof fmTags === "string" && fmTags === bare) files.push(relPath);
        });
        return { files: files.sort() };
      }
      case "vault.searchByFrontmatter": {
        if (!p.key) throw err(-32602, "key required");
        const op = (p.op as string) || "eq";
        const validOps = ["eq", "ne", "gt", "lt", "gte", "lte", "contains", "regex", "exists"];
        if (!validOps.includes(op)) throw err(-32602, `Unknown op: ${op}`);
        const results: Array<{ path: string; value: unknown }> = [];
        this.walkMd((relPath, content) => {
          const fm = this.parseFrontmatter(content);
          if (!fm) return;
          if (op === "exists") {
            if ((p.key as string) in fm) results.push({ path: relPath, value: fm[p.key as string] });
            return;
          }
          if (!((p.key as string) in fm)) return;
          const v = fm[p.key as string];
          let match = false;
          switch (op) {
            case "eq": match = v === p.value; break;
            case "ne": match = v !== p.value; break;
            case "gt": match = typeof v === "number" && typeof p.value === "number" && v > p.value; break;
            case "lt": match = typeof v === "number" && typeof p.value === "number" && v < p.value; break;
            case "gte": match = typeof v === "number" && typeof p.value === "number" && v >= p.value; break;
            case "lte": match = typeof v === "number" && typeof p.value === "number" && v <= p.value; break;
            case "contains": match = typeof v === "string" && typeof p.value === "string" && v.includes(p.value); break;
            case "regex":
              try {
                if (typeof p.value === "string") rejectDangerousRegex(p.value);
                match = typeof v === "string" && typeof p.value === "string" && new RegExp(p.value).test(v);
              }
              catch { match = false; }
              break;
          }
          if (match) results.push({ path: relPath, value: v });
        });
        return { files: results.sort((a, b) => a.path.localeCompare(b.path)) };
      }
      case "vault.graph": {
        const nodeSet = new Set<string>();
        const edgeMap = new Map<string, number>();
        const inbound = new Set<string>();
        this.walkMd((relPath, content) => {
          nodeSet.add(relPath);
          for (const l of this.parseWikilinks(content)) {
            if (l.link.startsWith("#")) continue;
            let target = l.link.split("#")[0];
            if (!target) continue;
            if (!target.includes("/")) {
              const withMd = target.endsWith(".md") ? target : target + ".md";
              try { if (existsSync(this.resolve(withMd))) target = withMd; } catch {}
            }
            if (!target.endsWith(".md")) target += ".md";
            nodeSet.add(target);
            inbound.add(target);
            const key = relPath + " " + target;
            edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
          }
        });
        const edges = Array.from(edgeMap.entries()).map(([key, count]) => {
          const [from, to] = key.split(" ");
          return { from, to, count };
        });
        const nodes = Array.from(nodeSet).sort().map((np) => ({
          path: np, exists: (() => { try { return existsSync(this.resolve(np)); } catch { return false; } })(),
        }));
        const orphans = nodes.filter((n) => n.exists && n.path.endsWith(".md") && !inbound.has(n.path)).map((n) => n.path);
        return { nodes, edges, orphans };
      }
      case "vault.backlinks": {
        if (!p.path) throw err(-32602, "path required");
        const target = (p.path as string).endsWith(".md") ? (p.path as string) : (p.path as string) + ".md";
        const targetBase = basename(target, ".md");
        const results: Array<{ from: string; count: number }> = [];
        this.walkMd((relPath, content) => {
          if (relPath === target) return;
          let count = 0;
          for (const l of this.parseWikilinks(content)) {
            const linkPath = l.link.split("#")[0];
            if (!linkPath) continue;
            if (linkPath === target || linkPath === targetBase || linkPath + ".md" === target) count++;
          }
          if (count > 0) results.push({ from: relPath, count });
        });
        return { backlinks: results.sort((a, b) => a.from.localeCompare(b.from)) };
      }
      case "vault.batch": {
        if (!Array.isArray(p.operations)) throw err(-32602, "operations must be an array");
        type BatchOp = { method: string; params?: Record<string, unknown> };
        const ops = p.operations as BatchOp[];
        const results: Array<{ index: number; ok: boolean; result?: unknown; error?: { code: number; message: string } }> = [];
        let succeeded = 0;
        let failed = 0;
        for (let i = 0; i < ops.length; i++) {
          const op = ops[i];
          if (!op.method?.startsWith("vault.")) throw err(-32602, `Batch only supports vault.* methods (index ${i})`);
          if (op.method === "vault.batch") throw err(-32602, "Recursive batch not allowed");
          try {
            const params = { ...(op.params || {}) };
            if (p.dryRun !== undefined) params.dryRun = p.dryRun;
            const result = this.dispatch(op.method, params);
            results.push({ index: i, ok: true, result });
            succeeded++;
          } catch (e: unknown) {
            const ex = e as { code?: number; message?: string };
            results.push({ index: i, ok: false, error: { code: ex.code || -32000, message: ex.message || String(e) } });
            failed++;
          }
        }
        return { results, summary: { total: ops.length, succeeded, failed } };
      }
      case "vault.lint": {
        const requiredFm = Array.isArray(p.requiredFrontmatter) ? (p.requiredFrontmatter as string[]) : [];
        const allFiles: Array<{ path: string; size: number; content: string }> = [];
        const linkMap = new Map<string, Map<string, number>>();
        const inbound = new Set<string>();
        this.walkMd((relPath, content) => {
          const st = statSync(this.resolve(relPath));
          allFiles.push({ path: relPath, size: st.size, content });
          const targets = new Map<string, number>();
          for (const l of this.parseWikilinks(content)) {
            const t = l.link.endsWith(".md") ? l.link : l.link + ".md";
            targets.set(t, (targets.get(t) || 0) + 1);
          }
          linkMap.set(relPath, targets);
          for (const t of targets.keys()) inbound.add(t);
        });
        const orphans = allFiles.filter((fi) => !inbound.has(fi.path)).map((fi) => fi.path).sort();
        const brokenLinks: Array<{ from: string; to: string }> = [];
        for (const [from, targets] of linkMap) {
          for (const [to] of targets) {
            try { if (!existsSync(this.resolve(to))) brokenLinks.push({ from, to }); } catch { brokenLinks.push({ from, to }); }
          }
        }
        const emptyFiles = allFiles.filter((fi) => fi.size === 0).map((fi) => fi.path).sort();
        const missingFm: Array<{ path: string; missing: string[] }> = [];
        if (requiredFm.length > 0) {
          for (const fi of allFiles) {
            const fm = this.parseFrontmatter(fi.content) || {};
            const missing = requiredFm.filter((k) => !(k in fm));
            if (missing.length > 0) missingFm.push({ path: fi.path, missing });
          }
        }
        const titleMap = new Map<string, string[]>();
        for (const fi of allFiles) {
          const t = basename(fi.path, ".md").toLowerCase();
          const arr = titleMap.get(t) || [];
          arr.push(fi.path);
          titleMap.set(t, arr);
        }
        const duplicates = Array.from(titleMap.entries())
          .filter(([, paths]) => paths.length > 1)
          .map(([title, files]) => ({ title, files: files.sort() }));
        let totalLinks = 0;
        for (const targets of linkMap.values()) for (const c of targets.values()) totalLinks += c;
        return {
          orphans, brokenLinks, emptyFiles, missingFrontmatter: missingFm, duplicateTitles: duplicates,
          stats: {
            totalFiles: allFiles.length, totalLinks, totalOrphans: orphans.length,
            totalBroken: brokenLinks.length, totalEmpty: emptyFiles.length, totalDuplicates: duplicates.length,
          },
        };
      }
      case "vault.mkdir": {
        const full = this.resolve(p.path as string);
        if (existsSync(full)) throw err(-32002, `Already exists: ${p.path}`);
        if (p.dryRun !== false) return { dryRun: true, action: "mkdir", path: p.path };
        mkdirSync(full, { recursive: true });
        return { ok: true, path: p.path };
      }
      case "vault.init": {
        if (!p.topic || typeof p.topic !== "string") throw err(-32602, "topic required");
        if ((p.topic as string).split("/").some((s: string) => s === ".." || s === "."))
          throw err(-32602, "path traversal blocked");
        const created: string[] = [];
        const skipped: string[] = [];
        const base = p.topic as string;
        const now = new Date().toISOString().slice(0, 10);
        const ensureDir = (rel: string) => {
          const full = this.resolve(rel);
          if (existsSync(full)) { skipped.push(rel); return; }
          mkdirSync(full, { recursive: true });
          created.push(rel);
        };
        const ensureFile = (rel: string, content: string) => {
          const r = rel.endsWith(".md") ? rel : rel + ".md";
          const full = this.resolve(r);
          if (existsSync(full)) { skipped.push(r); return; }
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, content, "utf-8");
          created.push(r);
        };
        ensureDir(base);
        for (const sub of ["raw", "raw/articles", "raw/papers", "raw/notes", "raw/transcripts", "wiki", "wiki/summaries", "wiki/concepts", "wiki/queries", "schema"])
          ensureDir(`${base}/${sub}`);
        ensureFile(`${base}/wiki/_index.md`, `---\ntopic: "${p.topic}"\nupdated: ${now}\n---\n\n# ${p.topic} -- Knowledge Index\n\nNo articles compiled yet.\n`);
        ensureFile(`${base}/wiki/_sources.md`, `---\ntopic: "${p.topic}"\nupdated: ${now}\n---\n\n# Sources\n\nNo sources compiled yet.\n`);
        ensureFile(`${base}/wiki/_categories.md`, `---\ntopic: "${p.topic}"\nupdated: ${now}\n---\n\n# Categories\n\nAuto-generated during compilation.\n`);
        ensureFile(`${base}/Log.md`, `# ${p.topic} -- Operation Log\n\n- ${now}: KB initialized\n`);
        ensureFile(`${base}/schema/CLAUDE.md`, `# ${p.topic} -- KB Schema\n\nFollows llm-wiki opinionated workflow.\nSee root CLAUDE.md for full documentation.\n`);
        const yamlPath = `${base}/kb.yaml`;
        if (existsSync(this.resolve(yamlPath))) {
          skipped.push(yamlPath);
        } else {
          writeFileSync(this.resolve(yamlPath), `topic: "${p.topic}"\nvault_path: "${this.vault.replace(/\\\\/g, "/")}"\ncreated: ${now}\n`, "utf-8");
          created.push(yamlPath);
        }
        return { ok: true, topic: p.topic, created, skipped, summary: `Created ${created.length}, skipped ${skipped.length}` };
      }
      case "vault.getMetadata": {
        const full = this.resolve(p.path as string);
        if (!existsSync(full)) throw err(-32001, `Not found: ${p.path}`);
        const content = readFileSync(full, "utf-8");
        const out: Record<string, unknown> = {};
        const links = this.parseWikilinks(content);
        if (links.length) out.links = links.map((l) => ({ link: l.link, displayText: l.displayText }));
        const tags = this.parseTags(content);
        if (tags.length) out.tags = tags.map((t) => ({ tag: t }));
        const headings = this.parseHeadings(content);
        if (headings.length) out.headings = headings;
        const fm = this.parseFrontmatter(content);
        if (fm) out.frontmatter = fm;
        return out;
      }
      case "vault.externalSearch":
        throw err(-32000, "No external search engine configured");
      default:
        throw err(-32601, `Unknown method: ${method}`);
    }
  }

  async execute(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.dispatch(method, params);
  }
}

// Stub namespaces

function stubResult(ns: string, method: string): unknown {
  return { status: "not_implemented", namespace: ns, method };
}

function makeCompileDispatch(trigger: CompileTrigger) {
  return async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case "compile.status":
        return trigger.status();
      case "compile.run":
        return trigger.run(params.topic as string | undefined);
      case "compile.diff":
        // diff is just the dirty list
        return { dirty: trigger.status().dirty };
      case "compile.abort":
        return trigger.abort();
      default:
        throw err(-32601, `Unknown method: ${method}`);
    }
  };
}

function makeQueryDispatch(registry: AdapterRegistry, defaultWeights?: Record<string, number>) {
  return async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case "query.unified": {
        const query = params.query as string;
        if (!query) throw err(-32602, "query required");
        // Merge: defaultWeights < caller-provided weights (caller wins per-key)
        const weights = {
          ...defaultWeights,
          ...(params.weights as Record<string, number> | undefined),
        };
        return unifiedQuery(registry, query, {
          maxResults: (params.maxResults as number) ?? 50,
          caseSensitive: (params.caseSensitive as boolean) ?? false,
          context: params.context as number | undefined,
          adapters: params.adapters as string[] | undefined,
          weights: Object.keys(weights).length > 0 ? weights : undefined,
        });
      }
      case "query.search": {
        // query.search is an alias for query.unified with filesystem-only
        const query = params.query as string;
        if (!query) throw err(-32602, "query required");
        return unifiedQuery(registry, query, {
          maxResults: (params.maxResults as number) ?? 50,
          adapters: ["filesystem"],
        });
      }
      case "query.explain": {
        // explain: search for concept, return top results with context
        const concept = params.concept as string;
        if (!concept) throw err(-32602, "concept required");
        const weights = { ...defaultWeights };
        return unifiedQuery(registry, concept, {
          maxResults: 10,
          context: 3,
          weights: Object.keys(weights).length > 0 ? weights : undefined,
        });
      }
      case "query.adapters": {
        return {
          adapters: registry.list().map((a) => ({
            name: a.name,
            capabilities: [...a.capabilities],
            isAvailable: a.isAvailable,
          })),
        };
      }
      default:
        throw err(-32601, `Unknown method: ${method}`);
    }
  };
}

function makeAgentDispatch(
  vaultPath: string,
  compilerPath: string,
  python: string,
  configPath?: string,
) {
  return async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const evaluatePy = resolve(compilerPath, "evaluate.py");
    const baseArgs = [evaluatePy];
    if (configPath) {
      baseArgs.push("--config", configPath);
    }
    baseArgs.push("--vault", vaultPath);

    switch (method) {
      case "agent.status": {
        const args = [...baseArgs, "--status"];
        const mode = params.mode as string | undefined;
        if (mode) args.push("--mode", mode);
        try {
          const { stdout } = await exec(python, args, {
            timeout: 30_000,
            maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env },
          });
          return JSON.parse(stdout);
        } catch (e) {
          throw err(-32000, `agent.status failed: ${(e as Error).message}`);
        }
      }

      case "agent.trigger": {
        const action = params.action as string | undefined;
        if (!action) throw err(-32602, "action required");
        const validActions = ["compile", "emerge", "reconcile", "prune", "challenge"];
        if (!validActions.includes(action)) {
          throw err(-32602, `Unknown action: ${action}. Valid: ${validActions.join(", ")}`);
        }
        const args = [...baseArgs, "--trigger", action];
        const mode = params.mode as string | undefined;
        if (mode) args.push("--mode", mode);
        try {
          const { stdout } = await exec(python, args, {
            timeout: 300_000, // compile may take a while
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env },
          });
          return JSON.parse(stdout);
        } catch (e) {
          throw err(-32000, `agent.trigger failed: ${(e as Error).message}`);
        }
      }

      case "agent.schedule":
        return { status: "not_implemented", message: "agent.schedule is Phase 6 work" };

      case "agent.history": {
        const args = [...baseArgs, "--history"];
        const limit = params.limit as number | undefined;
        if (limit !== undefined) args.push("--limit", String(limit));
        try {
          const { stdout } = await exec(python, args, {
            timeout: 10_000,
            maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env },
          });
          return JSON.parse(stdout);
        } catch (e) {
          throw err(-32000, `agent.history failed: ${(e as Error).message}`);
        }
      }

      default:
        throw err(-32601, `Unknown method: ${method}`);
    }
  };
}

function getToolDefinitions() {
  return [
    { name: "compile.status", description: "Get compilation status", inputSchema: { type: "object", properties: {} } },
    { name: "compile.run", description: "Run compilation", inputSchema: { type: "object", properties: { topic: { type: "string" } } } },
    { name: "compile.diff", description: "Show compilation diff", inputSchema: { type: "object", properties: { topic: { type: "string" } } } },
    { name: "compile.abort", description: "Abort running compilation", inputSchema: { type: "object", properties: {} } },
    { name: "query.unified", description: "Unified knowledge query across all active adapters (filesystem, obsidian, memu, gitnexus)", inputSchema: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "integer", default: 50 }, adapters: { type: "array", items: { type: "string" }, description: "Limit to specific adapters by name" }, weights: { type: "object", description: "Per-adapter score weight multipliers, e.g. {\"obsidian\":1.2,\"filesystem\":0.8}" }, caseSensitive: { type: "boolean", default: false }, context: { type: "integer", description: "Lines of surrounding context per match" } }, required: ["query"] } },
    { name: "query.search", description: "Search knowledge base (filesystem adapter only)", inputSchema: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "integer", default: 50 } }, required: ["query"] } },
    { name: "query.explain", description: "Explain a concept using top-10 cross-adapter results with 3-line context", inputSchema: { type: "object", properties: { concept: { type: "string" } }, required: ["concept"] } },
    { name: "query.adapters", description: "List registered adapters, their capabilities, and availability", inputSchema: { type: "object", properties: {} } },
    { name: "agent.status", description: "Get agent status", inputSchema: { type: "object", properties: {} } },
    { name: "agent.trigger", description: "Trigger an agent action", inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] } },
    { name: "agent.schedule", description: "Schedule an agent task", inputSchema: { type: "object", properties: { task: { type: "string" }, cron: { type: "string" } }, required: ["task"] } },
    { name: "agent.history", description: "Get agent action history", inputSchema: { type: "object", properties: { limit: { type: "integer", default: 20 } } } },
  ];
}

function checkAuth(config: VaultMindConfig, args: Record<string, unknown>): void {
  if (!config.auth_token) return;
  const provided = (args._auth_token as string) || (args._token as string);
  if (provided !== config.auth_token) {
    throw err(-32403, "Authentication failed: invalid or missing token");
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  // --- Adapter registry ---
  const registry = new AdapterRegistry();

  if (config.vault_path) {
    const fsAdapter = new FilesystemAdapter(config.vault_path);
    await fsAdapter.init();
    registry.register(fsAdapter);
  }

  // Optional adapters -- init gracefully, don't block if unavailable
  const enabledAdapters = new Set(config.adapters ?? ["filesystem", "memu", "gitnexus", "obsidian"]);

  if (enabledAdapters.has("memu")) {
    const memuAdapter = new MemUAdapter();
    await memuAdapter.init();
    if (memuAdapter.isAvailable) registry.register(memuAdapter);
  }

  if (enabledAdapters.has("gitnexus")) {
    const gnAdapter = new GitNexusAdapter();
    await gnAdapter.init();
    if (gnAdapter.isAvailable) registry.register(gnAdapter);
  }

  if (enabledAdapters.has("obsidian")) {
    const obsAdapter = new ObsidianAdapter();
    await obsAdapter.init();
    if (obsAdapter.isAvailable) registry.register(obsAdapter);
  }

  // --- Compile trigger ---
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const compilerPath = resolve(__dirname, "../../compiler");
  const python = process.env.VAULT_MIND_PYTHON ?? process.env.PYTHON ?? "python";
  const compileTrigger = new CompileTrigger({
    vaultPath: config.vault_path,
    compilerPath,
    python,
  });

  // Wire Obsidian file events into compile trigger (when Obsidian is running)
  const obsidianAdapter = registry.get("obsidian");
  if (obsidianAdapter?.isAvailable && typeof obsidianAdapter.onFileChange === "function") {
    obsidianAdapter.onFileChange((e) => {
      if (e.type === "create" || e.type === "modify") {
        compileTrigger.onFileChange(e.path, e.type);
      }
    });
  }

  // Populate dirty set from kb_meta diff (files changed while server was offline)
  await compileTrigger.loadInitialDirty();

  // --- Dispatchers ---
  const vaultFs = new VaultFs(config.vault_path);

  const stderrLogger: Logger = {
    info: (msg) => process.stderr.write(`[INFO] ${msg}\n`),
    warn: (msg) => process.stderr.write(`[WARN] ${msg}\n`),
    error: (msg) => process.stderr.write(`[ERROR] ${msg}\n`),
  };

  const vaultOps = operations.filter(op => op.namespace === 'vault');

  const ctx: OperationContext = {
    vault: vaultFs as VaultExecutor,
    adapters: registry,
    config,
    logger: stderrLogger,
    dryRun: false,
  };

  const queryDispatch = makeQueryDispatch(registry, config.adapter_weights);
  const compileDispatch = makeCompileDispatch(compileTrigger);
  const agentDispatch = makeAgentDispatch(
    config.vault_path,
    compilerPath,
    python,
    config.config_path,
  );

  const server = new Server(
    { name: "vault-mind", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // vault.* tools auto-generated from operations[]
    const vaultToolDefs = vaultOps.map(op => ({
      name: op.name,
      description: op.description,
      inputSchema: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries(op.params).map(([k, v]) => [k, {
            type: v.type,
            description: v.description,
            ...(v.default !== undefined ? { default: v.default } : {}),
            ...(v.enum ? { enum: v.enum } : {}),
          }])
        ),
        required: Object.entries(op.params)
          .filter(([, v]) => v.required)
          .map(([k]) => k),
      },
    }));

    // compile/query/agent tool defs stay hardcoded
    const otherToolDefs = getToolDefinitions().filter(t => !t.name.startsWith('vault.'));

    return { tools: [...vaultToolDefs, ...otherToolDefs] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const toolArgs = (request.params.arguments || {}) as Record<string, unknown>;

    try {
      checkAuth(config, toolArgs);
    } catch (e: unknown) {
      const ex = e as { message?: string };
      return { content: [{ type: "text" as const, text: `Error: ${ex.message}` }], isError: true };
    }

    try {
      let result: unknown;
      if (toolName.startsWith("vault.")) {
        const op = vaultOps.find(o => o.name === toolName);
        if (!op) throw err(-32601, `Unknown vault tool: ${toolName}`);
        const validatedArgs = validateParams(op.params, toolArgs);
        result = await op.handler(ctx, validatedArgs);
        // Hook write ops into compile trigger (preserve existing behavior)
        if (toolName === "vault.create" || toolName === "vault.modify" || toolName === "vault.append") {
          const p = toolArgs.path as string;
          if (p && toolArgs.dryRun === false) {
            compileTrigger.onFileChange(p, toolName === "vault.create" ? "create" : "modify");
          }
        }
      } else if (toolName.startsWith("compile.")) {
        result = await compileDispatch(toolName, toolArgs);
      } else if (toolName.startsWith("query.")) {
        result = await queryDispatch(toolName, toolArgs);
      } else if (toolName.startsWith("agent.")) {
        result = await agentDispatch(toolName, toolArgs);
      } else {
        throw err(-32601, `Unknown tool: ${toolName}`);
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: unknown) {
      const ex = e as { message?: string };
      return { content: [{ type: "text" as const, text: `Error: ${ex.message || String(e)}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const adapterNames = registry.list().map((a) => a.name).join(", ");
  process.stderr.write(`vault-mind: MCP server running (stdio, v${VERSION}, adapters: ${adapterNames})\n`);
}

main().catch((e) => {
  process.stderr.write("vault-mind: fatal: " + (e as Error).message + "\n");
  process.exit(1);
});
