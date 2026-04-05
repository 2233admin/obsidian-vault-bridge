#!/usr/bin/env node
// vault-bridge MCP connector -- stdio transport
// Proxies to WS when Obsidian runs, filesystem fallback when it doesn't.

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const PORT_FILE = path.join(os.homedir(), ".obsidian-ws-port");
const VERSION = "0.2.0";

// --- Transport layer ---

function readPortFile() {
  try {
    return JSON.parse(fs.readFileSync(PORT_FILE, "utf-8"));
  } catch {
    return null;
  }
}

class WsTransport {
  constructor(info) {
    this.port = info.port;
    this.token = info.token;
    this.ws = null;
    this.pending = new Map();
    this.authenticated = false;
    this.ready = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let WebSocket;
      try { WebSocket = require("ws"); } catch {
        reject(new Error("ws module not found -- falling back to filesystem"));
        return;
      }
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      const timeout = setTimeout(() => {
        this.ws.close();
        reject(new Error("WS connect timeout"));
      }, 3000);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        this.ws.send(JSON.stringify({
          jsonrpc: "2.0", method: "authenticate",
          params: { token: this.token }, id: "__auth__"
        }));
      });

      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === "__auth__") {
          if (msg.result?.ok) { this.authenticated = true; resolve(); }
          else reject(new Error("Auth failed"));
          return;
        }
        const cb = this.pending.get(msg.id);
        if (cb) { this.pending.delete(msg.id); cb(msg); }
      });

      this.ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
      this.ws.on("close", () => {
        this.authenticated = false;
        for (const [id, cb] of this.pending) {
          cb({ jsonrpc: "2.0", id, error: { code: -32000, message: "WS connection closed" } });
        }
        this.pending.clear();
      });
    });
  }

  call(method, params, id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WS call timeout: ${method} (id=${id})`));
      }, 30000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    });
  }

  close() { if (this.ws) this.ws.close(); }
}

// --- Filesystem fallback ---

class FsTransport {
  constructor(vaultPath) {
    this.vault = vaultPath || "";
  }

  resolve(p) {
    if (typeof p !== "string" || !p.trim()) throw { code: -32602, message: "path required" };
    const normalized = p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");
    if (normalized.split("/").some(s => s === ".." || s === "."))
      throw { code: -32602, message: "path traversal blocked" };
    const full = path.join(this.vault, normalized);
    if (!full.startsWith(this.vault))
      throw { code: -32602, message: "path escapes vault" };
    return full;
  }

  // --- helpers for metadata-less filesystem parsing ---

  parseFrontmatter(content) {
    if (!content.startsWith("---")) return null;
    const end = content.indexOf("\n---", 3);
    if (end === -1) return null;
    const block = content.slice(4, end);
    const fm = {};
    let currentKey = null;
    let inArray = false;
    let arrayItems = [];
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (inArray && trimmed.startsWith("- ")) {
        arrayItems.push(this._parseYamlValue(trimmed.slice(2).trim()));
        continue;
      }
      if (inArray) { fm[currentKey] = arrayItems; inArray = false; arrayItems = []; }
      const colon = trimmed.indexOf(":");
      if (colon === -1) continue;
      const key = trimmed.slice(0, colon).trim();
      const rawVal = trimmed.slice(colon + 1).trim();
      currentKey = key;
      if (rawVal === "") { inArray = true; arrayItems = []; continue; }
      if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
        fm[key] = rawVal.slice(1, -1).split(",").map(s => this._parseYamlValue(s.trim()));
      } else {
        fm[key] = this._parseYamlValue(rawVal);
      }
    }
    if (inArray) fm[currentKey] = arrayItems;
    return fm;
  }

  _parseYamlValue(s) {
    if (s === "true") return true;
    if (s === "false") return false;
    if (s === "null" || s === "~") return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    return s;
  }

  parseWikilinks(content) {
    const links = [];
    const re = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      links.push({ link: m[1], displayText: m[2] || m[1] });
    }
    return links;
  }

  parseTags(content) {
    // skip code blocks
    const cleaned = content.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
    const tags = [];
    const re = /(?:^|\s)#([a-zA-Z_\u4e00-\u9fff][\w/\u4e00-\u9fff-]*)/gm;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      tags.push("#" + m[1]);
    }
    return [...new Set(tags)];
  }

  parseHeadings(content) {
    const headings = [];
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const hm = lines[i].match(/^(#{1,6})\s+(.+)/);
      if (hm) headings.push({ heading: hm[2].trim(), level: hm[1].length, position: { line: i } });
    }
    return headings;
  }

  call(method, params, id) {
    try {
      const result = this.dispatch(method, params || {});
      return Promise.resolve({ jsonrpc: "2.0", id, result });
    } catch (err) {
      return Promise.resolve({
        jsonrpc: "2.0", id,
        error: { code: err.code || -32000, message: err.message || String(err) }
      });
    }
  }

  dispatch(method, p) {
    switch (method) {
      case "vault.read": {
        const full = this.resolve(p.path);
        if (!fs.existsSync(full)) throw { code: -32001, message: `Not found: ${p.path}` };
        return { content: fs.readFileSync(full, "utf-8") };
      }
      case "vault.exists":
        return { exists: fs.existsSync(this.resolve(p.path)) };
      case "vault.list": {
        const dir = this.resolve(p.path || "");
        if (!fs.existsSync(dir)) throw { code: -32001, message: `Not found: ${p.path}` };
        const hidden = new Set([".obsidian", ".trash", "node_modules"]);
        const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !hidden.has(e.name));
        return {
          files: entries.filter(e => e.isFile()).map(e => path.posix.join(p.path || "", e.name)).sort(),
          folders: entries.filter(e => e.isDirectory()).map(e => path.posix.join(p.path || "", e.name)).sort(),
        };
      }
      case "vault.stat": {
        const full = this.resolve(p.path);
        if (!fs.existsSync(full)) throw { code: -32001, message: `Not found: ${p.path}` };
        const st = fs.statSync(full);
        if (st.isDirectory()) return { type: "folder", path: p.path, name: path.basename(p.path), children: fs.readdirSync(full).length };
        return { type: "file", path: p.path, name: path.basename(p.path), ext: path.extname(p.path).slice(1), size: st.size, ctime: st.ctimeMs, mtime: st.mtimeMs };
      }
      case "vault.create": {
        const full = this.resolve(p.path);
        if (fs.existsSync(full)) throw { code: -32002, message: `Already exists: ${p.path}` };
        if (p.dryRun !== false) return { dryRun: true, action: "create", path: p.path };
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, p.content || "", "utf-8");
        return { ok: true, path: p.path };
      }
      case "vault.modify": {
        const full = this.resolve(p.path);
        if (!fs.existsSync(full)) throw { code: -32001, message: `Not found: ${p.path}` };
        if (p.dryRun !== false) return { dryRun: true, action: "modify", path: p.path };
        fs.writeFileSync(full, p.content, "utf-8");
        return { ok: true, path: p.path };
      }
      case "vault.append": {
        const full = this.resolve(p.path);
        if (!fs.existsSync(full)) throw { code: -32001, message: `Not found: ${p.path}` };
        if (p.dryRun !== false) return { dryRun: true, action: "append", path: p.path };
        fs.appendFileSync(full, p.content, "utf-8");
        return { ok: true, path: p.path };
      }
      case "vault.delete": {
        const full = this.resolve(p.path);
        if (!fs.existsSync(full)) throw { code: -32001, message: `Not found: ${p.path}` };
        if (p.dryRun !== false) return { dryRun: true, action: "delete", path: p.path };
        fs.rmSync(full, { recursive: true });
        return { ok: true, path: p.path };
      }
      case "vault.mkdir": {
        const full = this.resolve(p.path);
        if (fs.existsSync(full)) throw { code: -32002, message: `Already exists: ${p.path}` };
        if (p.dryRun !== false) return { dryRun: true, action: "mkdir", path: p.path };
        fs.mkdirSync(full, { recursive: true });
        return { ok: true, path: p.path };
      }
      case "vault.rename": {
        const from = this.resolve(p.from);
        const to = this.resolve(p.to);
        if (!fs.existsSync(from)) throw { code: -32001, message: `Not found: ${p.from}` };
        if (fs.existsSync(to)) throw { code: -32002, message: `Already exists: ${p.to}` };
        if (p.dryRun !== false) return { dryRun: true, action: "rename", from: p.from, to: p.to };
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        return { ok: true, from: p.from, to: p.to };
      }
      case "vault.search": {
        const results = [];
        const max = p.maxResults || 50;
        let total = 0;
        if (typeof p.query !== "string" || p.query.length > 500) throw { code: -32602, message: "query must be a string under 500 chars" };
        const flags = p.caseSensitive ? "g" : "gi";
        let pattern;
        try {
          pattern = p.regex ? new RegExp(p.query, flags) : new RegExp(p.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
        } catch (e) { throw { code: -32602, message: `Invalid regex: ${e.message}` }; }
        this.walkMd(this.vault, (relPath, content) => {
          if (total >= max) return;
          if (p.glob && !this.matchGlob(relPath, p.glob)) return;
          const lines = content.split("\n");
          const matches = [];
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
      case "vault.init": {
        if (!p.topic || typeof p.topic !== "string") throw { code: -32602, message: "topic required" };
        if (p.topic.split("/").some(s => s === ".." || s === ".")) throw { code: -32602, message: "path traversal blocked" };
        const created = [], skipped = [];
        const base = p.topic;
        const now = new Date().toISOString().slice(0, 10);
        const ensureDir = (rel) => {
          const full = this.resolve(rel);
          if (fs.existsSync(full)) { skipped.push(rel); return; }
          fs.mkdirSync(full, { recursive: true });
          created.push(rel);
        };
        const ensureFile = (rel, content) => {
          const r = rel.endsWith(".md") ? rel : rel + ".md";
          const full = this.resolve(r);
          if (fs.existsSync(full)) { skipped.push(r); return; }
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, content, "utf-8");
          created.push(r);
        };
        ensureDir(base);
        for (const sub of ["raw", "raw/articles", "raw/papers", "raw/notes", "raw/transcripts", "wiki", "wiki/summaries", "wiki/concepts", "wiki/queries", "schema"]) ensureDir(`${base}/${sub}`);
        ensureFile(`${base}/wiki/_index.md`, `---\ntopic: "${p.topic}"\nupdated: ${now}\n---\n\n# ${p.topic} -- Knowledge Index\n\nNo articles compiled yet.\n`);
        ensureFile(`${base}/wiki/_sources.md`, `---\ntopic: "${p.topic}"\nupdated: ${now}\n---\n\n# Sources\n\nNo sources compiled yet.\n`);
        ensureFile(`${base}/wiki/_categories.md`, `---\ntopic: "${p.topic}"\nupdated: ${now}\n---\n\n# Categories\n\nAuto-generated during compilation.\n`);
        ensureFile(`${base}/Log.md`, `# ${p.topic} -- Operation Log\n\n- ${now}: KB initialized\n`);
        ensureFile(`${base}/schema/CLAUDE.md`, `# ${p.topic} -- KB Schema\n\nFollows vault-bridge opinionated workflow.\nSee root CLAUDE.md for full documentation.\n`);
        const yamlPath = `${base}/kb.yaml`;
        if (fs.existsSync(this.resolve(yamlPath))) { skipped.push(yamlPath); }
        else { fs.writeFileSync(this.resolve(yamlPath), `topic: "${p.topic}"\nvault_path: "${this.vault.replace(/\\\\/g, "/")}"\ncreated: ${now}\n`, "utf-8"); created.push(yamlPath); }
        return { ok: true, topic: p.topic, created, skipped, summary: `Created ${created.length}, skipped ${skipped.length}` };
      }
      case "vault.getMetadata": {
        const full = this.resolve(p.path);
        if (!fs.existsSync(full)) throw { code: -32001, message: `Not found: ${p.path}` };
        const content = fs.readFileSync(full, "utf-8");
        const out = {};
        const links = this.parseWikilinks(content);
        if (links.length) out.links = links.map((l, i) => ({ link: l.link, displayText: l.displayText }));
        const tags = this.parseTags(content);
        if (tags.length) out.tags = tags.map(t => ({ tag: t }));
        const headings = this.parseHeadings(content);
        if (headings.length) out.headings = headings;
        const fm = this.parseFrontmatter(content);
        if (fm) out.frontmatter = fm;
        return out;
      }
      case "vault.searchByTag": {
        if (!p.tag) throw { code: -32602, message: "tag required" };
        const bare = p.tag.startsWith("#") ? p.tag.slice(1) : p.tag;
        const hashTag = "#" + bare;
        const files = [];
        this.walkMd(this.vault, (relPath, content) => {
          // inline tags
          const tags = this.parseTags(content);
          if (tags.includes(hashTag)) { files.push(relPath); return; }
          // frontmatter tags
          const fm = this.parseFrontmatter(content);
          const fmTags = fm?.tags ?? fm?.tag;
          if (Array.isArray(fmTags) && fmTags.includes(bare)) { files.push(relPath); }
          else if (typeof fmTags === "string" && fmTags === bare) { files.push(relPath); }
        });
        return { files: files.sort() };
      }
      case "vault.searchByFrontmatter": {
        if (!p.key) throw { code: -32602, message: "key required" };
        const op = p.op || "eq";
        const validOps = ["eq","ne","gt","lt","gte","lte","contains","regex","exists"];
        if (!validOps.includes(op)) throw { code: -32602, message: `Unknown op: ${op}. Valid: ${validOps.join(", ")}` };
        const results = [];
        this.walkMd(this.vault, (relPath, content) => {
          const fm = this.parseFrontmatter(content);
          if (!fm) return;
          if (op === "exists") {
            if (p.key in fm) results.push({ path: relPath, value: fm[p.key] });
            return;
          }
          if (!(p.key in fm)) return;
          const v = fm[p.key];
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
              try { match = typeof v === "string" && typeof p.value === "string" && new RegExp(p.value).test(v); }
              catch { match = false; }
              break;
            default: match = v === p.value;
          }
          if (match) results.push({ path: relPath, value: v });
        });
        return { files: results.sort((a, b) => a.path.localeCompare(b.path)) };
      }
      case "vault.graph": {
        const type = p.type || "both";
        const nodeSet = new Set();
        const edgeMap = new Map();
        const inbound = new Set();
        this.walkMd(this.vault, (relPath, content) => {
          nodeSet.add(relPath);
          const links = this.parseWikilinks(content);
          for (const l of links) {
            // skip heading-only anchors like [[#heading]]
            if (l.link.startsWith("#")) continue;
            // strip heading anchor from path links like [[note#heading]]
            let target = l.link.split("#")[0];
            if (!target) continue;
            if (!target.includes("/")) {
              // basename-only link -- search for matching file
              const withMd = target.endsWith(".md") ? target : target + ".md";
              // check if exists at vault root or leave as-is
              if (fs.existsSync(this.resolve(withMd))) target = withMd;
            }
            if (!target.endsWith(".md")) target += ".md";
            nodeSet.add(target);
            inbound.add(target);
            const key = relPath + "\0" + target;
            edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
          }
        });
        const edges = [];
        for (const [key, count] of edgeMap) {
          const [from, to] = key.split("\0");
          edges.push({ from, to, count });
        }
        const nodes = Array.from(nodeSet).sort().map(p => ({
          path: p, exists: fs.existsSync(this.resolve(p))
        }));
        const orphans = type === "resolved" || type === "both"
          ? nodes.filter(n => n.exists && n.path.endsWith(".md") && !inbound.has(n.path)).map(n => n.path)
          : [];
        return { nodes, edges, orphans };
      }
      case "vault.backlinks": {
        if (!p.path) throw { code: -32602, message: "path required" };
        const target = p.path.endsWith(".md") ? p.path : p.path + ".md";
        const targetBase = path.basename(target, ".md");
        const results = [];
        this.walkMd(this.vault, (relPath, content) => {
          if (relPath === target) return;
          const links = this.parseWikilinks(content);
          let count = 0;
          for (const l of links) {
            const linkPath = l.link.split("#")[0];
            if (!linkPath) continue;
            if (linkPath === target || linkPath === targetBase || linkPath + ".md" === target) count++;
          }
          if (count > 0) results.push({ from: relPath, count });
        });
        return { backlinks: results.sort((a, b) => a.from.localeCompare(b.from)) };
      }
      case "vault.batch": {
        if (!Array.isArray(p.operations)) throw { code: -32602, message: "operations must be an array" };
        const results = [];
        let succeeded = 0, failed = 0;
        for (let i = 0; i < p.operations.length; i++) {
          const op = p.operations[i];
          if (!op.method?.startsWith("vault.")) throw { code: -32602, message: `Batch only supports vault.* methods (index ${i})` };
          if (op.method === "vault.batch") throw { code: -32602, message: "Recursive batch not allowed" };
          try {
            const params = { ...(op.params || {}) };
            if (p.dryRun !== undefined) params.dryRun = p.dryRun;
            const result = this.dispatch(op.method, params);
            results.push({ index: i, ok: true, result });
            succeeded++;
          } catch (err) {
            results.push({ index: i, ok: false, error: { code: err.code || -32000, message: err.message || String(err) } });
            failed++;
          }
        }
        return { results, summary: { total: p.operations.length, succeeded, failed } };
      }
      case "vault.lint": {
        const requiredFm = Array.isArray(p.requiredFrontmatter) ? p.requiredFrontmatter : [];
        const allFiles = [];
        const linkMap = new Map(); // from -> [{target, count}]
        const inbound = new Set();
        this.walkMd(this.vault, (relPath, content) => {
          const st = fs.statSync(this.resolve(relPath));
          allFiles.push({ path: relPath, size: st.size, content });
          const links = this.parseWikilinks(content);
          const targets = new Map();
          for (const l of links) {
            let t = l.link.endsWith(".md") ? l.link : l.link + ".md";
            targets.set(t, (targets.get(t) || 0) + 1);
          }
          linkMap.set(relPath, targets);
          for (const t of targets.keys()) inbound.add(t);
        });
        const orphans = allFiles.filter(f => !inbound.has(f.path)).map(f => f.path).sort();
        const brokenLinks = [];
        for (const [from, targets] of linkMap) {
          for (const [to] of targets) {
            if (!fs.existsSync(this.resolve(to))) brokenLinks.push({ from, to });
          }
        }
        const emptyFiles = allFiles.filter(f => f.size === 0).map(f => f.path).sort();
        const missingFm = [];
        if (requiredFm.length > 0) {
          for (const f of allFiles) {
            const fm = this.parseFrontmatter(f.content) || {};
            const missing = requiredFm.filter(k => !(k in fm));
            if (missing.length > 0) missingFm.push({ path: f.path, missing });
          }
        }
        const titleMap = new Map();
        for (const f of allFiles) {
          const t = path.basename(f.path, ".md").toLowerCase();
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
      case "vault.externalSearch":
        throw { code: -32000, message: "No external search engine configured" };
      case "listCapabilities":
        return { methods: ["vault.read","vault.create","vault.modify","vault.append","vault.delete","vault.rename","vault.mkdir","vault.search","vault.list","vault.stat","vault.exists","vault.init","vault.getMetadata","vault.searchByTag","vault.searchByFrontmatter","vault.graph","vault.backlinks","vault.batch","vault.lint","vault.externalSearch"], version: VERSION };
      default:
        throw { code: -32601, message: `Unknown method: ${method}` };
    }
  }

  walkMd(dir, fn) {
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory() && ent.name !== ".obsidian" && ent.name !== ".trash" && ent.name !== "node_modules") walk(full);
        else if (ent.isFile() && ent.name.endsWith(".md")) {
          const rel = path.relative(this.vault, full).replace(/\\/g, "/");
          fn(rel, fs.readFileSync(full, "utf-8"));
        }
      }
    };
    walk(dir);
  }

  matchGlob(p, glob) {
    const re = new RegExp("^" + glob.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".") + "$");
    return re.test(p);
  }

  close() {}
}

// --- MCP stdio protocol ---

async function main() {
  const info = readPortFile();
  let transport;

  if (info) {
    try {
      const ws = new WsTransport(info);
      await ws.connect();
      transport = ws;
      process.stderr.write(`vault-bridge: connected to Obsidian WS on port ${info.port}\n`);
    } catch (err) {
      process.stderr.write(`vault-bridge: WS unavailable (${err.message}), using filesystem fallback\n`);
      transport = new FsTransport(info.vault);
    }
  } else {
    // No port file -- try to find vault path from args or env
    const vaultPath = process.argv[2] || process.env.VAULT_BRIDGE_VAULT || "";
    if (!vaultPath) {
      process.stderr.write("vault-bridge: no port file and no vault path. Pass vault path as first argument.\n");
      process.exit(1);
    }
    transport = new FsTransport(vaultPath);
    process.stderr.write(`vault-bridge: filesystem mode on ${vaultPath}\n`);
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    const { method, params, id } = req;

    // MCP protocol methods
    if (method === "initialize") {
      write({ jsonrpc: "2.0", id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "vault-bridge", version: VERSION }
      }});
      return;
    }

    if (method === "notifications/initialized") return; // no response needed

    if (method === "tools/list") {
      write({ jsonrpc: "2.0", id, result: { tools: getToolDefinitions() } });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const resp = await transport.call(toolName, toolArgs, id);
      if (resp.error) {
        write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${resp.error.message}` }], isError: true } });
      } else {
        write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(resp.result, null, 2) }] } });
      }
      return;
    }

    write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
  });

  rl.on("close", () => { transport.close(); process.exit(0); });
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function getToolDefinitions() {
  return [
    { name: "vault.read", description: "Read a note's content", inputSchema: { type: "object", properties: { path: { type: "string", description: "Vault-relative path" } }, required: ["path"] } },
    { name: "vault.create", description: "Create a new note (dry-run by default)", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string", default: "" }, dryRun: { type: "boolean", default: true } }, required: ["path"] } },
    { name: "vault.modify", description: "Overwrite an existing note (dry-run by default)", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, dryRun: { type: "boolean", default: true } }, required: ["path", "content"] } },
    { name: "vault.append", description: "Append content to an existing note", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, dryRun: { type: "boolean", default: true } }, required: ["path", "content"] } },
    { name: "vault.delete", description: "Delete a note or folder", inputSchema: { type: "object", properties: { path: { type: "string" }, force: { type: "boolean", default: false }, dryRun: { type: "boolean", default: true } }, required: ["path"] } },
    { name: "vault.rename", description: "Rename/move a file", inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, dryRun: { type: "boolean", default: true } }, required: ["from", "to"] } },
    { name: "vault.mkdir", description: "Create a directory", inputSchema: { type: "object", properties: { path: { type: "string" }, dryRun: { type: "boolean", default: true } }, required: ["path"] } },
    { name: "vault.search", description: "Fulltext search across vault markdown files", inputSchema: { type: "object", properties: { query: { type: "string" }, regex: { type: "boolean", default: false }, caseSensitive: { type: "boolean", default: false }, maxResults: { type: "integer", default: 50 }, glob: { type: "string" }, context: { type: "integer", default: 1 } }, required: ["query"] } },
    { name: "vault.list", description: "List files and folders in a directory", inputSchema: { type: "object", properties: { path: { type: "string", default: "" } } } },
    { name: "vault.stat", description: "Get file/folder metadata", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "vault.exists", description: "Check if a path exists", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "vault.init", description: "Scaffold a new knowledge base topic with raw/, wiki/, schema/, Log.md, kb.yaml", inputSchema: { type: "object", properties: { topic: { type: "string", description: "Topic name for the knowledge base" } }, required: ["topic"] } },
    { name: "vault.getMetadata", description: "Get parsed metadata (frontmatter, links, tags, headings) for a note", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "vault.searchByTag", description: "Find all notes with a given tag", inputSchema: { type: "object", properties: { tag: { type: "string", description: "Tag to search for (with or without #)" } }, required: ["tag"] } },
    { name: "vault.searchByFrontmatter", description: "Find notes by frontmatter key/value with optional comparison operator", inputSchema: { type: "object", properties: { key: { type: "string" }, value: {}, op: { type: "string", enum: ["eq","ne","gt","lt","gte","lte","contains","regex","exists"], default: "eq" } }, required: ["key"] } },
    { name: "vault.graph", description: "Get the link graph (nodes, edges, orphans) of the vault", inputSchema: { type: "object", properties: { type: { type: "string", enum: ["resolved","unresolved","both"], default: "both" } } } },
    { name: "vault.backlinks", description: "Find all notes that link to a given note", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "vault.batch", description: "Execute multiple vault operations in a single round-trip", inputSchema: { type: "object", properties: { operations: { type: "array", items: { type: "object", properties: { method: { type: "string" }, params: { type: "object" } }, required: ["method"] } }, dryRun: { type: "boolean" } }, required: ["operations"] } },
    { name: "vault.lint", description: "Check vault health: orphans, broken links, empty files, missing frontmatter, duplicate titles", inputSchema: { type: "object", properties: { requiredFrontmatter: { type: "array", items: { type: "string" }, description: "Frontmatter keys that every note should have" } } } },
    { name: "vault.externalSearch", description: "Search via external search engine (requires configuration)", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  ];
}

main().catch((err) => { process.stderr.write(`vault-bridge: fatal: ${err.message}\n`); process.exit(1); });
