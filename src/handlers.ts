import type { WsServer } from "./server";
import type { VaultBridge } from "./bridge";
import type { VaultBridgeSettings } from "./types";
import {
  RPC_INVALID_PARAMS,
  RPC_FILE_NOT_FOUND,
  RPC_FILE_EXISTS,
  RPC_METHOD_NOT_FOUND,
} from "./protocol";

interface RpcError {
  code: number;
  message: string;
}

function validatePath(p: unknown): string {
  if (typeof p !== "string" || !p.trim())
    throw { code: RPC_INVALID_PARAMS, message: "path required" } as RpcError;
  const n = p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");
  if (n.split("/").some((s) => s === ".." || s === "."))
    throw { code: RPC_INVALID_PARAMS, message: "path traversal blocked" } as RpcError;
  return n;
}

function optionalPath(p: unknown): string {
  if (p === undefined || p === null || p === "") return "";
  return validatePath(p);
}

function requireString(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string")
    throw { code: RPC_INVALID_PARAMS, message: `${key} must be a string` } as RpcError;
  return v;
}

function isDryRun(params: Record<string, unknown>, settings: VaultBridgeSettings): boolean {
  if (params.dryRun === false) return false;
  if (params.dryRun === true) return true;
  return settings.dryRunDefault;
}

async function safeExec<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    if (lower.includes("already exist") || lower.includes("file exists"))
      throw { code: RPC_FILE_EXISTS, message: msg } as RpcError;
    if (lower.includes("not found") || lower.includes("no such") || lower.includes("doesn't exist"))
      throw { code: RPC_FILE_NOT_FOUND, message: msg } as RpcError;
    throw { code: -32000, message: msg } as RpcError;
  }
}

export function registerHandlers(
  server: WsServer,
  bridge: VaultBridge,
  settings: VaultBridgeSettings,
): void {
  // -- read-only -------------------------------------------------------

  server.registerHandler("vault.read", async (p) => {
    const path = validatePath(p.path);
    return { content: await bridge.read(path) };
  });

  server.registerHandler("vault.stat", (p) => {
    const path = validatePath(p.path);
    return bridge.stat(path);
  });

  server.registerHandler("vault.list", (p) => {
    const path = optionalPath(p.path);
    return bridge.list(path);
  });

  server.registerHandler("vault.exists", (p) => {
    const path = validatePath(p.path);
    return { exists: bridge.exists(path) };
  });

  // -- write (dry-run gated, TOCTOU-safe via safeExec) -----------------

  server.registerHandler("vault.create", async (p) => {
    const path = validatePath(p.path);
    const content = typeof p.content === "string" ? p.content : "";
    if (isDryRun(p, settings))
      return { dryRun: true, action: "create", path, wouldSucceed: !bridge.exists(path) };
    const created = await safeExec(() => bridge.create(path, content));
    return { ok: true, path: created };
  });

  server.registerHandler("vault.modify", async (p) => {
    const path = validatePath(p.path);
    const content = requireString(p, "content");
    if (isDryRun(p, settings))
      return { dryRun: true, action: "modify", path, wouldSucceed: bridge.exists(path) };
    await safeExec(() => bridge.modify(path, content));
    return { ok: true, path };
  });

  server.registerHandler("vault.append", async (p) => {
    const path = validatePath(p.path);
    const content = requireString(p, "content");
    if (isDryRun(p, settings))
      return { dryRun: true, action: "append", path, wouldSucceed: bridge.exists(path) };
    await safeExec(() => bridge.append(path, content));
    return { ok: true, path };
  });

  server.registerHandler("vault.delete", async (p) => {
    const path = validatePath(p.path);
    const force = p.force === true;
    if (isDryRun(p, settings))
      return { dryRun: true, action: "delete", path, force, wouldSucceed: bridge.exists(path) };
    await safeExec(() => bridge.remove(path, force));
    return { ok: true, path };
  });

  server.registerHandler("vault.rename", async (p) => {
    const from = validatePath(p.from);
    const to = validatePath(p.to);
    if (isDryRun(p, settings))
      return { dryRun: true, action: "rename", from, to, wouldSucceed: bridge.exists(from) && !bridge.exists(to) };
    await safeExec(() => bridge.rename(from, to));
    return { ok: true, from, to };
  });

  server.registerHandler("vault.mkdir", async (p) => {
    const path = validatePath(p.path);
    if (isDryRun(p, settings))
      return { dryRun: true, action: "mkdir", path, wouldSucceed: !bridge.exists(path) };
    await safeExec(() => bridge.mkdir(path));
    return { ok: true, path };
  });

  // -- Phase 3: search, graph, batch -----------------------------------

  server.registerHandler("vault.search", async (p) => {
    const query = requireString(p, "query");
    return bridge.search(query, {
      regex: p.regex === true,
      caseSensitive: p.caseSensitive === true,
      maxResults: typeof p.maxResults === "number" ? p.maxResults : undefined,
      glob: typeof p.glob === "string" ? p.glob : undefined,
      context: typeof p.context === "number" ? p.context : undefined,
    });
  });

  server.registerHandler("vault.getMetadata", (p) => {
    const path = validatePath(p.path);
    const meta = bridge.getMetadata(path);
    if (!meta) throw { code: RPC_FILE_NOT_FOUND, message: `No metadata: ${path}` } as RpcError;
    return meta;
  });

  server.registerHandler("vault.searchByTag", (p) => {
    const tag = requireString(p, "tag");
    return { files: bridge.searchByTag(tag) };
  });

  server.registerHandler("vault.searchByFrontmatter", (p) => {
    const key = requireString(p, "key");
    const op = typeof p.op === "string" ? p.op : undefined;
    if (op) {
      return { files: bridge.searchByFrontmatterAdvanced(key, p.value, op) };
    }
    return { files: bridge.searchByFrontmatter(key, p.value) };
  });

  server.registerHandler("vault.graph", (p) => {
    const type = typeof p.type === "string" ? p.type : "both";
    return bridge.getGraph(type);
  });

  server.registerHandler("vault.backlinks", (p) => {
    const path = validatePath(p.path);
    return { backlinks: bridge.getBacklinks(path) };
  });

  server.registerHandler("vault.batch", async (p) => {
    const ops = p.operations;
    if (!Array.isArray(ops))
      throw { code: RPC_INVALID_PARAMS, message: "operations must be an array" } as RpcError;

    const globalDryRun = p.dryRun;
    const results: Array<{ index: number; ok: boolean; result?: unknown; error?: { code: number; message: string } }> = [];
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] as { method: string; params?: Record<string, unknown> };
      try {
        if (!op.method?.startsWith("vault."))
          throw { code: RPC_INVALID_PARAMS, message: `Batch only supports vault.* methods (index ${i})` };
        if (op.method === "vault.batch")
          throw { code: RPC_INVALID_PARAMS, message: "Recursive batch not allowed" };
        const handler = server.getHandler(op.method);
        if (!handler) throw { code: RPC_METHOD_NOT_FOUND, message: `Unknown: ${op.method}` };
        const params = { ...(op.params ?? {}) };
        if (globalDryRun !== undefined) params.dryRun = globalDryRun;
        const result = await Promise.resolve(handler(params));
        results.push({ index: i, ok: true, result });
        succeeded++;
      } catch (err: any) {
        results.push({
          index: i,
          ok: false,
          error: { code: err?.code ?? -32000, message: err?.message ?? String(err) },
        });
        failed++;
      }
    }

    return { results, summary: { total: ops.length, succeeded, failed } };
  });

  // -- init (idempotent scaffold) ----------------------------------------

  server.registerHandler("vault.init", async (p) => {
    const topic = typeof p.topic === "string" ? p.topic.trim() : "";
    if (!topic)
      throw { code: RPC_INVALID_PARAMS, message: "topic required" } as RpcError;
    // validate topic like a path -- block traversal and protected dirs
    validatePath(topic);

    const created: string[] = [];
    const skipped: string[] = [];

    async function ensureDir(path: string): Promise<void> {
      if (bridge.exists(path)) { skipped.push(path); return; }
      await bridge.mkdir(path);
      created.push(path);
    }

    async function ensureFile(path: string, content: string): Promise<void> {
      const p2 = path.endsWith(".md") ? path : path + ".md";
      if (bridge.exists(p2)) {
        skipped.push(p2);
        return;
      }
      await bridge.create(p2, content);
      created.push(p2);
    }

    const base = topic;
    const now = new Date().toISOString().slice(0, 10);

    // directories
    await ensureDir(base);
    for (const sub of ["raw", "raw/articles", "raw/papers", "raw/notes", "raw/transcripts", "wiki", "wiki/summaries", "wiki/concepts", "wiki/queries", "schema"]) {
      await ensureDir(`${base}/${sub}`);
    }

    // _index.md
    await ensureFile(`${base}/wiki/_index.md`, `---\ntopic: "${topic}"\nupdated: ${now}\n---\n\n# ${topic} -- Knowledge Index\n\nNo articles compiled yet. Run \`compile\` after adding sources to \`raw/\`.\n`);

    // _sources.md
    await ensureFile(`${base}/wiki/_sources.md`, `---\ntopic: "${topic}"\nupdated: ${now}\n---\n\n# Sources\n\nNo sources compiled yet.\n`);

    // _categories.md
    await ensureFile(`${base}/wiki/_categories.md`, `---\ntopic: "${topic}"\nupdated: ${now}\n---\n\n# Categories\n\nCategories will be auto-generated during compilation.\n`);

    // Log.md
    await ensureFile(`${base}/Log.md`, `# ${topic} -- Operation Log\n\n- ${now}: KB initialized via vault.init\n`);

    // schema/CLAUDE.md
    const schemaContent = `# ${topic} -- KB Schema\n\nThis knowledge base follows the vault-bridge opinionated workflow.\nSee the root CLAUDE.md for full workflow documentation.\n\n## Topic Config\n\n- Topic: ${topic}\n- Raw sources: raw/articles/, raw/papers/, raw/notes/, raw/transcripts/\n- Compiled wiki: wiki/summaries/, wiki/concepts/\n- Queries: wiki/queries/\n\n## Conventions\n\n- All internal links use [[wikilinks]]\n- Every compiled article has a coverage tag (high/medium/low)\n- Index files (_index.md, _sources.md, _categories.md) are auto-maintained\n`;
    await ensureFile(`${base}/schema/CLAUDE.md`, schemaContent);

    // kb.yaml
    const kbYaml = `topic: "${topic}"\nvault_path: "${bridge.getVaultPath().replace(/\\\\/g, "/")}"\nraw_dir: "${base}/raw"\nwiki_dir: "${base}/wiki"\noutput_formats:\n  - markdown\nmaintenance: manual\ncreated: ${now}\n`;
    if (bridge.exists(`${base}/kb.yaml`)) {
      skipped.push(`${base}/kb.yaml`);
    } else {
      await bridge.create(`${base}/kb.yaml`, kbYaml);
      created.push(`${base}/kb.yaml`);
    }

    return { ok: true, topic, created, skipped, summary: `Created ${created.length}, skipped ${skipped.length} (already exist)` };
  });

  server.registerHandler("vault.lint", (p) => {
    const requiredFm = Array.isArray(p.requiredFrontmatter) ? p.requiredFrontmatter as string[] : [];
    return bridge.lint(requiredFm);
  });

  server.registerHandler("vault.externalSearch", () => {
    throw { code: -32000, message: "No external search engine configured" } as RpcError;
  });
}
