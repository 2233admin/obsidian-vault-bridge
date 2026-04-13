import fs from 'node:fs';
import path from 'node:path';

import type { JsonRpcResponse } from './ws-transport.js';

const VERSION = '0.2.0';

const PROTECTED_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);

// ReDoS guard: reject regex patterns with nested quantifiers
function rejectDangerousRegex(pattern: string): void {
  if (/(\([^)]*[+*}]\s*\))[+*{]/.test(pattern))
    throw { code: -32602, message: 'regex rejected: nested quantifiers (ReDoS risk)' };
  if (/\([^)]*\|[^)]*\)[+*{]/.test(pattern) && /(\w)\|.*\1/.test(pattern))
    throw { code: -32602, message: 'regex rejected: overlapping alternation (ReDoS risk)' };
}

interface FrontmatterValue {
  [key: string]: unknown;
}

interface WikiLink {
  link: string;
  displayText: string;
}

interface Heading {
  heading: string;
  level: number;
  position: { line: number };
}

interface BatchOperation {
  method: string;
  params?: Record<string, unknown>;
}

export class FsTransport {
  private vault: string;

  constructor(vaultPath: string) {
    this.vault = path.resolve(vaultPath || '');
  }

  get vaultPath(): string { return this.vault; }

  resolve(p: string): string {
    if (typeof p !== 'string' || !p.trim()) throw { code: -32602, message: 'path required' };
    const normalized = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '');
    if (normalized.split('/').some((s: string) => s === '..' || s === '.'))
      throw { code: -32602, message: 'path traversal blocked' };
    const topSegment = normalized.split('/')[0];
    if (PROTECTED_DIRS.has(topSegment))
      throw { code: -32602, message: `protected path: ${topSegment}` };
    const full = path.resolve(this.vault, normalized);
    if (!full.startsWith(this.vault))
      throw { code: -32602, message: 'path escapes vault' };
    return full;
  }

  parseFrontmatter(content: string): FrontmatterValue | null {
    if (!content.startsWith('---')) return null;
    const end = content.indexOf('\n---', 3);
    if (end === -1) return null;
    const block = content.slice(4, end);
    const fm: FrontmatterValue = {};
    let currentKey: string | null = null;
    let inArray = false;
    let arrayItems: unknown[] = [];
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (inArray && trimmed.startsWith('- ')) {
        arrayItems.push(this._parseYamlValue(trimmed.slice(2).trim()));
        continue;
      }
      if (inArray) { fm[currentKey!] = arrayItems; inArray = false; arrayItems = []; }
      const colon = trimmed.indexOf(':');
      if (colon === -1) continue;
      const key = trimmed.slice(0, colon).trim();
      const rawVal = trimmed.slice(colon + 1).trim();
      currentKey = key;
      if (rawVal === '') { inArray = true; arrayItems = []; continue; }
      if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
        fm[key] = rawVal.slice(1, -1).split(',').map((s: string) => this._parseYamlValue(s.trim()));
      } else {
        fm[key] = this._parseYamlValue(rawVal);
      }
    }
    if (inArray) fm[currentKey!] = arrayItems;
    return fm;
  }

  _parseYamlValue(s: string): unknown {
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~') return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    return s;
  }

  parseWikilinks(content: string): WikiLink[] {
    const links: WikiLink[] = [];
    const re = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      links.push({ link: m[1], displayText: m[2] || m[1] });
    }
    return links;
  }

  parseTags(content: string): string[] {
    const cleaned = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    const tags: string[] = [];
    const re = /(?:^|\s)#([a-zA-Z_\u4e00-\u9fff][\w/\u4e00-\u9fff-]*)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      tags.push('#' + m[1]);
    }
    return [...new Set(tags)];
  }

  parseHeadings(content: string): Heading[] {
    const headings: Heading[] = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const hm = lines[i].match(/^(#{1,6})\s+(.+)/);
      if (hm) headings.push({ heading: hm[2].trim(), level: hm[1].length, position: { line: i } });
    }
    return headings;
  }

  call(method: string, params: Record<string, unknown> | undefined, id: string | number): Promise<JsonRpcResponse> {
    try {
      const result = this.dispatch(method, params || {});
      return Promise.resolve({ jsonrpc: '2.0' as const, id, result });
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      return Promise.resolve({
        jsonrpc: '2.0' as const, id,
        error: { code: e.code || -32000, message: e.message || String(err) }
      });
    }
  }

  dispatch(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case 'vault.read': {
        const full = this.resolve(p['path'] as string);
        if (!fs.existsSync(full)) throw { code: -32001, message: `Not found: ${p['path']}` };
        return { content: fs.readFileSync(full, 'utf-8') };
      }
      case 'vault.exists':
        return { exists: fs.existsSync(this.resolve(p['path'] as string)) };
      case 'vault.list': {
        const dir = this.resolve((p['path'] as string) || '');
        if (!fs.existsSync(dir)) throw { code: -32001, message: `Not found: ${p['path']}` };
        const hidden = new Set(['.obsidian', '.trash', 'node_modules']);
        const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !hidden.has(e.name));
        return {
          files: entries.filter(e => e.isFile()).map(e => path.posix.join((p['path'] as string) || '', e.name)).sort(),
          folders: entries.filter(e => e.isDirectory()).map(e => path.posix.join((p['path'] as string) || '', e.name)).sort(),
        };
      }
      case 'vault.stat': {
        const full = this.resolve(p['path'] as string);
        if (!fs.existsSync(full)) throw { code: -32001, message: `Not found: ${p['path']}` };
        const st = fs.statSync(full);
        if (st.isDirectory()) return { type: 'folder', path: p['path'], name: path.basename(p['path'] as string), children: fs.readdirSync(full).length };
        return { type: 'file', path: p['path'], name: path.basename(p['path'] as string), ext: path.extname(p['path'] as string).slice(1), size: st.size, ctime: st.ctimeMs, mtime: st.mtimeMs };
      }
      case 'vault.create': {
        const full = this.resolve(p['path'] as string);
        if (fs.existsSync(full)) throw { code: -32002, message: `Already exists: ${p['path']}` };
        if (p['dryRun'] !== false) return { dryRun: true, action: 'create', path: p['path'] };
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, (p['content'] as string) || '', 'utf-8');
        return { ok: true, path: p['path'] };
      }
      case 'vault.modify': {
        const full = this.resolve(p['path'] as string);
        if (!fs.existsSync(full)) throw { code: -32001, message: `Not found: ${p['path']}` };
        if (p['dryRun'] !== false) return { dryRun: true, action: 'modify', path: p['path'] };
        fs.writeFileSync(full, p['content'] as string, 'utf-8');
        return { ok: true, path: p['path'] };
      }
      case 'vault.append': {
        const full = this.resolve(p['path'] as string);
        if (!fs.existsSync(full)) throw { code: -32001, message: `Not found: ${p['path']}` };
        if (p['dryRun'] !== false) return { dryRun: true, action: 'append', path: p['path'] };
        fs.appendFileSync(full, p['content'] as string, 'utf-8');
        return { ok: true, path: p['path'] };
      }
      case 'vault.delete': {
        const full = this.resolve(p['path'] as string);
        if (!fs.existsSync(full)) throw { code: -32001, message: `Not found: ${p['path']}` };
        if (p['dryRun'] !== false) return { dryRun: true, action: 'delete', path: p['path'] };
        fs.rmSync(full, { recursive: true });
        return { ok: true, path: p['path'] };
      }
      case 'vault.mkdir': {
        const full = this.resolve(p['path'] as string);
        if (fs.existsSync(full)) throw { code: -32002, message: `Already exists: ${p['path']}` };
        if (p['dryRun'] !== false) return { dryRun: true, action: 'mkdir', path: p['path'] };
        fs.mkdirSync(full, { recursive: true });
        return { ok: true, path: p['path'] };
      }
      case 'vault.rename': {
        const from = this.resolve(p['from'] as string);
        const to = this.resolve(p['to'] as string);
        if (!fs.existsSync(from)) throw { code: -32001, message: `Not found: ${p['from']}` };
        if (fs.existsSync(to)) throw { code: -32002, message: `Already exists: ${p['to']}` };
        if (p['dryRun'] !== false) return { dryRun: true, action: 'rename', from: p['from'], to: p['to'] };
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        return { ok: true, from: p['from'], to: p['to'] };
      }
      case 'vault.search': {
        const results: Array<{ path: string; matches: Array<{ line: number; text: string }> }> = [];
        const max = (p['maxResults'] as number) || 50;
        let total = 0;
        if (typeof p['query'] !== 'string' || (p['query'] as string).length > 500)
          throw { code: -32602, message: 'query must be a string under 500 chars' };
        const flags = p['caseSensitive'] ? 'g' : 'gi';
        let pattern: RegExp;
        try {
          if (p['regex']) rejectDangerousRegex(p['query'] as string);
          pattern = p['regex']
            ? new RegExp(p['query'] as string, flags)
            : new RegExp((p['query'] as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
        } catch (e: unknown) {
          const err = e as { code?: number; message?: string };
          throw { code: err.code || -32602, message: err.message || `Invalid regex: ${err.message}` };
        }
        this.walkMd(this.vault, (relPath: string, content: string) => {
          if (total >= max) return;
          if (p['glob'] && !this.matchGlob(relPath, p['glob'] as string)) return;
          const lines = content.split('\n');
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
      case 'vault.init': {
        if (!p['topic'] || typeof p['topic'] !== 'string') throw { code: -32602, message: 'topic required' };
        if ((p['topic'] as string).split('/').some((s: string) => s === '..' || s === '.')) throw { code: -32602, message: 'path traversal blocked' };
        const created: string[] = [], skipped: string[] = [];
        const base = p['topic'] as string;
        const now = new Date().toISOString().slice(0, 10);
        const ensureDir = (rel: string) => {
          const full = this.resolve(rel);
          if (fs.existsSync(full)) { skipped.push(rel); return; }
          fs.mkdirSync(full, { recursive: true });
          created.push(rel);
        };
        const ensureFile = (rel: string, content: string) => {
          const r = rel.endsWith('.md') ? rel : rel + '.md';
          const full = this.resolve(r);
          if (fs.existsSync(full)) { skipped.push(r); return; }
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, content, 'utf-8');
          created.push(r);
        };
        ensureDir(base);
        for (const sub of ['raw', 'raw/articles', 'raw/papers', 'raw/notes', 'raw/transcripts', 'wiki', 'wiki/summaries', 'wiki/concepts', 'wiki/queries', 'schema']) ensureDir(`${base}/${sub}`);
        ensureFile(`${base}/wiki/_index.md`, `---\ntopic: "${p['topic']}"\nupdated: ${now}\n---\n\n# ${p['topic']} -- Knowledge Index\n\nNo articles compiled yet.\n`);
        ensureFile(`${base}/wiki/_sources.md`, `---\ntopic: "${p['topic']}"\nupdated: ${now}\n---\n\n# Sources\n\nNo sources compiled yet.\n`);
        ensureFile(`${base}/wiki/_categories.md`, `---\ntopic: "${p['topic']}"\nupdated: ${now}\n---\n\n# Categories\n\nAuto-generated during compilation.\n`);
        ensureFile(`${base}/Log.md`, `# ${p['topic']} -- Operation Log\n\n- ${now}: KB initialized\n`);
        ensureFile(`${base}/schema/CLAUDE.md`, `# ${p['topic']} -- KB Schema\n\nFollows llm-wiki opinionated workflow.\nSee root CLAUDE.md for full documentation.\n`);
        const yamlPath = `${base}/kb.yaml`;
        if (fs.existsSync(this.resolve(yamlPath))) { skipped.push(yamlPath); }
        else { fs.writeFileSync(this.resolve(yamlPath), `topic: "${p['topic']}"\nvault_path: "${this.vault.replace(/\\\\/g, '/')}"\ncreated: ${now}\n`, 'utf-8'); created.push(yamlPath); }
        return { ok: true, topic: p['topic'], created, skipped, summary: `Created ${created.length}, skipped ${skipped.length}` };
      }
      case 'vault.getMetadata': {
        const full = this.resolve(p['path'] as string);
        if (!fs.existsSync(full)) throw { code: -32001, message: `Not found: ${p['path']}` };
        const content = fs.readFileSync(full, 'utf-8');
        const out: Record<string, unknown> = {};
        const links = this.parseWikilinks(content);
        if (links.length) out['links'] = links.map((l: WikiLink) => ({ link: l.link, displayText: l.displayText }));
        const tags = this.parseTags(content);
        if (tags.length) out['tags'] = tags.map((t: string) => ({ tag: t }));
        const headings = this.parseHeadings(content);
        if (headings.length) out['headings'] = headings;
        const fm = this.parseFrontmatter(content);
        if (fm) out['frontmatter'] = fm;
        return out;
      }
      case 'vault.searchByTag': {
        if (!p['tag']) throw { code: -32602, message: 'tag required' };
        const bare = (p['tag'] as string).startsWith('#') ? (p['tag'] as string).slice(1) : (p['tag'] as string);
        const hashTag = '#' + bare;
        const files: string[] = [];
        this.walkMd(this.vault, (relPath: string, content: string) => {
          const tags = this.parseTags(content);
          if (tags.includes(hashTag)) { files.push(relPath); return; }
          const fm = this.parseFrontmatter(content);
          const fmTags = (fm?.['tags'] ?? fm?.['tag']) as unknown;
          if (Array.isArray(fmTags) && (fmTags as unknown[]).includes(bare)) { files.push(relPath); }
          else if (typeof fmTags === 'string' && fmTags === bare) { files.push(relPath); }
        });
        return { files: files.sort() };
      }
      case 'vault.searchByFrontmatter': {
        if (!p['key']) throw { code: -32602, message: 'key required' };
        const op = (p['op'] as string) || 'eq';
        const validOps = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'regex', 'exists'];
        if (!validOps.includes(op)) throw { code: -32602, message: `Unknown op: ${op}. Valid: ${validOps.join(', ')}` };
        const results: Array<{ path: string; value: unknown }> = [];
        this.walkMd(this.vault, (relPath: string, content: string) => {
          const fm = this.parseFrontmatter(content);
          if (!fm) return;
          if (op === 'exists') {
            if ((p['key'] as string) in fm) results.push({ path: relPath, value: fm[p['key'] as string] });
            return;
          }
          if (!(p['key'] as string in fm)) return;
          const v = fm[p['key'] as string];
          let match = false;
          switch (op) {
            case 'eq': match = v === p['value']; break;
            case 'ne': match = v !== p['value']; break;
            case 'gt': match = typeof v === 'number' && typeof p['value'] === 'number' && v > (p['value'] as number); break;
            case 'lt': match = typeof v === 'number' && typeof p['value'] === 'number' && v < (p['value'] as number); break;
            case 'gte': match = typeof v === 'number' && typeof p['value'] === 'number' && v >= (p['value'] as number); break;
            case 'lte': match = typeof v === 'number' && typeof p['value'] === 'number' && v <= (p['value'] as number); break;
            case 'contains': match = typeof v === 'string' && typeof p['value'] === 'string' && v.includes(p['value'] as string); break;
            case 'regex':
              try {
                if (typeof p['value'] === 'string') rejectDangerousRegex(p['value'] as string);
                match = typeof v === 'string' && typeof p['value'] === 'string' && new RegExp(p['value'] as string).test(v);
              } catch { match = false; }
              break;
            default: match = v === p['value'];
          }
          if (match) results.push({ path: relPath, value: v });
        });
        return { files: results.sort((a, b) => a.path.localeCompare(b.path)) };
      }
      case 'vault.graph': {
        const type = (p['type'] as string) || 'both';
        const nodeSet = new Set<string>();
        const edgeMap = new Map<string, number>();
        const inbound = new Set<string>();
        this.walkMd(this.vault, (relPath: string, content: string) => {
          nodeSet.add(relPath);
          const links = this.parseWikilinks(content);
          for (const l of links) {
            if (l.link.startsWith('#')) continue;
            let target = l.link.split('#')[0];
            if (!target) continue;
            if (!target.includes('/')) {
              const withMd = target.endsWith('.md') ? target : target + '.md';
              if (fs.existsSync(this.resolve(withMd))) target = withMd;
            }
            if (!target.endsWith('.md')) target += '.md';
            nodeSet.add(target);
            inbound.add(target);
            const key = relPath + '\0' + target;
            edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
          }
        });
        const edges: Array<{ from: string; to: string; count: number }> = [];
        for (const [key, count] of edgeMap) {
          const [from, to] = key.split('\0');
          edges.push({ from, to, count });
        }
        const nodes = Array.from(nodeSet).sort().map(nodePath => ({
          path: nodePath, exists: fs.existsSync(this.resolve(nodePath))
        }));
        const orphans = type === 'resolved' || type === 'both'
          ? nodes.filter(n => n.exists && n.path.endsWith('.md') && !inbound.has(n.path)).map(n => n.path)
          : [];
        return { nodes, edges, orphans };
      }
      case 'vault.backlinks': {
        if (!p['path']) throw { code: -32602, message: 'path required' };
        const target = (p['path'] as string).endsWith('.md') ? (p['path'] as string) : (p['path'] as string) + '.md';
        const targetBase = path.basename(target, '.md');
        const results: Array<{ from: string; count: number }> = [];
        this.walkMd(this.vault, (relPath: string, content: string) => {
          if (relPath === target) return;
          const links = this.parseWikilinks(content);
          let count = 0;
          for (const l of links) {
            const linkPath = l.link.split('#')[0];
            if (!linkPath) continue;
            if (linkPath === target || linkPath === targetBase || linkPath + '.md' === target) count++;
          }
          if (count > 0) results.push({ from: relPath, count });
        });
        return { backlinks: results.sort((a, b) => a.from.localeCompare(b.from)) };
      }
      case 'vault.batch': {
        if (!Array.isArray(p['operations'])) throw { code: -32602, message: 'operations must be an array' };
        const results: Array<{ index: number; ok: boolean; result?: unknown; error?: { code: number; message: string } }> = [];
        let succeeded = 0, failed = 0;
        const operations = p['operations'] as BatchOperation[];
        for (let i = 0; i < operations.length; i++) {
          const op = operations[i];
          if (!op.method?.startsWith('vault.')) throw { code: -32602, message: `Batch only supports vault.* methods (index ${i})` };
          if (op.method === 'vault.batch') throw { code: -32602, message: 'Recursive batch not allowed' };
          try {
            const params: Record<string, unknown> = { ...(op.params || {}) };
            if (p['dryRun'] !== undefined) params['dryRun'] = p['dryRun'];
            const result = this.dispatch(op.method, params);
            results.push({ index: i, ok: true, result });
            succeeded++;
          } catch (err: unknown) {
            const e = err as { code?: number; message?: string };
            results.push({ index: i, ok: false, error: { code: e.code || -32000, message: e.message || String(err) } });
            failed++;
          }
        }
        return { results, summary: { total: operations.length, succeeded, failed } };
      }
      case 'vault.lint': {
        const requiredFm = Array.isArray(p['requiredFrontmatter']) ? p['requiredFrontmatter'] as string[] : [];
        const allFiles: Array<{ path: string; size: number; content: string }> = [];
        const linkMap = new Map<string, Map<string, number>>();
        const inbound = new Set<string>();
        this.walkMd(this.vault, (relPath: string, content: string) => {
          const st = fs.statSync(this.resolve(relPath));
          allFiles.push({ path: relPath, size: st.size, content });
          const links = this.parseWikilinks(content);
          const targets = new Map<string, number>();
          for (const l of links) {
            const t = l.link.endsWith('.md') ? l.link : l.link + '.md';
            targets.set(t, (targets.get(t) || 0) + 1);
          }
          linkMap.set(relPath, targets);
          for (const t of targets.keys()) inbound.add(t);
        });
        const orphans = allFiles.filter(f => !inbound.has(f.path)).map(f => f.path).sort();
        const brokenLinks: Array<{ from: string; to: string }> = [];
        for (const [from, targets] of linkMap) {
          for (const [to] of targets) {
            if (!fs.existsSync(this.resolve(to))) brokenLinks.push({ from, to });
          }
        }
        const emptyFiles = allFiles.filter(f => f.size === 0).map(f => f.path).sort();
        const missingFm: Array<{ path: string; missing: string[] }> = [];
        if (requiredFm.length > 0) {
          for (const f of allFiles) {
            const fm = this.parseFrontmatter(f.content) || {};
            const missing = requiredFm.filter((k: string) => !(k in fm));
            if (missing.length > 0) missingFm.push({ path: f.path, missing });
          }
        }
        const titleMap = new Map<string, string[]>();
        for (const f of allFiles) {
          const t = path.basename(f.path, '.md').toLowerCase();
          const arr = titleMap.get(t) || [];
          arr.push(f.path);
          titleMap.set(t, arr);
        }
        const duplicates = Array.from(titleMap.entries())
          .filter(([, paths]) => paths.length > 1)
          .map(([title, files]) => ({ title, files: files.sort() }));
        let totalLinks = 0;
        for (const targets of linkMap.values()) for (const c of targets.values()) totalLinks += c;
        return {
          orphans, brokenLinks, emptyFiles, missingFrontmatter: missingFm, duplicateTitles: duplicates,
          stats: { totalFiles: allFiles.length, totalLinks, totalOrphans: orphans.length, totalBroken: brokenLinks.length, totalEmpty: emptyFiles.length, totalDuplicates: duplicates.length }
        };
      }
      case 'vault.externalSearch':
        throw { code: -32000, message: 'No external search engine configured' };
      case 'listCapabilities':
        return { methods: ['vault.read', 'vault.create', 'vault.modify', 'vault.append', 'vault.delete', 'vault.rename', 'vault.mkdir', 'vault.search', 'vault.list', 'vault.stat', 'vault.exists', 'vault.init', 'vault.getMetadata', 'vault.searchByTag', 'vault.searchByFrontmatter', 'vault.graph', 'vault.backlinks', 'vault.batch', 'vault.lint', 'vault.externalSearch'], version: VERSION };
      default:
        throw { code: -32601, message: `Unknown method: ${method}` };
    }
  }

  walkMd(dir: string, fn: (relPath: string, content: string) => void): void {
    const walk = (d: string) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory() && ent.name !== '.obsidian' && ent.name !== '.trash' && ent.name !== 'node_modules') walk(full);
        else if (ent.isFile() && ent.name.endsWith('.md')) {
          const rel = path.relative(this.vault, full).replace(/\\/g, '/');
          fn(rel, fs.readFileSync(full, 'utf-8'));
        }
      }
    };
    walk(dir);
  }

  matchGlob(p: string, glob: string): boolean {
    const re = new RegExp('^' + glob.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
    return re.test(p);
  }

  async execute(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.dispatch(method, params);
  }

  close(): void {}
}
