/**
 * vault-mind MCP server entry point.
 * stdio transport -- any MCP client can connect.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FilesystemAdapter } from "./adapters/filesystem.js";
import type { VaultMindAdapter } from "./adapters/interface.js";

// --- Config ---

interface VaultMindConfig {
  vault_path: string;
  adapters: Record<string, { enabled: boolean; [k: string]: unknown }>;
  auth?: { token?: string };
}

function loadConfig(): VaultMindConfig {
  const paths = [
    resolve("vault-mind.yaml"),
    resolve("vault-mind.yml"),
  ];
  for (const p of paths) {
    try {
      const raw = readFileSync(p, "utf-8");
      // Minimal YAML parsing -- key: value lines only, no nested objects
      // For production: use a real YAML parser
      return parseSimpleYaml(raw) as unknown as VaultMindConfig;
    } catch { /* try next */ }
  }
  // Fallback: env vars
  const vaultPath = process.env.VAULT_MIND_PATH;
  if (!vaultPath) {
    throw new Error("No vault-mind.yaml found and VAULT_MIND_PATH not set");
  }
  return {
    vault_path: vaultPath,
    adapters: { filesystem: { enabled: true } },
  };
}

function parseSimpleYaml(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (val === "true") result[key] = true;
    else if (val === "false") result[key] = false;
    else if (/^\d+(\.\d+)?$/.test(val)) result[key] = Number(val);
    else if (val) result[key] = val;
  }
  return result;
}

// --- Auth ---

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// --- Tool definitions ---

const VAULT_TOOLS = [
  { name: "vault.read", description: "Read a file from the vault", inputSchema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "vault.create", description: "Create a new file in the vault", inputSchema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" }, dryRun: { type: "boolean" } }, required: ["path", "content"] } },
  { name: "vault.modify", description: "Modify an existing file", inputSchema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" }, dryRun: { type: "boolean" } }, required: ["path", "content"] } },
  { name: "vault.append", description: "Append content to a file", inputSchema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" }, dryRun: { type: "boolean" } }, required: ["path", "content"] } },
  { name: "vault.delete", description: "Delete a file from the vault", inputSchema: { type: "object" as const, properties: { path: { type: "string" }, force: { type: "boolean" }, dryRun: { type: "boolean" } }, required: ["path"] } },
  { name: "vault.search", description: "Search vault content", inputSchema: { type: "object" as const, properties: { query: { type: "string" }, glob: { type: "string" }, maxResults: { type: "number" }, caseSensitive: { type: "boolean" } }, required: ["query"] } },
  { name: "vault.list", description: "List files in a directory", inputSchema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "vault.stat", description: "Get file metadata", inputSchema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "vault.exists", description: "Check if a file exists", inputSchema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } },
];

const COMPILE_TOOLS = [
  { name: "compile.status", description: "Get compilation status (dirty files, last compile time)", inputSchema: { type: "object" as const, properties: {} } },
  { name: "compile.run", description: "Run incremental compilation", inputSchema: { type: "object" as const, properties: { scope: { type: "string", enum: ["incremental", "full"] } } } },
  { name: "compile.diff", description: "Show what needs compilation", inputSchema: { type: "object" as const, properties: {} } },
  { name: "compile.abort", description: "Abort running compilation", inputSchema: { type: "object" as const, properties: {} } },
];

const QUERY_TOOLS = [
  { name: "query.unified", description: "Search across all adapters with fused ranking", inputSchema: { type: "object" as const, properties: { query: { type: "string" }, maxResults: { type: "number" } }, required: ["query"] } },
  { name: "query.explain", description: "Explain a concept from compiled knowledge", inputSchema: { type: "object" as const, properties: { concept: { type: "string" } }, required: ["concept"] } },
];

const AGENT_TOOLS = [
  { name: "agent.status", description: "Get vault agent state (dirty count, days since emerge, etc.)", inputSchema: { type: "object" as const, properties: {} } },
  { name: "agent.trigger", description: "Manually trigger an agent action", inputSchema: { type: "object" as const, properties: { action: { type: "string", enum: ["compile", "emerge", "reconcile", "prune", "challenge"] } }, required: ["action"] } },
  { name: "agent.history", description: "Get recent agent action history", inputSchema: { type: "object" as const, properties: { limit: { type: "number" } } } },
];

const ALL_TOOLS = [...VAULT_TOOLS, ...COMPILE_TOOLS, ...QUERY_TOOLS, ...AGENT_TOOLS];

// --- Server ---

async function main() {
  const config = loadConfig();
  const adapters: VaultMindAdapter[] = [];

  // Initialize adapters
  if (config.adapters?.filesystem?.enabled !== false) {
    const fs = new FilesystemAdapter(config.vault_path);
    await fs.init();
    adapters.push(fs);
  }

  // Auth token from config or env
  const authToken = config.auth?.token ?? process.env.VAULT_MIND_TOKEN;

  const server = new Server(
    { name: "vault-mind", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS,
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Auth check (skip if no token configured -- open access)
    if (authToken && args && typeof args === "object") {
      const providedToken = (args as Record<string, unknown>)._token as string | undefined;
      if (providedToken && !timingSafeEqual(providedToken, authToken)) {
        return { content: [{ type: "text" as const, text: "Authentication failed" }], isError: true };
      }
    }

    const fsAdapter = adapters.find(a => a.name === "filesystem");

    try {
      // --- vault.* ---
      if (name === "vault.read" && fsAdapter?.read) {
        const content = await fsAdapter.read((args as { path: string }).path);
        return { content: [{ type: "text" as const, text: content }] };
      }

      if (name === "vault.create" && fsAdapter?.write) {
        const { path, content, dryRun } = args as { path: string; content: string; dryRun?: boolean };
        await fsAdapter.write(path, content, dryRun);
        return { content: [{ type: "text" as const, text: dryRun ? `[dry-run] Would create: ${path}` : `Created: ${path}` }] };
      }

      if (name === "vault.modify" && fsAdapter?.write) {
        const { path, content, dryRun } = args as { path: string; content: string; dryRun?: boolean };
        // Verify file exists before modifying
        if (fsAdapter.read) await fsAdapter.read(path);
        await fsAdapter.write(path, content, dryRun);
        return { content: [{ type: "text" as const, text: dryRun ? `[dry-run] Would modify: ${path}` : `Modified: ${path}` }] };
      }

      if (name === "vault.search" && fsAdapter?.search) {
        const { query, glob, maxResults, caseSensitive } = args as { query: string; glob?: string; maxResults?: number; caseSensitive?: boolean };
        const results = await fsAdapter.search(query, { glob, maxResults, caseSensitive });
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      }

      if (name === "vault.exists" && fsAdapter?.read) {
        const { path } = args as { path: string };
        try {
          await fsAdapter.read(path);
          return { content: [{ type: "text" as const, text: JSON.stringify({ exists: true, path }) }] };
        } catch {
          return { content: [{ type: "text" as const, text: JSON.stringify({ exists: false, path }) }] };
        }
      }

      // --- compile.* (stubs) ---
      if (name.startsWith("compile.")) {
        return { content: [{ type: "text" as const, text: `[stub] ${name} -- compiler not yet implemented` }] };
      }

      // --- query.* (stubs) ---
      if (name.startsWith("query.")) {
        return { content: [{ type: "text" as const, text: `[stub] ${name} -- unified query not yet implemented` }] };
      }

      // --- agent.* (stubs) ---
      if (name.startsWith("agent.")) {
        return { content: [{ type: "text" as const, text: `[stub] ${name} -- agent scheduler not yet implemented` }] };
      }

      return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    }
  });

  // Start
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`vault-mind fatal: ${err}\n`);
  process.exit(1);
});
