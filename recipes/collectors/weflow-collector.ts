#!/usr/bin/env bun
/**
 * weflow-collector.ts -- WeFlow HTTP gateway -> vault digest
 *
 * Fetches WeChat messages from a local WeFlow HTTP gateway and writes
 * a dated digest to ~/.vault-mind/recipes/weflow-to-vault/digests/.
 *
 * WeFlow is a local WeChat HTTP API gateway that receives WeChat PC messages
 * and exposes a query API. Endpoint paths vary across implementations; this
 * collector tries primary and fallback URLs for both room discovery and
 * message history.
 *
 * Usage:
 *   bun run recipes/collectors/weflow-collector.ts
 *
 * Environment:
 *   WEFLOW_URL           - default http://localhost:9898
 *   WEFLOW_TOKEN         - optional; sets Authorization: Bearer <token> if provided
 *   WEFLOW_ROOMS         - optional comma-separated room IDs; omit = auto-discover
 *   WEFLOW_LOOKBACK_SECS - default 3600
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// -- Types -------------------------------------------------------------------

interface RoomInfo {
  id: string;
  name: string;
  type: 'group' | 'contact' | string;
}

interface WeFlowMessage {
  id: string;
  room_id: string;
  sender: string;
  content: string;
  type: string;
  time: number; // Unix seconds
}

interface RoomState {
  since_time: number; // Unix seconds
  last_run?: string;
  room_name?: string;
}

interface CollectorState {
  rooms: Record<string, RoomState>;
  last_run?: string;
}

interface CollectorStats {
  rooms_scanned: number;
  rooms_with_new: number;
  messages: number;
}

// -- Config ------------------------------------------------------------------

const BASE_URL = (process.env.WEFLOW_URL ?? 'http://localhost:9898').replace(/\/$/, '');
const WEFLOW_TOKEN = process.env.WEFLOW_TOKEN ?? '';
const ROOMS_ENV = process.env.WEFLOW_ROOMS;
const LOOKBACK_SECS = parseInt(process.env.WEFLOW_LOOKBACK_SECS ?? '3600', 10);

const OUTPUT_DIR = join(homedir(), '.vault-mind', 'recipes', 'weflow-to-vault');
const DIGESTS_DIR = join(OUTPUT_DIR, 'digests');
const STATE_FILE = join(OUTPUT_DIR, 'state.json');
const HEARTBEAT_FILE = join(OUTPUT_DIR, 'heartbeat.jsonl');

const DIGEST_TAIL = 30;

// -- HTTP helpers ------------------------------------------------------------

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (WEFLOW_TOKEN) headers['Authorization'] = `Bearer ${WEFLOW_TOKEN}`;
  return headers;
}

/**
 * Two-attempt GET: try primaryPath first; if 404, try fallbackPath.
 * Returns [responseBody, pathUsed] or throws if both fail non-404.
 */
async function tryGet<T>(
  primaryPath: string,
  fallbackPath: string,
  params?: Record<string, string>,
): Promise<[T, string]> {
  const headers = buildHeaders();

  for (const path of [primaryPath, fallbackPath]) {
    const url = new URL(`${BASE_URL}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }

    let resp: Response;
    try {
      resp = await fetch(url.toString(), { headers });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `WeFlow server at ${BASE_URL} not responding: ${msg}\n` +
        `Default port is 9898. Check that WeFlow is running and listening on ${BASE_URL}.`,
      );
    }

    if (resp.status === 404) {
      // Try next path
      continue;
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} from ${path}`);
    }

    const body = await resp.json() as T;
    return [body, path];
  }

  throw new Error(
    `Both endpoints returned 404:\n  ${primaryPath}\n  ${fallbackPath}\n` +
    'Your WeFlow implementation may use different paths. Check its documentation.',
  );
}

// -- API queries -------------------------------------------------------------

interface RoomsResponse {
  code: number;
  data: RoomInfo[];
}

interface ContactsResponse {
  code: number;
  data: Array<{ id: string; name: string; type?: string }>;
}

async function discoverRooms(): Promise<RoomInfo[]> {
  let rooms: RoomInfo[];

  try {
    const [body] = await tryGet<RoomsResponse>('/api/rooms', '/api/contacts');
    // /api/contacts may use slightly different shape but we normalize below
    const raw = (body as RoomsResponse | ContactsResponse).data ?? [];
    rooms = raw.map((r: RoomInfo | { id: string; name: string; type?: string }) => ({
      id: r.id,
      name: (r as RoomInfo).name ?? r.id,
      type: (r as RoomInfo).type ?? 'group',
    }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to discover rooms: ${msg}`);
  }

  return rooms;
}

interface MessagesPageResponse {
  code: number;
  data: WeFlowMessage[];
}

interface MessagesAltResponse {
  code: number;
  data: { list?: WeFlowMessage[]; messages?: WeFlowMessage[] };
}

async function fetchMessages(roomId: string, sinceTime: number): Promise<WeFlowMessage[]> {
  // Primary: GET /api/messages?room_id={id}&since={unix_seconds}&limit=100
  // Fallback: GET /api/messages/{room_id}?page=1&pageSize=100
  const primaryPath = '/api/messages';
  const fallbackPath = `/api/messages/${encodeURIComponent(roomId)}`;

  let msgs: WeFlowMessage[];

  try {
    const [body, usedPath] = await tryGet<MessagesPageResponse | MessagesAltResponse>(
      primaryPath,
      fallbackPath,
      usedPath === primaryPath
        ? { room_id: roomId, since: String(sinceTime), limit: '100' }
        : { page: '1', pageSize: '100' },
    );

    if (Array.isArray((body as MessagesPageResponse).data)) {
      msgs = (body as MessagesPageResponse).data;
    } else {
      const d = (body as MessagesAltResponse).data;
      msgs = d.list ?? d.messages ?? [];
    }
  } catch {
    // Re-attempt with explicit param sets when the two-attempt helper can't
    // parametrize both paths simultaneously
    try {
      const url = new URL(`${BASE_URL}/api/messages`);
      url.searchParams.set('room_id', roomId);
      url.searchParams.set('since', String(sinceTime));
      url.searchParams.set('limit', '100');
      const resp = await fetch(url.toString(), { headers: buildHeaders() });
      if (resp.ok) {
        const body = await resp.json() as MessagesPageResponse;
        msgs = Array.isArray(body.data) ? body.data : [];
      } else {
        const url2 = new URL(`${BASE_URL}/api/messages/${encodeURIComponent(roomId)}`);
        url2.searchParams.set('page', '1');
        url2.searchParams.set('pageSize', '100');
        const resp2 = await fetch(url2.toString(), { headers: buildHeaders() });
        if (!resp2.ok) throw new Error(`HTTP ${resp2.status}`);
        const body2 = await resp2.json() as MessagesAltResponse;
        const d = body2.data;
        msgs = Array.isArray(d) ? (d as unknown as WeFlowMessage[]) : (d.list ?? d.messages ?? []);
      }
    } catch (err2: unknown) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      throw new Error(`Failed to fetch messages for room ${roomId}: ${msg}`);
    }
  }

  // Filter to messages newer than sinceTime (server may not filter reliably)
  return msgs.filter(m => m.time > sinceTime);
}

// -- Content extraction ------------------------------------------------------

function extractText(msg: WeFlowMessage): string {
  switch (msg.type) {
    case 'image': return '[图片]';
    case 'voice': return '[语音]';
    case 'video': return '[视频]';
    case 'text':
      return (msg.content ?? '').replace(/\n/g, ' ').slice(0, 120);
    default: {
      const content = (msg.content ?? '').trim();
      if (content) return content.replace(/\n/g, ' ').slice(0, 120);
      return `[${msg.type}]`;
    }
  }
}

function hhmm(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(11, 16);
}

// -- Digest ------------------------------------------------------------------

function buildRoomBlock(roomId: string, roomName: string, messages: WeFlowMessage[]): string[] {
  const lines: string[] = [
    `## ${roomName || roomId} (${messages.length} new)`,
    '',
  ];

  const sorted = [...messages].sort((a, b) => a.time - b.time);
  const tail = sorted.slice(-DIGEST_TAIL);

  if (tail.length < sorted.length) {
    lines.push(`*... ${sorted.length - tail.length} earlier messages omitted ...*`, '');
  }
  lines.push('### Messages', '');

  for (const m of tail) {
    const time = hhmm(m.time);
    const text = extractText(m);
    lines.push(`- [${time}] ${m.sender}: ${text}`);
  }
  lines.push('');

  return lines;
}

function buildDigest(date: string, blocks: string[][], stats: CollectorStats): string {
  const frontmatter = [
    '---',
    `date: ${date}`,
    'source: weflow-to-vault',
    'type: digest',
    `channels: ${stats.rooms_with_new}`,
    `total_messages: ${stats.messages}`,
    '---',
    '',
    `# WeFlow Digest -- ${date}`,
    '',
  ];
  return [...frontmatter, ...blocks.flat()].join('\n');
}

// -- Helpers -----------------------------------------------------------------

function ensureDirs(): void {
  for (const dir of [OUTPUT_DIR, DIGESTS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function loadState(): CollectorState {
  if (!existsSync(STATE_FILE)) return { rooms: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as CollectorState;
  } catch {
    return { rooms: {} };
  }
}

function saveState(state: CollectorState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function appendHeartbeat(event: string, data: Record<string, unknown>): void {
  const entry = JSON.stringify({ ts: new Date().toISOString(), event, data }) + '\n';
  appendFileSync(HEARTBEAT_FILE, entry, 'utf8');
}

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  ensureDirs();
  const state = loadState();
  const stats: CollectorStats = { rooms_scanned: 0, rooms_with_new: 0, messages: 0 };

  // Resolve room list: specified > auto-discovered
  let roomList: Array<{ id: string; name: string }>;
  try {
    if (ROOMS_ENV) {
      roomList = ROOMS_ENV.split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(id => ({ id, name: state.rooms[id]?.room_name ?? id }));
      process.stderr.write(`[weflow-collector] Using specified rooms: ${roomList.map(r => r.id).join(', ')}\n`);
    } else {
      const discovered = await discoverRooms();
      roomList = discovered.map(r => ({ id: r.id, name: r.name || r.id }));
      process.stderr.write(`[weflow-collector] Auto-discovered ${roomList.length} room(s)\n`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[weflow-collector] ERROR: ${msg}\n`);
    appendHeartbeat('error', { reason: 'discovery', message: msg });
    process.exit(1);
  }

  if (roomList.length === 0) {
    process.stderr.write(
      '[weflow-collector] No rooms found.\n' +
      'Configure WeFlow to join WeChat groups and ensure it is forwarding messages.\n',
    );
    appendHeartbeat('skip', { reason: 'no_rooms' });
    return;
  }

  const blocks: string[][] = [];

  for (const { id, name } of roomList) {
    stats.rooms_scanned++;
    const roomState = state.rooms[id];
    const sinceTime = roomState
      ? roomState.since_time
      : Math.floor(Date.now() / 1000) - LOOKBACK_SECS;

    let messages: WeFlowMessage[];
    try {
      messages = await fetchMessages(id, sinceTime);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[weflow-collector] WARN: failed to fetch room ${id}: ${msg}\n`);
      continue;
    }

    if (messages.length === 0) continue;

    blocks.push(buildRoomBlock(id, name, messages));

    const newestTime = Math.max(...messages.map(m => m.time));
    state.rooms[id] = {
      since_time: newestTime,
      last_run: new Date().toISOString(),
      room_name: name,
    };
    stats.messages += messages.length;
    stats.rooms_with_new++;

    saveState(state); // checkpoint after each room
  }

  if (stats.messages === 0) {
    process.stderr.write('[weflow-collector] No new messages across all rooms.\n');
    appendHeartbeat('noop', { rooms_scanned: stats.rooms_scanned });
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const content = buildDigest(today, blocks, stats);
  const digestPath = join(DIGESTS_DIR, `${today}.md`);
  writeFileSync(digestPath, content, 'utf8');

  state.last_run = new Date().toISOString();
  saveState(state);
  appendHeartbeat('sync', { stats, digest: digestPath });

  process.stderr.write(
    `[weflow-collector] Done. rooms=${stats.rooms_with_new}/${stats.rooms_scanned}` +
    ` messages=${stats.messages} digest=${digestPath}\n`,
  );
}

main().catch(err => {
  process.stderr.write(`[weflow-collector] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
