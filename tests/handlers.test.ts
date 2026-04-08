/**
 * Test C: Handler layer -- JSON-RPC response shape
 *
 * Registers handlers on a WsServer, connects a client, authenticates,
 * then dispatches a vault.exists call and verifies the JSON-RPC 2.0
 * response shape (id + result fields).
 *
 * Also verifies vault.read returns { content: string } and that an
 * unknown method returns a method-not-found error.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { WsServer } from "../src/server";
import { VaultBridge } from "../src/bridge";
import { registerHandlers } from "../src/handlers";
import { MockApp } from "./mocks/obsidian";
import { DEFAULT_SETTINGS } from "../src/types";

const TOKEN = "handler-test-token-xyz";

const SEED: Record<string, string> = {
  "wiki/index.md": "# Index\nHello world",
};

function startServerWithHandlers(): Promise<{ server: WsServer; port: number }> {
  return new Promise((resolve) => {
    const app = new MockApp(SEED);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = new VaultBridge(app as any);
    const settings = { ...DEFAULT_SETTINGS, token: TOKEN, dryRunDefault: false };

    const server = new WsServer(
      { port: 0, token: TOKEN },
      (resolvedPort) => resolve({ server, port: resolvedPort }),
    );
    registerHandlers(server, bridge, settings);
    server.start();
  });
}

function connect(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}`);
}

function sendRpc(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
  id: number,
): void {
  ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (e) {
        reject(e);
      }
    });
    ws.once("error", reject);
  });
}

let server: WsServer;
let port: number;
let ws: WebSocket;

beforeEach(async () => {
  ({ server, port } = await startServerWithHandlers());
  ws = connect(port);
  await new Promise<void>((res) => ws.once("open", () => res()));

  // authenticate before each test
  const authMsg = nextMessage(ws);
  sendRpc(ws, "authenticate", { token: TOKEN }, 0);
  await authMsg;
});

afterEach(() => {
  ws.close();
  server.stop();
});

describe("Handler layer JSON-RPC 2.0 response shape", () => {
  it("vault.exists returns JSON-RPC 2.0 response with matching id and result.exists", async () => {
    const msgPromise = nextMessage(ws);
    sendRpc(ws, "vault.exists", { path: "wiki/index.md" }, 42);

    const msg = await msgPromise;

    // JSON-RPC 2.0 shape
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.id).toBe(42);
    expect(msg.error).toBeUndefined();

    // business result
    const result = msg.result as Record<string, unknown>;
    expect(result.exists).toBe(true);
  });

  it("vault.exists returns false for a missing path", async () => {
    const msgPromise = nextMessage(ws);
    sendRpc(ws, "vault.exists", { path: "no-such-file.md" }, 43);

    const msg = await msgPromise;
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.id).toBe(43);
    const result = msg.result as Record<string, unknown>;
    expect(result.exists).toBe(false);
  });

  it("vault.read returns { content } with file body", async () => {
    const msgPromise = nextMessage(ws);
    sendRpc(ws, "vault.read", { path: "wiki/index.md" }, 44);

    const msg = await msgPromise;
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.id).toBe(44);
    expect(msg.error).toBeUndefined();
    const result = msg.result as Record<string, unknown>;
    expect(typeof result.content).toBe("string");
    expect(result.content).toBe("# Index\nHello world");
  });

  it("unknown method returns method-not-found error (-32601)", async () => {
    const msgPromise = nextMessage(ws);
    sendRpc(ws, "vault.doesNotExist", {}, 45);

    const msg = await msgPromise;
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.id).toBe(45);
    expect(msg.error).toBeDefined();
    const err = msg.error as Record<string, unknown>;
    expect(err.code).toBe(-32601); // RPC_METHOD_NOT_FOUND
  });

  // Bug #12 (P3) regression: vault.batch must reject non-string op.method
  // with a clean RPC_INVALID_PARAMS instead of throwing a runtime
  // TypeError from `op.method?.startsWith` when method is e.g. a number.
  it("vault.batch rejects non-string method with RPC_INVALID_PARAMS", async () => {
    const msgPromise = nextMessage(ws);
    // sendRpc helper assumes method is a string; bypass it for the
    // malformed-batch case so we can stuff a number into op.method.
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "vault.batch",
        params: {
          operations: [
            { method: 42 as unknown as string, params: {} },
          ],
        },
        id: 46,
      }),
    );

    const msg = await msgPromise;
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.id).toBe(46);
    // The batch handler returns ok:false per-op rather than an outer error.
    const result = msg.result as { results: Array<{ ok: boolean; error?: { code: number; message: string } }> };
    expect(result.results).toHaveLength(1);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error?.code).toBe(-32602); // RPC_INVALID_PARAMS
    expect(result.results[0].error?.message).toContain("vault.*");
  });
});
