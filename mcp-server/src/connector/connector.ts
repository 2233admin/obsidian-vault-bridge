import readline from 'node:readline';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { operations } from '../core/operations.js';
import { WsTransport } from './ws-transport.js';
import { FsTransport } from './fs-transport.js';
import type { OperationContext, Logger, VaultExecutor } from '../core/types.js';
import { validateParams } from '../core/validate.js';

const PORT_FILE = path.join(os.homedir(), '.obsidian-ws-port');
const VERSION = '0.3.0';

function readPortFile(): { port: number; token: string; vault: string } | null {
  try { return JSON.parse(fs.readFileSync(PORT_FILE, 'utf-8')); }
  catch { return null; }
}

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// vault.* operations only — connector doesn't serve compile/query/agent
const vaultOps = operations.filter(op => op.namespace === 'vault');

async function main(): Promise<void> {
  const info = readPortFile();
  let transport: WsTransport | FsTransport;

  if (info) {
    try {
      const ws = new WsTransport(info);
      await ws.connect();
      transport = ws;
      process.stderr.write(`vault-mind connector: WS on port ${info.port}\n`);
    } catch (e: unknown) {
      const msg = (e as Error).message;
      process.stderr.write(`vault-mind connector: WS failed (${msg}), filesystem fallback\n`);
      transport = new FsTransport(info.vault);
    }
  } else {
    const vaultPath = process.argv[2] || process.env['VAULT_BRIDGE_VAULT'] || '';
    if (!vaultPath) {
      process.stderr.write('vault-mind connector: no port file and no vault path\n');
      process.exit(1);
    }
    transport = new FsTransport(vaultPath);
    process.stderr.write(`vault-mind connector: filesystem mode on ${vaultPath}\n`);
  }

  const logger: Logger = {
    info: (msg) => process.stderr.write(`[INFO] ${msg}\n`),
    warn: (msg) => process.stderr.write(`[WARN] ${msg}\n`),
    error: (msg) => process.stderr.write(`[ERROR] ${msg}\n`),
  };

  const vaultPath = transport instanceof FsTransport ? transport.vaultPath : (info?.vault ?? '');

  const ctx: OperationContext = {
    vault: transport as VaultExecutor,
    adapters: null,
    config: { vault_path: vaultPath },
    logger,
    dryRun: false,
  };

  const toolDefs = vaultOps.map(op => ({
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

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    try {
      if (!line.trim()) return;
      let req: { method: string; params?: Record<string, unknown>; id: unknown };
      try {
        req = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }

      const { method, params, id } = req;

      if (method === 'initialize') {
        write({
          jsonrpc: '2.0', id, result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'vault-mind-connector', version: VERSION },
          },
        });
        return;
      }

      if (method === 'notifications/initialized') return;

      if (method === 'tools/list') {
        write({ jsonrpc: '2.0', id, result: { tools: toolDefs } });
        return;
      }

      if (method === 'tools/call') {
        const toolName = (params as { name?: string } | undefined)?.name;
        const toolArgs = ((params as { arguments?: Record<string, unknown> } | undefined)?.arguments) || {};

        const op = vaultOps.find(o => o.name === toolName);
        if (!op) {
          write({
            jsonrpc: '2.0', id, result: {
              content: [{ type: 'text', text: `Error: Unknown tool: ${toolName}` }],
              isError: true,
            },
          });
          return;
        }

        try {
          const validatedArgs = validateParams(op.params, toolArgs as Record<string, unknown>);
          const result = await op.handler(ctx, validatedArgs);
          write({
            jsonrpc: '2.0', id, result: {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            },
          });
        } catch (e: unknown) {
          const ex = e as { message?: string };
          write({
            jsonrpc: '2.0', id, result: {
              content: [{ type: 'text', text: `Error: ${ex.message || String(e)}` }],
              isError: true,
            },
          });
        }
        return;
      }

      write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
    } catch (e) {
      process.stderr.write(`vault-mind connector: internal error: ${(e as Error).message}\n`);
    }
  });

  rl.on('close', () => { transport.close(); process.exit(0); });
}

main().catch((e: Error) => {
  process.stderr.write(`vault-mind connector: fatal: ${e.message}\n`);
  process.exit(1);
});
