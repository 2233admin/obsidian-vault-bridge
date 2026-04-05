import { WebSocketServer, WebSocket } from "ws";
import * as http from "http";
import { timingSafeEqual } from "crypto";
import {
  parseMessage,
  makeResult,
  makeError,
  makeNotification,
  RPC_METHOD_NOT_FOUND,
  RPC_PERMISSION_DENIED,
} from "./protocol";
import type { ClientState } from "./types";

export type RpcHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

export class WsServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Map<WebSocket, ClientState> = new Map();
  private handlers: Map<string, RpcHandler> = new Map();

  constructor(
    private settings: { port: number; token: string },
    private onPortResolved: (port: number) => void,
  ) {
    this.registerHandler("listCapabilities", () => ({
      methods: this.getCapabilityList(),
      version: "0.1.0",
    }));
  }

  start(): void {
    this.httpServer = http.createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on("connection", (ws: WebSocket) => {
      this.clients.set(ws, { authenticated: false });

      const authTimer = setTimeout(() => {
        if (!this.clients.get(ws)?.authenticated) {
          ws.close(4001, "Auth timeout");
          this.clients.delete(ws);
        }
      }, 5000);

      ws.on("message", (raw: Buffer) => {
        this.handleMessage(ws, raw, authTimer);
      });

      ws.on("close", () => {
        clearTimeout(authTimer);
        this.clients.delete(ws);
      });

      ws.on("error", (err) => {
        console.error("Vault Bridge: client error", err.message);
        clearTimeout(authTimer);
        this.clients.delete(ws);
      });
    });

    this.tryListen(this.settings.port, 0);
  }

  stop(): void {
    for (const ws of this.clients.keys()) {
      ws.close(1001, "Server shutting down");
    }
    this.clients.clear();
    this.wss?.close();
    this.httpServer?.close();
    this.wss = null;
    this.httpServer = null;
  }

  registerHandler(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  getCapabilityList(): string[] {
    return Array.from(this.handlers.keys());
  }

  getClientCount(): number {
    return this.clients.size;
  }

  isRunning(): boolean {
    return this.wss !== null;
  }

  getHandler(method: string): RpcHandler | undefined {
    return this.handlers.get(method);
  }

  broadcastEvent(event: string, data: Record<string, unknown>): void {
    for (const [ws, state] of this.clients) {
      if (state.authenticated) {
        this.safeSend(ws, makeNotification(event, data));
      }
    }
  }

  private safeSend(ws: WebSocket, data: string): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  private sendError(ws: WebSocket, id: number | string, err: unknown): void {
    if (err && typeof err === "object" && "code" in err && "message" in err) {
      const e = err as { code: number; message: string; data?: unknown };
      this.safeSend(ws, makeError(id, e.code, e.message, e.data));
    } else {
      this.safeSend(ws, makeError(id, -32000, err instanceof Error ? err.message : String(err)));
    }
  }

  private tryListen(port: number, attempt: number): void {
    if (attempt >= 3) {
      console.error("Vault Bridge: failed to bind after 3 attempts");
      this.wss?.close();
      this.httpServer?.close();
      this.wss = null;
      this.httpServer = null;
      return;
    }

    this.httpServer!.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.warn(`Vault Bridge: port ${port} in use, trying ${port + 1}`);
        this.tryListen(port + 1, attempt + 1);
      } else {
        console.error("Vault Bridge: server error", err);
      }
    });

    this.httpServer!.listen(port, "127.0.0.1", () => {
      const addr = this.httpServer!.address() as { port: number };
      console.log(`Vault Bridge: listening on 127.0.0.1:${addr.port}`);
      this.onPortResolved(addr.port);
    });
  }

  private handleMessage(ws: WebSocket, raw: Buffer, authTimer: NodeJS.Timeout): void {
    const state = this.clients.get(ws);
    if (!state) return;

    const parsed = parseMessage(raw.toString());

    if ("error" in parsed) {
      const code = parsed.error.code;
      ws.send(makeError(null, code, parsed.error.message));
      return;
    }

    const { method, params, id } = parsed;

    if (!state.authenticated) {
      clearTimeout(authTimer);

      if (method !== "authenticate") {
        ws.close(4002, "First message must be authenticate");
        this.clients.delete(ws);
        return;
      }

      const clientToken = String((params as Record<string, unknown>)?.token ?? "");
      const expected = Buffer.from(this.settings.token, "utf-8");
      const received = Buffer.from(clientToken, "utf-8");
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
        ws.send(makeError(id, RPC_PERMISSION_DENIED, "Invalid token"));
        ws.close(4003, "Invalid token");
        this.clients.delete(ws);
        return;
      }

      state.authenticated = true;
      ws.send(makeResult(id, {
        ok: true,
        version: "0.1.0",
        capabilities: this.getCapabilityList(),
      }));
      return;
    }

    const handler = this.handlers.get(method);
    if (!handler) {
      ws.send(makeError(id, RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`));
      return;
    }

    try {
      const result = handler(params ?? {});
      if (result instanceof Promise) {
        result
          .then((val) => this.safeSend(ws, makeResult(id, val)))
          .catch((err) => this.sendError(ws, id, err));
      } else {
        ws.send(makeResult(id, result));
      }
    } catch (err) {
      this.sendError(ws, id, err);
    }
  }
}
