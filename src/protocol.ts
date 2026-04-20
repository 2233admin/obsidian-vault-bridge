export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id: number | string;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
  meta?: JsonRpcMeta;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcMeta {
  estimatedTokens: number;
}

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_FILE_NOT_FOUND = -32001;
export const RPC_FILE_EXISTS = -32002;
export const RPC_PERMISSION_DENIED = -32003;
export const RPC_DRY_RUN_FAIL = -32004;
export const RPC_SAFETY_PATH_BLOCKED = -32010;
export const RPC_SAFETY_CONTENT_REJECTED = -32011;

export function parseMessage(raw: string): JsonRpcRequest | { error: JsonRpcError } {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { error: { code: RPC_PARSE_ERROR, message: "Parse error" } };
  }

  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { error: { code: RPC_INVALID_REQUEST, message: "Invalid request" } };
  }

  // JSON-RPC 2.0: messages without id are notifications -- must not respond
  if (msg.id === undefined || msg.id === null) {
    return { error: { code: RPC_INVALID_REQUEST, message: "Notifications not supported (id required)" } };
  }

  return msg as JsonRpcRequest;
}

// Successful JSON-RPC responses include a top-level meta block so clients can
// budget response cost without parsing result payloads themselves.
export function makeResult(id: number | string, result: unknown): string {
  const serializedResult = JSON.stringify(result) ?? "null";
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result,
    meta: {
      estimatedTokens: Math.ceil(serializedResult.length / 4),
    },
  });
}

export function makeError(id: number | string | null, code: number, message: string, data?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

export function makeNotification(method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}
