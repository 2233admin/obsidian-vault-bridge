#!/usr/bin/env bun
/**
 * wechatmsg-collector.ts -- WeChatMsg local API -> vault digest
 *
 * Reads WeChat messages from WeChatMsg's local HTTP API (port 5000) and writes
 * a dated digest to ~/.vault-mind/recipes/wechatmsg-to-vault/digests/.
 *
 * WeChatMsg (https://github.com/LC044/WeChatMsg) decrypts WeChat's local DB
 * and exposes it via HTTP. Start WeChatMsg and it will launch the server.
 *
 * Usage:
 *   bun run recipes/collectors/wechatmsg-collector.ts
 *
 * Environment:
 *   WECHATMSG_URL           - default http://localhost:5000
 *   WECHATMSG_CONTACTS      - optional comma-separated wxid_xxx or room IDs; omit = group chats only
 *   WECHATMSG_LOOKBACK_DAYS - default 1
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// -- Types -------------------------------------------------------------------

interface WeChatContact {
  UserName: string;
  NickName: string;
  Type: number; // 2=group, 3=public account, others=personal
}

interface WeChatMessage {
  MsgSvrID: string;
  StrTalkerUserName: string;
  IsSender: number;   // 1=you, 0=received
  Type: number;
  SubType: number;
  CreateTime: number; // Unix seconds
  DisplayFullContent: string;
  NickName: string;
}

interface ContactState {
  since_time: number;
  nick_name: string;
}

interface CollectorState {
  contacts: Record<string, ContactState>;
  last_run?: string;
}

interface CollectorStats {
  contacts_scanned: number;
  contacts_with_new: number;
  messages: number;
}

// -- Config ------------------------------------------------------------------

const BASE_URL = (process.env.WECHATMSG_URL ?? 'http://localhost:5000').replace(/\/$/, '');
const CONTACTS_ENV = process.env.WECHATMSG_CONTACTS;
const LOOKBACK_DAYS = parseInt(process.env.WECHATMSG_LOOKBACK_DAYS ?? '1', 10);

const OUTPUT_DIR = join(homedir(), '.vault-mind', 'recipes', 'wechatmsg-to-vault');
const DIGESTS_DIR = join(OUTPUT_DIR, 'digests');
const STATE_FILE = join(OUTPUT_DIR, 'state.json');
const HEARTBEAT_FILE = join(OUTPUT_DIR, 'heartbeat.jsonl');

const DIGEST_TAIL = 30;

// -- HTTP helpers ------------------------------------------------------------

async function apiGet<T>(path: string): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(`${BASE_URL}${path}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `WeChatMsg server at ${BASE_URL} not responding: ${msg}\n` +
      'Setup hint: install WeChatMsg from https://github.com/LC044/WeChatMsg, ' +
      'run it as administrator, and it will start the HTTP server automatically on port 5000.',
    );
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${path}`);
  return resp.json() as Promise<T>;
}

// -- API queries -------------------------------------------------------------

async function discoverContacts(): Promise<WeChatContact[]> {
  const r = await apiGet<{ code: number; data: WeChatContact[] }>('/api/getContactList');
  if (r.code !== 200) {
    process.stderr.write(`[wechatmsg-collector] WARN: getContactList code=${r.code}, skipping\n`);
    return [];
  }
  // Only group chats for auto-discovery
  return (r.data ?? []).filter(c => c.Type === 2);
}

async function fetchChatHistory(
  username: string,
  sinceTime: number,
  isFirstRun: boolean,
): Promise<WeChatMessage[]> {
  const path = `/api/getChatHistory/${encodeURIComponent(username)}?page=1&pageSize=100`;
  const r = await apiGet<{ code: number; data: { data: WeChatMessage[]; total: number } }>(path);

  if (r.code !== 200) {
    process.stderr.write(`[wechatmsg-collector] WARN: getChatHistory ${username} code=${r.code}, skipping\n`);
    return [];
  }

  const all: WeChatMessage[] = r.data?.data ?? [];

  // Messages are newest-first; collect those newer than sinceTime
  const fresh = all.filter(m => m.CreateTime > sinceTime);

  // On first run we paginate; subsequent runs only use page 1 to limit API calls
  if (isFirstRun && fresh.length === all.length && all.length === 100) {
    // All 100 are fresh -- there may be more pages, fetch page 2+
    let page = 2;
    const accumulated = [...fresh];
    while (true) {
      const nextPath = `/api/getChatHistory/${encodeURIComponent(username)}?page=${page}&pageSize=100`;
      const nr = await apiGet<{ code: number; data: { data: WeChatMessage[]; total: number } }>(nextPath);
      if (nr.code !== 200) break;
      const batch = (nr.data?.data ?? []).filter(m => m.CreateTime > sinceTime);
      accumulated.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return accumulated;
  }

  return fresh;
}

// -- Content extraction ------------------------------------------------------

function extractText(msg: WeChatMessage): string {
  const raw = msg.DisplayFullContent ?? '';
  switch (msg.Type) {
    case 1:    return raw.replace(/\n/g, ' ').slice(0, 120);
    case 3:    return '[图片]';
    case 34:   return '[语音]';
    case 43:   return '[视频]';
    case 47:   return '[表情包]';
    case 49: {
      // Usually "type:title" or just a title
      const colonIdx = raw.indexOf(':');
      if (colonIdx > 0 && colonIdx < 20) {
        const title = raw.slice(colonIdx + 1).trim().replace(/\n/g, ' ').slice(0, 80);
        return title || '[文件]';
      }
      return raw.replace(/\n/g, ' ').slice(0, 80) || '[文件]';
    }
    case 10000:
    case 10002: return '[系统消息]';
    default:    return `[${msg.Type}]`;
  }
}

function hhmm(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(11, 16);
}

// -- Digest ------------------------------------------------------------------

function buildContactBlock(
  nickName: string,
  messages: WeChatMessage[],
): string[] {
  const lines: string[] = [
    `## ${nickName} (${messages.length} new)`,
    '',
  ];

  // Sort ascending by CreateTime for display (API returns newest-first)
  const sorted = [...messages].sort((a, b) => a.CreateTime - b.CreateTime);
  const tail = sorted.slice(-DIGEST_TAIL);

  if (tail.length < sorted.length) {
    lines.push(`*... ${sorted.length - tail.length} earlier messages omitted ...*`, '');
  }
  lines.push('### Messages', '');

  for (const m of tail) {
    const time = hhmm(m.CreateTime);
    const sender = m.IsSender === 1 ? 'Me' : (m.NickName || m.StrTalkerUserName);
    const text = extractText(m);
    lines.push(`- [${time}] ${sender}: ${text}`);
  }
  lines.push('');

  return lines;
}

function buildDigest(date: string, blocks: string[][], stats: CollectorStats): string {
  const frontmatter = [
    '---',
    `date: ${date}`,
    'source: wechatmsg-to-vault',
    'type: digest',
    `channels: ${stats.contacts_with_new}`,
    `total_messages: ${stats.messages}`,
    '---',
    '',
    `# WeChatMsg Digest -- ${date}`,
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
  if (!existsSync(STATE_FILE)) return { contacts: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as CollectorState;
  } catch {
    return { contacts: {} };
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
  const stats: CollectorStats = { contacts_scanned: 0, contacts_with_new: 0, messages: 0 };

  // Resolve contact list: specified > auto-discovered group chats
  let contactList: Array<{ username: string; nickName: string }>;
  try {
    if (CONTACTS_ENV) {
      contactList = CONTACTS_ENV.split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(username => ({
          username,
          nickName: state.contacts[username]?.nick_name ?? username,
        }));
      process.stderr.write(`[wechatmsg-collector] Using specified contacts: ${contactList.map(c => c.username).join(', ')}\n`);
    } else {
      const discovered = await discoverContacts();
      contactList = discovered.map(c => ({ username: c.UserName, nickName: c.NickName || c.UserName }));
      process.stderr.write(`[wechatmsg-collector] Auto-discovered ${contactList.length} group chat(s)\n`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[wechatmsg-collector] ERROR: ${msg}\n`);
    appendHeartbeat('error', { reason: 'api_error', message: msg });
    process.exit(1);
  }

  if (contactList.length === 0) {
    process.stderr.write(
      '[wechatmsg-collector] No contacts found.\n' +
      'Ensure WeChatMsg has loaded your WeChat messages and at least one group chat exists.\n',
    );
    appendHeartbeat('skip', { reason: 'no_contacts' });
    return;
  }

  const lookbackSec = LOOKBACK_DAYS * 86400;
  const blocks: string[][] = [];

  for (const { username, nickName } of contactList) {
    stats.contacts_scanned++;
    const contactState = state.contacts[username];
    const isFirstRun = !contactState;
    const sinceTime = contactState
      ? contactState.since_time
      : Math.floor(Date.now() / 1000) - lookbackSec;

    let messages: WeChatMessage[];
    try {
      messages = await fetchChatHistory(username, sinceTime, isFirstRun);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[wechatmsg-collector] WARN: failed to fetch ${username}: ${msg}\n`);
      continue;
    }

    if (messages.length === 0) continue;

    const displayName = nickName || username;
    blocks.push(buildContactBlock(displayName, messages));

    const newestTime = Math.max(...messages.map(m => m.CreateTime));
    state.contacts[username] = {
      since_time: newestTime,
      nick_name: displayName,
    };
    stats.messages += messages.length;
    stats.contacts_with_new++;

    saveState(state); // checkpoint after each contact
  }

  if (stats.messages === 0) {
    process.stderr.write('[wechatmsg-collector] No new messages across all contacts.\n');
    appendHeartbeat('noop', { contacts_scanned: stats.contacts_scanned });
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
    `[wechatmsg-collector] Done. contacts=${stats.contacts_with_new}/${stats.contacts_scanned}` +
    ` messages=${stats.messages} digest=${digestPath}\n`,
  );
}

main().catch(err => {
  process.stderr.write(`[wechatmsg-collector] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
