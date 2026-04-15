#!/usr/bin/env bun
// napcat-collector.ts — OneBot v11 HTTP API (NapCatQQ) group message collector
// Polls group messages from a local NapCatQQ server and writes daily digests.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GroupInfo {
  group_id: number;
  group_name: string;
}

interface CQSegment {
  type: string;
  data: Record<string, string>;
}

interface GroupMessage {
  message_id: number;
  time: number;
  group_id: number;
  sender: { user_id: number; nickname: string };
  message_type: string;
  message: CQSegment[];
}

interface GroupState {
  since_time: number;
  last_run: string;
  group_name: string;
}

interface CollectorState {
  groups: Record<string, GroupState>;
}

interface OneBotResponse<T> {
  status: string;
  retcode: number;
  data: T;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const NAPCAT_URL = (process.env.NAPCAT_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const NAPCAT_TOKEN = process.env.NAPCAT_TOKEN ?? '';
const NAPCAT_GROUPS = process.env.NAPCAT_GROUPS
  ? process.env.NAPCAT_GROUPS.split(',').map(s => s.trim()).filter(Boolean)
  : [];
const NAPCAT_LOOKBACK_SECS = parseInt(process.env.NAPCAT_LOOKBACK_SECS ?? '3600', 10);

const BASE_DIR = join(homedir(), '.vault-mind', 'recipes', 'napcat-to-vault');
const STATE_FILE = join(BASE_DIR, 'state.json');
const DIGESTS_DIR = join(BASE_DIR, 'digests');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDirs(): void {
  mkdirSync(BASE_DIR, { recursive: true });
  mkdirSync(DIGESTS_DIR, { recursive: true });
}

function loadState(): CollectorState {
  if (!existsSync(STATE_FILE)) return { groups: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as CollectorState;
  } catch {
    return { groups: {} };
  }
}

function saveState(state: CollectorState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function appendHeartbeat(line: string): void {
  const heartbeatFile = join(BASE_DIR, 'heartbeat.log');
  appendFileSync(heartbeatFile, `${new Date().toISOString()} ${line}\n`, 'utf-8');
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatTime(unix: number): string {
  const d = new Date(unix * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function oneBotPost<T>(path: string, body: Record<string, unknown>): Promise<OneBotResponse<T>> {
  const res = await fetch(`${NAPCAT_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${NAPCAT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${path}`);
  }
  return res.json() as Promise<OneBotResponse<T>>;
}

async function fetchGroupList(): Promise<GroupInfo[]> {
  const resp = await oneBotPost<GroupInfo[]>('/get_group_list', {});
  if (resp.retcode !== 0) {
    throw new Error(`get_group_list failed: retcode=${resp.retcode}`);
  }
  return resp.data;
}

async function fetchGroupMessages(groupId: number): Promise<GroupMessage[]> {
  const resp = await oneBotPost<{ messages: GroupMessage[] }>('/get_group_msg_history', {
    group_id: groupId,
    message_seq: 0,
    count: 100,
    reverseOrder: true,
  });
  if (resp.retcode !== 0) {
    if (resp.retcode === 100) {
      process.stderr.write(`[napcat] warn: not in group ${groupId} (retcode 100), skipping\n`);
    } else {
      process.stderr.write(`[napcat] warn: get_group_msg_history retcode=${resp.retcode} for group ${groupId}, skipping\n`);
    }
    return [];
  }
  return resp.data.messages ?? [];
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

function extractText(segments: CQSegment[]): string {
  const parts = segments.map(seg => {
    switch (seg.type) {
      case 'text':   return seg.data.text ?? '';
      case 'at':     return `@${seg.data.name ?? ''}`;
      case 'image':  return '[图片]';
      case 'record': return '[语音]';
      case 'face':   return '[表情]';
      default:       return `[${seg.type}]`;
    }
  });
  return parts.join(' ').trim().slice(0, 120);
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

interface GroupDigestEntry {
  groupName: string;
  messages: Array<{ time: number; nickname: string; text: string }>;
}

function buildGroupBlock(entry: GroupDigestEntry): string {
  const { groupName, messages } = entry;
  const shown = messages.slice(-30);
  const lines = shown.map(m => `- [${formatTime(m.time)}] ${m.nickname}: ${m.text}`);
  return [
    `## ${groupName} (${messages.length} new)`,
    '',
    '### Messages',
    ...lines,
    '',
  ].join('\n');
}

function buildDigest(
  entries: GroupDigestEntry[],
  totalMessages: number,
): string {
  const date = todayStr();
  const channelCount = entries.filter(e => e.messages.length > 0).length;

  const frontmatter = [
    '---',
    `date: ${date}`,
    `source: napcat-to-vault`,
    `type: digest`,
    `channels: ${channelCount}`,
    `total_messages: ${totalMessages}`,
    '---',
    '',
  ].join('\n');

  const blocks = entries
    .filter(e => e.messages.length > 0)
    .map(e => buildGroupBlock(e))
    .join('\n');

  return frontmatter + blocks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!NAPCAT_TOKEN) {
    process.stderr.write(
      '[napcat] error: NAPCAT_TOKEN is required.\n' +
      'Set it with: export NAPCAT_TOKEN=<your-token>\n' +
      'Find or set the token in your NapCatQQ server config.\n',
    );
    process.exit(1);
  }

  ensureDirs();
  const state = loadState();
  const now = Math.floor(Date.now() / 1000);

  // Resolve group list
  let groupInfos: GroupInfo[];
  if (NAPCAT_GROUPS.length > 0) {
    groupInfos = NAPCAT_GROUPS.map(id => ({
      group_id: parseInt(id, 10),
      group_name: state.groups[id]?.group_name ?? id,
    }));
  } else {
    groupInfos = await fetchGroupList();
  }

  if (groupInfos.length === 0) {
    process.stdout.write('[napcat] no groups found. Add the bot to at least one QQ group.\n');
    return;
  }

  const entries: GroupDigestEntry[] = [];
  let totalMessages = 0;

  for (const group of groupInfos) {
    const gidStr = String(group.group_id);
    const groupState = state.groups[gidStr];
    const sinceTime = groupState?.since_time ?? now - NAPCAT_LOOKBACK_SECS;

    const rawMessages = await fetchGroupMessages(group.group_id);
    const newMessages = rawMessages.filter(m => m.time > sinceTime);

    const digestMessages = newMessages.map(m => ({
      time: m.time,
      nickname: m.sender.nickname,
      text: extractText(m.message),
    }));

    const maxTime = newMessages.length > 0
      ? Math.max(...newMessages.map(m => m.time))
      : sinceTime;

    state.groups[gidStr] = {
      since_time: maxTime,
      last_run: new Date().toISOString(),
      group_name: group.group_name,
    };

    entries.push({ groupName: group.group_name, messages: digestMessages });
    totalMessages += digestMessages.length;

    process.stdout.write(`[napcat] group ${group.group_name} (${gidStr}): ${digestMessages.length} new messages\n`);
  }

  saveState(state);

  if (totalMessages > 0) {
    const digest = buildDigest(entries, totalMessages);
    const digestPath = join(DIGESTS_DIR, `${todayStr()}.md`);
    writeFileSync(digestPath, digest, 'utf-8');
    process.stdout.write(`[napcat] digest written to ${digestPath}\n`);
  } else {
    process.stdout.write('[napcat] no new messages, digest skipped\n');
  }

  appendHeartbeat(`ok groups=${groupInfos.length} messages=${totalMessages}`);
}

main().catch(err => {
  process.stderr.write(`[napcat] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
