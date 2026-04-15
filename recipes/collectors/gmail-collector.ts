#!/usr/bin/env bun
// gmail-collector.ts -- Gmail -> vault digest collector
// Fetches emails since last run and writes daily digests grouped by sender domain.
// Requires: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
// One-time setup: bun run recipes/collectors/gmail-setup.ts

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  id: string;
  threadId: string;
}

interface MessageListResponse {
  messages?: Message[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface MessageHeader {
  name: string;
  value: string;
}

interface MessagePayload {
  headers?: MessageHeader[];
}

interface FullMessage {
  id: string;
  snippet?: string;
  internalDate?: string;
  payload?: MessagePayload;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface CollectorState {
  last_synced: string;
}

interface EmailDigestEntry {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CLIENT_ID = process.env.GMAIL_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET ?? '';
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN ?? '';

// Default: fetch unread mail. Override with any Gmail search syntax.
const GMAIL_QUERY_BASE = process.env.GMAIL_QUERY ?? 'is:unread';
const MAX_RESULTS = parseInt(process.env.GMAIL_MAX_RESULTS ?? '50', 10);
const LOOKBACK_DAYS = parseInt(process.env.GMAIL_LOOKBACK_DAYS ?? '1', 10);

const BASE_URL = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const BASE_DIR = join(homedir(), '.vault-mind', 'recipes', 'gmail-to-vault');
const STATE_FILE = join(BASE_DIR, 'state.json');
const DIGESTS_DIR = join(BASE_DIR, 'digests');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDirs(): void {
  mkdirSync(BASE_DIR, { recursive: true });
  mkdirSync(DIGESTS_DIR, { recursive: true });
}

function loadState(): CollectorState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as CollectorState;
  } catch {
    return null;
  }
}

function saveState(state: CollectorState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function appendHeartbeat(line: string): void {
  appendFileSync(join(BASE_DIR, 'heartbeat.log'), `${new Date().toISOString()} ${line}\n`, 'utf-8');
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Convert ISO string to Gmail `after:` epoch seconds */
function isoToGmailAfter(iso: string): string {
  return String(Math.floor(new Date(iso).getTime() / 1000));
}

function senderDomain(from: string): string {
  const match = from.match(/@([\w.-]+)/);
  return match ? match[1].toLowerCase() : 'unknown';
}

// ---------------------------------------------------------------------------
// OAuth: exchange refresh_token for access_token
// ---------------------------------------------------------------------------

async function getAccessToken(): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as TokenResponse;
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Gmail API
// ---------------------------------------------------------------------------

async function listMessages(
  accessToken: string,
  query: string,
  pageToken?: string,
): Promise<MessageListResponse> {
  const url = new URL(`${BASE_URL}/users/me/messages`);
  url.searchParams.set('q', query);
  url.searchParams.set('maxResults', String(MAX_RESULTS));
  if (pageToken) url.searchParams.set('pageToken', pageToken);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`messages.list failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }

  return (await res.json()) as MessageListResponse;
}

async function getMessage(accessToken: string, id: string): Promise<FullMessage> {
  const url = `${BASE_URL}/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`messages.get(${id}) failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  return (await res.json()) as FullMessage;
}

function header(msg: FullMessage, name: string): string {
  const h = msg.payload?.headers?.find(
    h => h.name.toLowerCase() === name.toLowerCase(),
  );
  return h?.value ?? '';
}

async function fetchAllMessages(accessToken: string, query: string): Promise<FullMessage[]> {
  const all: FullMessage[] = [];
  let pageToken: string | undefined;

  // Fetch IDs (one page -- respects MAX_RESULTS cap)
  const listResp = await listMessages(accessToken, query, pageToken);
  const ids = listResp.messages ?? [];

  if (ids.length === 0) return [];

  // Fetch full metadata for each (sequential to avoid 429s)
  for (const { id } of ids) {
    try {
      const msg = await getMessage(accessToken, id);
      all.push(msg);
    } catch (err) {
      process.stderr.write(`[gmail] warn: skipping message ${id}: ${(err as Error).message}\n`);
    }
  }

  return all;
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

function buildDigestEntry(msg: FullMessage): EmailDigestEntry {
  const subject = header(msg, 'Subject') || '(no subject)';
  const from = header(msg, 'From') || '(unknown sender)';
  const date = header(msg, 'Date')
    ? new Date(header(msg, 'Date')).toISOString().slice(0, 16).replace('T', ' ')
    : msg.internalDate
      ? new Date(parseInt(msg.internalDate)).toISOString().slice(0, 16).replace('T', ' ')
      : '(unknown date)';
  const snippet = (msg.snippet ?? '').replace(/\s+/g, ' ').slice(0, 200);

  return { id: msg.id, subject, from, date, snippet };
}

function buildDigest(entries: EmailDigestEntry[]): string {
  const date = todayStr();

  const frontmatter = [
    '---',
    `date: ${date}`,
    `source: gmail-to-vault`,
    `type: digest`,
    `emails: ${entries.length}`,
    '---',
    '',
    `# Email Digest -- ${date}`,
    '',
  ].join('\n');

  // Group by sender domain
  const byDomain = new Map<string, EmailDigestEntry[]>();
  for (const entry of entries) {
    const domain = senderDomain(entry.from);
    const group = byDomain.get(domain) ?? [];
    group.push(entry);
    byDomain.set(domain, group);
  }

  const sortedDomains = [...byDomain.keys()].sort();
  const sections = sortedDomains.map(domain => {
    const domainEntries = byDomain.get(domain)!;
    const header = `## ${domain} (${domainEntries.length})`;
    const lines = domainEntries.map(e =>
      `### ${e.subject}\n> ${e.date} | ${e.from}\n\n${e.snippet}\n`,
    );
    return [header, '', ...lines].join('\n');
  });

  return frontmatter + sections.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const missing: string[] = [];
  if (!CLIENT_ID) missing.push('GMAIL_CLIENT_ID');
  if (!CLIENT_SECRET) missing.push('GMAIL_CLIENT_SECRET');
  if (!REFRESH_TOKEN) missing.push('GMAIL_REFRESH_TOKEN');

  if (missing.length > 0) {
    process.stderr.write(
      `[gmail] error: missing required env vars: ${missing.join(', ')}\n` +
      'Run gmail-setup.ts once to obtain GMAIL_REFRESH_TOKEN.\n',
    );
    process.exit(1);
  }

  ensureDirs();

  const state = loadState();
  const syncAfter = state?.last_synced
    ?? new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  // Build query: combine user query with after: filter
  const afterEpoch = isoToGmailAfter(syncAfter);
  const query = `${GMAIL_QUERY_BASE} after:${afterEpoch}`;

  process.stdout.write(`[gmail] fetching messages matching: ${query}\n`);

  const accessToken = await getAccessToken();
  const messages = await fetchAllMessages(accessToken, query);

  if (messages.length === 0) {
    process.stdout.write('[gmail] no new messages found\n');
    saveState({ last_synced: new Date().toISOString() });
    appendHeartbeat('ok emails=0');
    return;
  }

  process.stdout.write(`[gmail] fetched ${messages.length} message(s)\n`);

  const entries = messages.map(buildDigestEntry);
  const digest = buildDigest(entries);
  const digestPath = join(DIGESTS_DIR, `${todayStr()}.md`);

  if (existsSync(digestPath)) {
    appendFileSync(digestPath, '\n---\n\n' + digest, 'utf-8');
  } else {
    writeFileSync(digestPath, digest, 'utf-8');
  }

  process.stdout.write(`[gmail] digest written to ${digestPath}\n`);

  saveState({ last_synced: new Date().toISOString() });
  appendHeartbeat(`ok emails=${messages.length}`);
}

main().catch(err => {
  process.stderr.write(
    `[gmail] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
