import WebSocket from 'ws';

export interface WsInfo {
  port: number;
  token: string;
  vault: string;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export class WsTransport {
  private port: number;
  private token: string;
  private ws: WebSocket | null = null;
  private pending = new Map<string | number, (msg: JsonRpcResponse) => void>();
  authenticated = false;

  constructor(info: WsInfo) {
    this.port = info.port;
    this.token = info.token;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      const timeout = setTimeout(() => {
        this.ws!.close();
        reject(new Error('WS connect timeout'));
      }, 3000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.ws!.send(JSON.stringify({
          jsonrpc: '2.0', method: 'authenticate',
          params: { token: this.token }, id: '__auth__'
        }));
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString()) as JsonRpcResponse;
        if (msg.id === '__auth__') {
          if ((msg.result as { ok?: boolean } | undefined)?.ok) {
            this.authenticated = true;
            resolve();
          } else {
            reject(new Error('Auth failed'));
          }
          return;
        }
        if (msg.id !== null && msg.id !== undefined) {
          const cb = this.pending.get(msg.id);
          if (cb) { this.pending.delete(msg.id); cb(msg); }
        }
      });

      this.ws.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
      this.ws.on('close', () => {
        this.authenticated = false;
        for (const [id, cb] of this.pending) {
          cb({ jsonrpc: '2.0', id, error: { code: -32000, message: 'WS connection closed' } });
        }
        this.pending.clear();
      });
    });
  }

  call(method: string, params: unknown, id: string | number): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WS call timeout: ${method} (id=${id})`));
      }, 30000);
      this.pending.set(id, (msg: JsonRpcResponse) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
    });
  }

  async execute(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = `exec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const resp = await this.call(method, params, id);
    if (resp.error) {
      const e: { code: number; message: string } = resp.error;
      throw e;
    }
    return resp.result;
  }

  close(): void { if (this.ws) this.ws.close(); }
}
