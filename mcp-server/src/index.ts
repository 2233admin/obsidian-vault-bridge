#!/usr/bin/env node
/**
 * vault-mind MCP server -- stdio transport
 * Unified vault operations, compilation, and query via @modelcontextprotocol/sdk.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  readFileSync, existsSync, readdirSync, statSync,
  rmSync, renameSync, mkdirSync,
} from "node:fs";
import { resolve, join, basename, extname, relative, dirname, sep } from "node:path";

import { FilesystemAdapter } from "./adapters/filesystem.js";
import { AdapterRegistry } from "./adapters/registry.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface VaultMindConfig {
  vault_path: string;
  auth_token?: string;
  adapters?: string[];
}

function loadConfig(): VaultMindConfig {
  const candidates = [
    resolve(process.cwd(), "vault-mind.yaml"),
    resolve(process.cwd(), "../vault-mind.yaml"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return parseSimpleYaml(readFileSync(p, "utf-8"));
    }
  }
  const vaultPath = process.env.VAULT_MIND_VAULT_PATH || process.env.VAULT_BRIDGE_VAULT || "";
  if (!vaultPath) throw new Error("No vault-mind.yaml found and VAULT_MIND_VAULT_PATH not set");
  return { vault_path: vaultPath, auth_token: process.env.VAULT_MIND_AUTH_TOKEN };
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
  return {
    vault_path: result["vault_path"] || "",
    auth_token: result["auth_token"],
    adapters: result["adapters"]?.split(",").map((s) => s.trim()),
  };
}

// ---------------------------------------------------------------------------
// Vault helpers
// ---------------------------------------------------------------------------

const PROTECTED_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

function resolveVaultPath(vaultPath: string, p: string): string {
  const basePath = vaultPath.endsWith(sep) ? vaultPath : vaultPath + sep;
  const resolved = join(vaultPath, p);
  if (resolved !== vaultPath && !resolved.startsWith(basePath)) {
    throw new Error(`Path traversal blocked: ${p}`);
  }
  return resolved;
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, ent.name);
    if (ent.isDirectory() && !PROTECTED_DIRS.has(ent.name)) {
      results.push(...walkDir(fullPath));
    } else if (ent.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  const re = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    links.push(m[1].trim());
  }
  return links;
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

function parseFrontmatter(content: string): Record<string, unknown> {
  const fm: Record<string, unknown> = {};
  if (!content.startsWith("---")) return fm;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return fm;
  const block = content.slice(4, end);
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
    if (rawVal === "") {
      inArray = true;
      arrayItems = [];
      continue;
    }
    if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      fm[key] = rawVal.slice(1, -1).split(",").map((s) => parseYamlValue(s.trim()));
    } else {
      fm[key] = parseYamlValue(rawVal);
    }
  }
  if (inArray && currentKey) fm[currentKey] = arrayItems;
  return fm;
}

function wikilinkToPath(link: string): string {
  const withExt = link.endsWith(".md") ? link : link + ".md";
  return withExt.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "vault.read",
    description: "Read a file from the vault.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "vault.create",
    description: "Create a new file in the vault. Fails if the file already exists.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "vault.modify",
    description: "Overwrite an existing file in the vault.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "vault.append",
    description: "Append content to a file. Creates the file if it does not exist.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "vault.delete",
    description: "Delete a file from the vault.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "vault.rename",
    description: "Rename or move a file within the vault.",
    inputSchema: {
      type: "object",
      properties: { oldPath: { type: "string" }, newPath: { type: "string" } },
      required: ["oldPath", "newPath"],
    },
  },
  {
    name: "vault.search",
    description: "Full-text search across vault files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        glob: { type: "string" },
        maxResults: { type: "number" },
        caseSensitive: { type: "boolean" },
        context: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "vault.searchByTag",
    description: "Find notes that have a specific tag in their YAML frontmatter.",
    inputSchema: {
      type: "object",
      properties: { tag: { type: "string" } },
      required: ["tag"],
    },
  },
  {
    name: "vault.searchByFrontmatter",
    description: "Find notes where a frontmatter key contains a value.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, value: { type: "string" } },
      required: ["key", "value"],
    },
  },
  {
    name: "vault.graph",
    description: "Build a wikilink graph of all .md files. Returns nodes and edges.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vault.backlinks",
    description: "Find all files that link to the given path via wikilinks.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "vault.batch",
    description: "Execute an array of vault operations sequentially.",
    inputSchema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: { tool: { type: "string" }, args: { type: "object" } },
            required: ["tool", "args"],
          },
        },
      },
      required: ["operations"],
    },
  },
  {
    name: "vault.lint",
    description: "Check vault for broken wikilinks, orphan files, and missing frontmatter.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vault.list",
    description: "List files and directories within a vault path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
      },
    },
  },
  {
    name: "vault.stat",
    description: "Get metadata (size, mtime, type) for a vault path.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "vault.exists",
    description: "Check whether a path exists in the vault.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "compile.run",
    description: "Run the KB compiler pipeline (stub).",
    inputSchema: { type: "object", properties: { target: { type: "string" } } },
  },
  {
    name: "query.semantic",
    description: "Semantic search over compiled embeddings (stub).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, topK: { type: "number" } },
      required: ["query"],
    },
  },
  {
    name: "agent.status",
    description: "Get the status of running agent tasks (stub).",
    inputSchema: { type: "object", properties: {} },
  },
];

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toolErr(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatch(
  tool: string,
  args: Record<string, unknown>,
  vaultPath: string,
  registry: AdapterRegistry,
): Promise<ReturnType<typeof ok>> {
  const fs = registry.getDefault();

  switch (tool) {
    case "vault.read": {
      const path = String(args["path"]);
      const content = await fs.read!(path);
      return ok({ path, content });
    }

    case "vault.create": {
      const path = String(args["path"]);
      const content = String(args["content"]);
      const fullPath = resolveVaultPath(vaultPath, path);
      if (existsSync(fullPath)) throw new Error(`File already exists: ${path}`);
      mkdirSync(dirname(fullPath), { recursive: true });
      await fs.write!(path, content);
      return ok({ path, created: true });
    }

    case "vault.modify": {
      const path = String(args["path"]);
      const content = String(args["content"]);
      const fullPath = resolveVaultPath(vaultPath, path);
      if (!existsSync(fullPath)) throw new Error(`File not found: ${path}`);
      await fs.write!(path, content);
      return ok({ path, modified: true });
    }

    case "vault.append": {
      const path = String(args["path"]);
      const content = String(args["content"]);
      const fullPath = resolveVaultPath(vaultPath, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      const existing = existsSync(fullPath) ? await fs.read!(path) : "";
      await fs.write!(path, existing + content);
      return ok({ path, appended: true });
    }

    case "vault.delete": {
      const path = String(args["path"]);
      const fullPath = resolveVaultPath(vaultPath, path);
      if (!existsSync(fullPath)) throw new Error(`Path not found: ${path}`);
      rmSync(fullPath, { recursive: false });
      return ok({ path, deleted: true });
    }

    case "vault.rename": {
      const oldPath = String(args["oldPath"]);
      const newPath = String(args["newPath"]);
      const fullOld = resolveVaultPath(vaultPath, oldPath);
      const fullNew = resolveVaultPath(vaultPath, newPath);
      if (!existsSync(fullOld)) throw new Error(`Source not found: ${oldPath}`);
      if (existsSync(fullNew)) throw new Error(`Destination already exists: ${newPath}`);
      mkdirSync(dirname(fullNew), { recursive: true });
      renameSync(fullOld, fullNew);
      return ok({ oldPath, newPath, renamed: true });
    }

    case "vault.search": {
      const query = String(args["query"]);
      const results = await fs.search!(query, {
        glob: args["glob"] != null ? String(args["glob"]) : undefined,
        maxResults: args["maxResults"] != null ? Number(args["maxResults"]) : 20,
        caseSensitive: Boolean(args["caseSensitive"]),
        context: args["context"] != null ? Number(args["context"]) : 0,
      });
      return ok({ query, results });
    }

    case "vault.searchByTag": {
      const tag = String(args["tag"]).replace(/^#/, "");
      const matches: Array<{ path: string; tags: unknown[] }> = [];
      for (const absPath of walkDir(vaultPath).filter((f) => extname(f) === ".md")) {
        const content = readFileSync(absPath, "utf-8");
        const fm = parseFrontmatter(content);
        const rawTags = fm["tags"];
        let tags: string[] = [];
        if (Array.isArray(rawTags)) {
          tags = rawTags.map((t) => String(t).replace(/^#/, "").trim());
        } else if (typeof rawTags === "string") {
          tags = rawTags
            .replace(/[\[\]]/g, "")
            .split(/[,\s]+/)
            .map((t) => t.replace(/^#/, "").trim())
            .filter(Boolean);
        }
        if (tags.includes(tag)) {
          matches.push({ path: relative(vaultPath, absPath).replace(/\\/g, "/"), tags });
        }
      }
      return ok({ tag, matches });
    }

    case "vault.searchByFrontmatter": {
      const key = String(args["key"]);
      const value = String(args["value"]);
      const matches: Array<{ path: string; frontmatter: Record<string, unknown> }> = [];
      for (const absPath of walkDir(vaultPath).filter((f) => extname(f) === ".md")) {
        const content = readFileSync(absPath, "utf-8");
        const fm = parseFrontmatter(content);
        if (fm[key] !== undefined && String(fm[key]).includes(value)) {
          matches.push({ path: relative(vaultPath, absPath).replace(/\\/g, "/"), frontmatter: fm });
        }
      }
      return ok({ key, value, matches });
    }

    case "vault.graph": {
      const mdFiles = walkDir(vaultPath).filter((f) => extname(f) === ".md");
      const pathSet = new Set(mdFiles.map((f) => relative(vaultPath, f).replace(/\\/g, "/")));
      const nodes: Array<{ path: string; title: string }> = [];
      const edges: Array<{ from: string; to: string; type: "link" }> = [];
      for (const absPath of mdFiles) {
        const relPath = relative(vaultPath, absPath).replace(/\\/g, "/");
        const content = readFileSync(absPath, "utf-8");
        const fm = parseFrontmatter(content);
        nodes.push({ path: relPath, title: fm["title"] != null ? String(fm["title"]) : basename(absPath, ".md") });
        for (const link of extractWikilinks(content)) {
          const target = wikilinkToPath(link);
          if (pathSet.has(target)) edges.push({ from: relPath, to: target, type: "link" });
        }
      }
      return ok({ nodes, edges });
    }

    case "vault.backlinks": {
      const targetPath = String(args["path"]).replace(/\\/g, "/");
      const targetStem = basename(targetPath, ".md");
      const backlinks: string[] = [];
      for (const absPath of walkDir(vaultPath).filter((f) => extname(f) === ".md")) {
        const relPath = relative(vaultPath, absPath).replace(/\\/g, "/");
        if (relPath === targetPath) continue;
        const content = readFileSync(absPath, "utf-8");
        if (extractWikilinks(content).some((l) => l === targetStem || wikilinkToPath(l) === targetPath)) {
          backlinks.push(relPath);
        }
      }
      return ok({ path: targetPath, backlinks });
    }

    case "vault.batch": {
      const operations = args["operations"] as Array<{ tool: string; args: Record<string, unknown> }>;
      if (!Array.isArray(operations)) throw new Error("operations must be an array");
      const results: unknown[] = [];
      for (const op of operations) {
        try {
          const result = await dispatch(op.tool, op.args, vaultPath, registry);
          results.push({ ok: true, result: JSON.parse(result.content[0].text) });
        } catch (e: unknown) {
          results.push({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return ok({ results });
    }

    case "vault.lint": {
      const mdFiles = walkDir(vaultPath).filter((f) => extname(f) === ".md");
      const pathSet = new Set(mdFiles.map((f) => relative(vaultPath, f).replace(/\\/g, "/")));
      const linkedFiles = new Set<string>();
      const brokenLinks: Array<{ file: string; link: string }> = [];
      const missingFrontmatter: string[] = [];
      for (const absPath of mdFiles) {
        const relPath = relative(vaultPath, absPath).replace(/\\/g, "/");
        const content = readFileSync(absPath, "utf-8");
        if (Object.keys(parseFrontmatter(content)).length === 0) missingFrontmatter.push(relPath);
        for (const link of extractWikilinks(content)) {
          const target = wikilinkToPath(link);
          linkedFiles.add(target);
          if (!pathSet.has(target)) brokenLinks.push({ file: relPath, link });
        }
      }
      const orphans = [...pathSet].filter(
        (p) => !linkedFiles.has(p) && basename(p, ".md").toLowerCase() !== "index",
      );
      return ok({
        totalFiles: walkDir(vaultPath).length,
        mdFiles: mdFiles.length,
        brokenLinks,
        orphans,
        missingFrontmatter,
      });
    }

    case "vault.list": {
      const dirPath = args["path"] != null ? String(args["path"]) : "";
      const recursive = Boolean(args["recursive"]);
      const fullDir = dirPath ? resolveVaultPath(vaultPath, dirPath) : vaultPath;
      if (!existsSync(fullDir)) throw new Error(`Directory not found: ${dirPath || "/"}`);
      let entries: Array<{ name: string; path: string; type: "file" | "directory"; size?: number }>;
      if (recursive) {
        entries = walkDir(fullDir).map((absPath) => ({
          name: basename(absPath),
          path: relative(vaultPath, absPath).replace(/\\/g, "/"),
          type: "file" as const,
          size: statSync(absPath).size,
        }));
      } else {
        entries = readdirSync(fullDir, { withFileTypes: true }).map((d) => {
          const absPath = join(fullDir, d.name);
          const type = d.isDirectory() ? ("directory" as const) : ("file" as const);
          const entry: { name: string; path: string; type: "file" | "directory"; size?: number } = {
            name: d.name,
            path: relative(vaultPath, absPath).replace(/\\/g, "/"),
            type,
          };
          if (type === "file") entry.size = statSync(absPath).size;
          return entry;
        });
      }
      return ok({ path: dirPath || "/", entries });
    }

    case "vault.stat": {
      const path = String(args["path"]);
      const fullPath = resolveVaultPath(vaultPath, path);
      if (!existsSync(fullPath)) throw new Error(`Path not found: ${path}`);
      const st = statSync(fullPath);
      return ok({
        path,
        type: st.isDirectory() ? "directory" : "file",
        size: st.size,
        mtime: st.mtime.toISOString(),
        ctime: st.ctime.toISOString(),
      });
    }

    case "vault.exists": {
      const path = String(args["path"]);
      return ok({ path, exists: existsSync(resolveVaultPath(vaultPath, path)) });
    }

    case "compile.run":
      return ok({ status: "not_implemented", message: "compile.run is a stub" });

    case "query.semantic":
      return ok({ status: "not_implemented", message: "query.semantic is a stub" });

    case "agent.status":
      return ok({ status: "not_implemented", message: "agent.status is a stub" });

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = loadConfig();
  const vaultPath = resolve(config.vault_path);

  if (!existsSync(vaultPath)) throw new Error(`Vault path does not exist: ${vaultPath}`);

  const registry = new AdapterRegistry();
  const fsAdapter = new FilesystemAdapter(vaultPath);
  await fsAdapter.init();
  registry.register(fsAdapter);

  const server = new Server(
    { name: "vault-mind", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    if (config.auth_token) {
      const token = (args as Record<string, unknown>)["_auth_token"];
      if (token !== config.auth_token) return toolErr("Unauthorized: invalid or missing _auth_token");
    }

    try {
      return await dispatch(name, args as Record<string, unknown>, vaultPath, registry);
    } catch (e: unknown) {
      return toolErr(e instanceof Error ? e.message : String(e));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
