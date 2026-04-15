#!/usr/bin/env bun
/**
 * astrbot-collector.ts -- AstrBot SQLite DB -> vault digest
 *
 * Reads AstrBot conversation logs directly from its SQLite database and writes
 * a dated digest to ~/.vault-mind/recipes/astrbot-to-vault/digests/.
 *
 * Usage:
 *   bun run recipes/collectors/astrbot-collector.ts
 *
 * Environment:
 *   ASTRBOT_DATA_DIR     - path to AstrBot data directory
 *                          default: ~/AstrBot/data (Windows), ~/.astrbot/data (Linux/Mac)
 *   ASTRBOT_PLATFORMS    - optional comma-separated platforms (e.g. qq,wechat); omit = all
 *   ASTRBOT_LOOKBACK_DAYS - default 1
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { Database } from 'bun:sqlite';

// -- Types -------------------------------------------------------------------

interface MessageRow {
  session_id: string;
  platform: string;
  sender_id: string;
  content: string;
  create_time: number; // Unix seconds (REAL in SQLite)
}

interface CollectorState {
  since_time: number; // Unix seconds
  last_run?: string;
}

interface CollectorStats {
  sessions: number;
  messages: number;
}

// -- Config ------------------------------------------------------------------

function defaultDataDir(): string {
  return platform() === 'win32'
    ? join(homedir(), 'AstrBot', 'data')
    : join(homedir(), '.astrbot', 'data');
}

const DATA_DIR = process.env.ASTRBOT_DATA_DIR
  ? process.env.ASTRBOT_DATA_DIR.replace(/^~/, homedir())
  : defaultDataDir();
const PLATFORMS_ENV = process.env.ASTRBOT_PLATFORMS;
const LOOKBACK_DAYS = parseInt(process.env.ASTRBOT_LOOKBACK_DAYS ?? '1', 10);

const DB_PATH = join(DATA_DIR, 'data.db');

const OUTPUT_DIR = join(homedir(), '.vault-mind', 'recipes', 'astrbot-to-vault');
const DIGESTS_DIR = join(OUTPUT_DIR, 'digests');
const STATE_FILE = join(OUTPUT_DIR, 'state.json');
const HEARTBEAT_FILE = join(OUTPUT_DIR, 'heartbeat.jsonl');

const DIGEST_TAIL_PER_SESSION = 20;

// -- DB helpers --------------------------------------------------------------

function findConversationTable(db: Database): string | null {
  const tables = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='table'`,
  ).all();

  const tableNames = tables.map(r => r.name);

  // Look for a table that has the expected columns
  for (const name of tableNames) {
    try {
      const info = db.query<{ name: string }, []>(`PRAGMA table_info(${name})`).all();
      const cols = new Set(info.map(r => r.name));
      if (cols.has('session_id') && cols.has('content') && cols.has('create_time')) {
        return name;
      }
    } catch {
      // pragma failed for this table, skip
    }
  }
  return null;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const info = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return info.some(r => r.name === column);
}

function queryMessages(db: Database, table: string, sinceTime: number): MessageRow[] {
  const hasPlatform = hasColumn(db, table, 'platform');
  const hasSenderId = hasColumn(db, table, 'sender_id');
  const hasRole = hasColumn(db, table, 'role');

  const platformCol = hasPlatform ? 'platform' : `'' AS platform`;
  const senderCol = hasSenderId ? 'sender_id' : `session_id AS sender_id`;

  if (hasRole) {
    return db.query<MessageRow, [number]>(
      `SELECT session_id, ${platformCol}, ${senderCol}, content, create_time
       FROM ${table}
       WHERE role = 'user'
         AND create_time > ?
       ORDER BY create_time ASC`,
    ).all(sinceTime);
  }

  // No role column -- fetch everything
  return db.query<MessageRow, [number]>(
    `SELECT session_id, ${platformCol}, ${senderCol}, content, create_time
     FROM ${table}
     WHERE create_time > ?
     ORDER BY create_time ASC`,
  ).all(sinceTime);
}

// -- Digest ------------------------------------------------------------------

function hhmm(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(11, 16);
}

function buildPlatformBlock(
  platformName: string,
  sessions: Map<string, MessageRow[]>,
): string[] {
  const lines: string[] = [
    `## ${platformName} (${sessions.size} sessions)`,
    '',
  ];

  for (const [sessionId, msgs] of sessions) {
    lines.push(`### session ${sessionId}`, '');

    const tail = msgs.slice(-DIGEST_TAIL_PER_SESSION);
    if (tail.length < msgs.length) {
      lines.push(`*... ${msgs.length - tail.length} earlier messages omitted ...*`, '');
    }

    for (const m of tail) {
      const time = hhmm(m.create_time);
      const text = m.content.replace(/\n/g, ' ').slice(0, 120);
      lines.push(`- [${time}] ${m.sender_id}: ${text}`);
    }
    lines.push('');
  }

  return lines;
}

function buildDigest(
  date: string,
  blocks: string[][],
  stats: CollectorStats,
): string {
  const frontmatter = [
    '---',
    `date: ${date}`,
    'source: astrbot-to-vault',
    'type: digest',
    `sessions: ${stats.sessions}`,
    `total_messages: ${stats.messages}`,
    '---',
    '',
    `# AstrBot Digest -- ${date}`,
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

function loadState(defaultSinceTime: number): CollectorState {
  if (!existsSync(STATE_FILE)) return { since_time: defaultSinceTime };
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as CollectorState;
  } catch {
    return { since_time: defaultSinceTime };
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

  if (!existsSync(DB_PATH)) {
    process.stderr.write(
      `[astrbot-collector] ERROR: database not found at ${DB_PATH}\n` +
      'Common Windows paths:\n' +
      '  C:/Users/<username>/AstrBot/data/data.db\n' +
      '  D:/AstrBot/data/data.db\n' +
      'Set ASTRBOT_DATA_DIR to the correct data directory.\n',
    );
    process.exit(1);
  }

  const defaultSinceTime = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
  const state = loadState(defaultSinceTime);
  const stats: CollectorStats = { sessions: 0, messages: 0 };

  let db: Database;
  try {
    db = new Database(DB_PATH, { readonly: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[astrbot-collector] ERROR: failed to open DB: ${msg}\n`);
    appendHeartbeat('error', { reason: 'db_open', message: msg });
    process.exit(1);
  }

  const tableName = findConversationTable(db);
  if (!tableName) {
    const allTables = db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table'`,
    ).all().map(r => r.name);
    process.stderr.write(
      `[astrbot-collector] ERROR: no conversation table found in ${DB_PATH}\n` +
      `Tables found: ${allTables.join(', ') || '(none)'}\n` +
      'Expected a table with columns: session_id, content, create_time\n',
    );
    db.close();
    process.exit(1);
  }

  process.stderr.write(`[astrbot-collector] Using table: ${tableName}\n`);

  let rows: MessageRow[];
  try {
    rows = queryMessages(db, tableName, state.since_time);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[astrbot-collector] ERROR: query failed: ${msg}\n`);
    db.close();
    appendHeartbeat('error', { reason: 'query', message: msg });
    process.exit(1);
  }
  db.close();

  if (rows.length === 0) {
    process.stderr.write('[astrbot-collector] No new messages.\n');
    appendHeartbeat('noop', { since_time: state.since_time });
    return;
  }

  // Filter by platform if specified
  const allowedPlatforms = PLATFORMS_ENV
    ? new Set(PLATFORMS_ENV.split(',').map(s => s.trim()).filter(Boolean))
    : null;

  const filtered = allowedPlatforms
    ? rows.filter(r => allowedPlatforms.has(r.platform))
    : rows;

  if (filtered.length === 0) {
    process.stderr.write(`[astrbot-collector] No messages for platforms: ${PLATFORMS_ENV}\n`);
    appendHeartbeat('noop', { reason: 'platform_filter', platforms: PLATFORMS_ENV });
    return;
  }

  // Group: platform -> session_id -> messages[]
  const byPlatform = new Map<string, Map<string, MessageRow[]>>();
  for (const row of filtered) {
    const plat = row.platform || 'unknown';
    if (!byPlatform.has(plat)) byPlatform.set(plat, new Map());
    const sessions = byPlatform.get(plat)!;
    if (!sessions.has(row.session_id)) sessions.set(row.session_id, []);
    sessions.get(row.session_id)!.push(row);
  }

  const blocks: string[][] = [];
  for (const [platformName, sessions] of byPlatform) {
    blocks.push(buildPlatformBlock(platformName, sessions));
    stats.sessions += sessions.size;
    for (const msgs of sessions.values()) {
      stats.messages += msgs.length;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const content = buildDigest(today, blocks, stats);
  const digestPath = join(DIGESTS_DIR, `${today}.md`);
  writeFileSync(digestPath, content, 'utf8');

  const newestTime = Math.max(...filtered.map(r => r.create_time));
  state.since_time = newestTime;
  state.last_run = new Date().toISOString();
  saveState(state);
  appendHeartbeat('sync', { stats, digest: digestPath });

  process.stderr.write(
    `[astrbot-collector] Done. sessions=${stats.sessions}` +
    ` messages=${stats.messages} digest=${digestPath}\n`,
  );
}

main().catch(err => {
  process.stderr.write(`[astrbot-collector] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
