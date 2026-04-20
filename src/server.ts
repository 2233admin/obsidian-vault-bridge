import { WebSocketServer, WebSocket } from "ws";
import * as http from "http";
import { timingSafeEqual } from "crypto";
import {
  parseMessage,
  makeResult,
  makeError,
  makeNotification,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  RPC_PERMISSION_DENIED,
} from "./protocol";
import type { ClientState } from "./types";
import { matchGlob } from "./glob";

export interface RpcHandlerContext {
  ws: WebSocket;
  state: ClientState;
}

export type RpcHandler = (
  params: Record<string, unknown>,
  ctx?: RpcHandlerContext,
) => Promise<unknown> | unknown;

export class WsServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Map<WebSocket, ClientState> = new Map();
  private handlers: Map<string, RpcHandler> = new Map();
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(
    private settings: { port: number; token: string },
    private onPortResolved: (port: number) => void,
  ) {
    this.registerHandler("listCapabilities", () => ({
      methods: this.getCapabilityList(),
      version: "0.1.0",
    }));
    this.registerHandler("events.subscribe", (_params, ctx) => {
      if (!ctx) {
        throw { code: RPC_INVALID_PARAMS, message: "Session context required" };
      }
      const patterns = this.requirePatterns(_params);
      ctx.state.subscriptions.push(...patterns);
      return { ok: true, subscriptions: ctx.state.subscriptions };
    });
    this.registerHandler("events.unsubscribe", (_params, ctx) => {
      if (!ctx) {
        throw { code: RPC_INVALID_PARAMS, message: "Session context required" };
      }
      const patterns = new Set(this.requirePatterns(_params));
      ctx.state.subscriptions = ctx.state.subscriptions.filter((pattern) => !patterns.has(pattern));
      return { ok: true, subscriptions: ctx.state.subscriptions };
    });
    this.registerHandler("events.list", (_params, ctx) => {
      if (!ctx) {
        throw { code: RPC_INVALID_PARAMS, message: "Session context required" };
      }
      return { subscriptions: ctx.state.subscriptions, totalClients: this.clients.size };
    });
  }

  start(): void {
    this.httpServer = http.createServer();
    this.httpServer.maxConnections = 50;
    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: 10 * 1024 * 1024, // 10MB
    });

    this.wss.on("connection", (ws: WebSocket) => {
      // reject if too many clients
      if (this.clients.size >= 20) {
        ws.close(4004, "Too many connections");
        ws.terminate();
        return;
      }

      this.clients.set(ws, { authenticated: false, subscriptions: [], isAlive: true });

      const authTimer = setTimeout(() => {
        if (!this.clients.get(ws)?.authenticated) {
          this.clients.delete(ws);
          ws.terminate(); // force-kill, don't wait for graceful close
        }
      }, 5000);

      ws.on("pong", () => {
        const state = this.clients.get(ws);
        if (state) state.isAlive = true;
      });

      ws.on("message", (raw: Buffer) => {
        this.handleMessage(ws, raw, authTimer);
      });

      ws.on("close", () => {
        clearTimeout(authTimer);
        this.clients.delete(ws);
        // No terminate() here -- the socket is already closing by definition.
        // Force-terminate is reserved for the auth-timeout and error paths
        // where the peer is non-responsive.
      });

      ws.on("error", (err) => {
        console.error("LLM Wiki: client error", err.message);
        clearTimeout(authTimer);
        this.clients.delete(ws);
        ws.terminate();
      });
    });

    this.tryListen(this.settings.port, 0);

    // EVNT-03 heartbeat: every 30s, any client that missed the previous
    // pong gets terminated; the rest get a fresh ping. Two consecutive
    // misses -> ~60s of silence -> dead.
    this.pingInterval = setInterval(() => this.heartbeat(), 30_000);
  }

  stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    for (const ws of this.clients.keys()) {
      ws.terminate(); // force-kill all connections
    }
    this.clients.clear();
    this.wss?.close();
    this.httpServer?.close();
    this.wss = null;
    this.httpServer = null;
  }

  private heartbeat(): void {
    for (const [ws, state] of this.clients) {
      if (!state.isAlive) {
        this.clients.delete(ws);
        ws.terminate();
        continue;
      }
      state.isAlive = false;
      try {
        ws.ping();
      } catch {
        // Socket already torn down; next sweep will terminate via !isAlive.
      }
    }
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
      if (!state.authenticated) {
        continue;
      }

      const path = typeof data.path === "string" ? data.path : null;
      if (
        state.subscriptions.length === 0
        || path === null
        || state.subscriptions.some((pattern) => matchGlob(pattern, path))
      ) {
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
      console.error("LLM Wiki: failed to bind after 3 attempts");
      this.wss?.close();
      this.httpServer?.close();
      this.wss = null;
      this.httpServer = null;
      return;
    }

    this.httpServer!.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.warn(`LLM Wiki: port ${port} in use, trying ${port + 1}`);
        this.tryListen(port + 1, attempt + 1);
      } else {
        console.error("LLM Wiki: server error", err);
      }
    });

    this.httpServer!.listen(port, "127.0.0.1", () => {
      const addr = this.httpServer!.address() as { port: number };
      console.log(`LLM Wiki: listening on 127.0.0.1:${addr.port}`);
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
      const result = handler(params ?? {}, { ws, state });
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

  private requirePatterns(params: Record<string, unknown>): string[] {
    const patterns = params.patterns;
    if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string")) {
      throw { code: RPC_INVALID_PARAMS, message: "patterns must be a string array" };
    }
    return patterns;
  }
}
