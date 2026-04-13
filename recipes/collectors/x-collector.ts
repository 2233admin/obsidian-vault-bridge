#!/usr/bin/env node
/**
 * x-collector.ts — X API v2 collector for vault-mind
 *
 * Fetches timeline tweets + mentions, writes raw JSON files,
 * generates a dated digest markdown, and tracks pagination state.
 *
 * Usage:
 *   bun run recipes/collectors/x-collector.ts
 *   X_BEARER_TOKEN=... bun run recipes/collectors/x-collector.ts
 *
 * Environment:
 *   X_BEARER_TOKEN  - required: X API v2 Bearer token
 *   VAULT_MIND_DIR  - optional: project root (default: process.cwd())
 *   VAULT_DIR       - optional: Obsidian vault path
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// -- Types ------------------------------------------------------------------

interface Tweet {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
  public_metrics?: {
    retweet_count: number;
    like_count: number;
    reply_count: number;
    quote_count: number;
  };
}

interface User {
  id: string;
  name: string;
  username: string;
}

interface TweetResponse {
  data?: Tweet[];
  includes?: { users?: User[] };
  meta?: { newest_id?: string; oldest_id?: string; next_token?: string; result_count?: number };
}

interface CollectorState {
  userId?: string;
  timeline_since_id?: string;
  mentions_since_id?: string;
  last_run?: string;
  monthly_tweet_count?: number;
  month_key?: string;  // "2026-04"
}

interface CollectorStats {
  fetched: number;
  new: number;
  skipped: number;
}

// -- Config -----------------------------------------------------------------

const BEARER_TOKEN = process.env.X_BEARER_TOKEN;
if (!BEARER_TOKEN) {
  process.stderr.write('[x-collector] ERROR: X_BEARER_TOKEN environment variable is not set\n');
  process.exit(1);
}

const OUTPUT_DIR = join(homedir(), '.vault-mind', 'recipes', 'x-to-vault');
const RAW_DIR = join(OUTPUT_DIR, 'raw');
const DIGESTS_DIR = join(OUTPUT_DIR, 'digests');
const STATE_FILE = join(OUTPUT_DIR, 'state.json');
const HEARTBEAT_FILE = join(OUTPUT_DIR, 'heartbeat.jsonl');

// Free tier: 1500 tweets/month. Track usage.
const MONTHLY_LIMIT = 1400; // leave 100 buffer
const MAX_PAGES = 5; // cap at 500 tweets/endpoint/run to protect free tier budget

// -- Helpers ----------------------------------------------------------------

function ensureDirs(): void {
  for (const dir of [OUTPUT_DIR, RAW_DIR, DIGESTS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function loadState(): CollectorState {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as CollectorState;
  } catch {
    return {};
  }
}

function saveState(state: CollectorState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function appendHeartbeat(event: string, data: Record<string, unknown>): void {
  const entry = JSON.stringify({ ts: new Date().toISOString(), event, data }) + '\n';
  appendFileSync(HEARTBEAT_FILE, entry, 'utf8');
}

function isRetweet(tweet: Tweet): boolean {
  return tweet.referenced_tweets?.some(r => r.type === 'retweeted') ?? false;
}

function formatTime(isoDate: string): string {
  // Extract HH:MM from ISO date string
  const match = isoDate.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : isoDate;
}

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7); // "2026-04"
}

// -- X API v2 ---------------------------------------------------------------

async function xGet(path: string, params: Record<string, string> = {}, attempt = 0): Promise<unknown> {
  const url = new URL(`https://api.x.com/2${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}` },
  });

  if (resp.status === 429 && attempt < 3) {
    const resetEpoch = resp.headers.get('x-rate-limit-reset');
    const retryAfterSec = resp.headers.get('retry-after');
    let waitSec: number;
    if (resetEpoch) {
      waitSec = Math.max(parseInt(resetEpoch, 10) - Math.floor(Date.now() / 1000), 1);
    } else if (retryAfterSec) {
      waitSec = parseInt(retryAfterSec, 10);
    } else {
      waitSec = 60;
    }
    const waitMs = Math.max(waitSec, 60) * 1000;
    process.stderr.write(`[x-collector] Rate limited (429). Waiting ${waitMs / 1000}s before retry ${attempt + 1}/3...\n`);
    await new Promise<void>(r => setTimeout(r, waitMs));
    return xGet(path, params, attempt + 1);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`X API ${path} -> HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

async function getMyUserId(): Promise<string> {
  const data = await xGet('/users/me', { 'user.fields': 'id,username' }) as { data: User };
  return data.data.id;
}

async function fetchTweets(
  userId: string,
  endpoint: 'tweets' | 'mentions',
  sinceId?: string,
): Promise<{ tweets: Tweet[]; users: Map<string, User>; newestId?: string }> {
  const path = endpoint === 'tweets'
    ? `/users/${userId}/tweets`
    : `/users/${userId}/mentions`;

  const params: Record<string, string> = {
    max_results: '100',
    'tweet.fields': 'created_at,author_id,referenced_tweets,public_metrics',
    'expansions': 'author_id',
    'user.fields': 'username,name',
  };
  if (sinceId) params.since_id = sinceId;

  const allTweets: Tweet[] = [];
  const userMap = new Map<string, User>();
  let newestId: string | undefined;
  let paginationToken: string | undefined;
  let pageCount = 0;

  do {
    if (pageCount++ >= MAX_PAGES) {
      process.stderr.write(`[x-collector] Reached MAX_PAGES (${MAX_PAGES}) for ${endpoint}. Resuming next run.\n`);
      break;
    }
    if (paginationToken) params.pagination_token = paginationToken;

    const resp = await xGet(path, params) as TweetResponse;

    if (!resp.data || resp.data.length === 0) break;

    allTweets.push(...resp.data);
    if (!newestId) newestId = resp.meta?.newest_id;

    // Build user lookup from includes
    for (const u of resp.includes?.users ?? []) {
      userMap.set(u.id, u);
    }

    paginationToken = resp.meta?.next_token;
  } while (paginationToken);

  return { tweets: allTweets, users: userMap, newestId };
}

// -- Digest generation -------------------------------------------------------

function buildDigest(
  timelineTweets: Tweet[],
  mentionTweets: Tweet[],
  users: Map<string, User>,
  date: string,
): string {
  const lines: string[] = [
    '---',
    `date: ${date}`,
    'source: x-to-vault',
    'type: digest',
    `tweets_count: ${timelineTweets.length}`,
    `mentions_count: ${mentionTweets.length}`,
    '---',
    '',
    `# X Digest -- ${date}`,
    '',
  ];

  // Timeline section
  if (timelineTweets.length > 0) {
    lines.push('## Timeline Highlights', '');

    // Group by author
    const byAuthor = new Map<string, Tweet[]>();
    for (const t of timelineTweets) {
      const arr = byAuthor.get(t.author_id) ?? [];
      arr.push(t);
      byAuthor.set(t.author_id, arr);
    }

    for (const [authorId, tweets] of byAuthor) {
      const user = users.get(authorId);
      const handle = user ? `@${user.username}` : `user_${authorId}`;
      lines.push(`### ${handle} (${tweets.length} tweet${tweets.length > 1 ? 's' : ''})`, '');
      for (const t of tweets) {
        const time = formatTime(t.created_at);
        const text = t.text.replace(/\n/g, ' ').slice(0, 120);
        const link = `https://x.com/i/web/status/${t.id}`;
        lines.push(`- [${time}] ${text} [link](${link})`);
      }
      lines.push('');
    }
  }

  // Mentions section
  if (mentionTweets.length > 0) {
    lines.push('## Mentions', '');
    for (const t of mentionTweets) {
      const user = users.get(t.author_id);
      const handle = user ? `@${user.username}` : `user_${t.author_id}`;
      const time = formatTime(t.created_at);
      const text = t.text.replace(/\n/g, ' ').slice(0, 120);
      const link = `https://x.com/i/web/status/${t.id}`;
      lines.push(`### ${handle} mentioned you`);
      lines.push(`- [${time}] "${text}" [link](${link})`, '');
    }
  }

  return lines.join('\n');
}

// -- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  ensureDirs();
  const state = loadState();
  const stats: CollectorStats = { fetched: 0, new: 0, skipped: 0 };

  // Check monthly rate limit tracking
  const monthKey = currentMonthKey();
  if (state.month_key !== monthKey) {
    state.monthly_tweet_count = 0;
    state.month_key = monthKey;
  }
  const monthlyCount = state.monthly_tweet_count ?? 0;
  if (monthlyCount >= MONTHLY_LIMIT) {
    process.stderr.write(`[x-collector] Monthly limit reached (${monthlyCount}/${MONTHLY_LIMIT}). Skipping.\n`);
    appendHeartbeat('skip', { reason: 'monthly_limit', count: monthlyCount });
    return;
  }

  // Get user ID (cached in state)
  if (!state.userId) {
    process.stderr.write('[x-collector] Fetching user ID from /users/me...\n');
    state.userId = await getMyUserId();
  }
  const userId = state.userId;

  // Fetch timeline
  process.stderr.write('[x-collector] Fetching timeline...\n');
  const timeline = await fetchTweets(userId, 'tweets', state.timeline_since_id);
  const timelineTweets = timeline.tweets.filter(t => !isRetweet(t));
  stats.fetched += timeline.tweets.length;
  stats.skipped += timeline.tweets.length - timelineTweets.length;
  if (timeline.newestId) state.timeline_since_id = timeline.newestId;
  saveState(state); // checkpoint: save timeline since_id before fetching mentions

  // Fetch mentions
  process.stderr.write('[x-collector] Fetching mentions...\n');
  const mentions = await fetchTweets(userId, 'mentions', state.mentions_since_id);
  const mentionTweets = mentions.tweets;
  stats.fetched += mentions.tweets.length;
  if (mentions.newestId) state.mentions_since_id = mentions.newestId;
  saveState(state); // checkpoint: save mentions since_id

  // Merge user maps
  const allUsers = new Map([...timeline.users, ...mentions.users]);

  // Write raw JSON files
  const allTweets = [...timelineTweets, ...mentionTweets];
  for (const tweet of allTweets) {
    const rawPath = join(RAW_DIR, `${tweet.id}.json`);
    if (!existsSync(rawPath)) {
      writeFileSync(rawPath, JSON.stringify(tweet, null, 2), 'utf8');
      stats.new++;
    }
  }

  // Generate digest
  const today = new Date().toISOString().slice(0, 10);
  const digestContent = buildDigest(timelineTweets, mentionTweets, allUsers, today);
  const digestPath = join(DIGESTS_DIR, `${today}.md`);
  writeFileSync(digestPath, digestContent, 'utf8');

  // Update state
  state.monthly_tweet_count = monthlyCount + stats.fetched;
  state.last_run = new Date().toISOString();
  saveState(state);

  // Heartbeat
  appendHeartbeat('sync', { stats, digest: digestPath });

  process.stderr.write(
    `[x-collector] Done. fetched=${stats.fetched} new=${stats.new} skipped=${stats.skipped} digest=${digestPath}\n`
  );
}

main().catch(err => {
  process.stderr.write(`[x-collector] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
