#!/usr/bin/env bun
// linear-collector.ts — Linear GraphQL API collector for recently updated issues
// Fetches issues updated since last run and writes daily digests grouped by state.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IssueState {
  name: string;
  type: string;
}

interface IssueAssignee {
  name: string;
}

interface IssueTeam {
  name: string;
  key: string;
}

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  state: IssueState;
  assignee: IssueAssignee | null;
  team: IssueTeam;
  priority: number;
  url: string;
  createdAt: string;
  updatedAt: string;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface IssuesConnection {
  nodes: LinearIssue[];
  pageInfo: PageInfo;
}

interface GraphQLResponse {
  data?: { issues: IssuesConnection };
  errors?: Array<{ message: string }>;
}

interface CollectorState {
  last_run: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LINEAR_API_KEY = process.env.LINEAR_API_KEY ?? '';
const LINEAR_TEAMS = process.env.LINEAR_TEAMS
  ? process.env.LINEAR_TEAMS.split(',').map(s => s.trim()).filter(Boolean)
  : [];
const LINEAR_LOOKBACK_DAYS = parseInt(process.env.LINEAR_LOOKBACK_DAYS ?? '1', 10);

const LINEAR_GQL_URL = 'https://api.linear.app/graphql';

const BASE_DIR = join(homedir(), '.vault-mind', 'recipes', 'linear-to-vault');
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
  const heartbeatFile = join(BASE_DIR, 'heartbeat.log');
  appendFileSync(heartbeatFile, `${new Date().toISOString()} ${line}\n`, 'utf-8');
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Priority labels
// ---------------------------------------------------------------------------

function priorityLabel(priority: number): string {
  // emoji map per spec: 0=no priority, 1=urgent, 2=high, 3=medium, 4=low
  const emojiMap: Record<number, string> = {
    1: 'P0',
    2: 'P1',
    3: 'P2',
    4: 'P3',
    0: 'P4',
  };
  return emojiMap[priority] ?? `P${priority}`;
}

function priorityEmoji(priority: number): string {
  const map: Record<number, string> = {
    1: '\uD83D\uDD34',  // red circle  — Urgent/P0
    2: '\uD83D\uDFE0',  // orange circle — High/P1
    3: '\uD83D\uDFE1',  // yellow circle — Medium/P2
    4: '\uD83D\uDD35',  // blue circle  — Low/P3
    0: '\u26AA',         // white/grey circle — No priority/P4
  };
  return map[priority] ?? '\u26AA';
}

function formatPriority(priority: number): string {
  return `${priorityEmoji(priority)}${priorityLabel(priority)}`;
}

// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------

const ISSUES_QUERY = `
query IssuesUpdated($updatedAfter: DateTime, $teamFilter: TeamFilter, $after: String) {
  issues(
    filter: {
      updatedAt: { gt: $updatedAfter }
      team: $teamFilter
    }
    orderBy: updatedAt
    first: 50
    after: $after
  ) {
    nodes {
      id
      identifier
      title
      state { name type }
      assignee { name }
      team { name key }
      priority
      url
      createdAt
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}
`;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function fetchIssuesPage(
  updatedAfter: string,
  teamFilter: Record<string, unknown> | null,
  after: string | null,
): Promise<IssuesConnection> {
  const variables: Record<string, unknown> = { updatedAfter };
  if (teamFilter) variables.teamFilter = teamFilter;
  if (after) variables.after = after;

  const res = await fetch(LINEAR_GQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: LINEAR_API_KEY,
    },
    body: JSON.stringify({ query: ISSUES_QUERY, variables }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from Linear GraphQL`);
  }

  const json = (await res.json()) as GraphQLResponse;

  if (json.errors && json.errors.length > 0) {
    const msgs = json.errors.map(e => e.message).join('\n');
    process.stderr.write(`[linear] GraphQL errors:\n${msgs}\n`);
    process.exit(1);
  }

  if (!json.data) {
    throw new Error('Linear GraphQL returned no data');
  }

  return json.data.issues;
}

async function fetchAllIssues(
  updatedAfter: string,
  teamFilter: Record<string, unknown> | null,
): Promise<LinearIssue[]> {
  const all: LinearIssue[] = [];
  let cursor: string | null = null;

  do {
    const page = await fetchIssuesPage(updatedAfter, teamFilter, cursor);
    all.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? null) : null;
  } while (cursor !== null);

  return all;
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

type StateGroup = 'started' | 'unstarted' | 'completed' | 'cancelled' | 'other';

function classifyStateType(stateType: string): StateGroup {
  const t = stateType.toLowerCase();
  if (t === 'started') return 'started';
  if (t === 'unstarted') return 'unstarted';
  if (t === 'completed') return 'completed';
  if (t === 'cancelled') return 'cancelled';
  return 'other';
}

const STATE_LABELS: Record<StateGroup, string> = {
  started: 'Active',
  unstarted: 'New',
  completed: 'Completed',
  cancelled: 'Cancelled',
  other: 'Other',
};

function buildIssueBlock(group: StateGroup, issues: LinearIssue[]): string {
  if (issues.length === 0) return '';
  const label = STATE_LABELS[group];
  const lines = issues.map(issue => {
    const assignee = issue.assignee ? issue.assignee.name : 'unassigned';
    const prio = formatPriority(issue.priority);
    return `- [${issue.identifier}] ${issue.title} (${assignee}) -- ${prio} | ${issue.url}`;
  });
  return [`## ${label} (${issues.length})`, ...lines, ''].join('\n');
}

function buildDigest(issues: LinearIssue[]): string {
  const date = todayStr();

  const frontmatter = [
    '---',
    `date: ${date}`,
    `source: linear-to-vault`,
    `type: digest`,
    `issues_updated: ${issues.length}`,
    '---',
    '',
  ].join('\n');

  const grouped: Record<StateGroup, LinearIssue[]> = {
    started: [],
    unstarted: [],
    completed: [],
    cancelled: [],
    other: [],
  };

  for (const issue of issues) {
    const g = classifyStateType(issue.state.type);
    grouped[g].push(issue);
  }

  const order: StateGroup[] = ['started', 'unstarted', 'completed', 'cancelled', 'other'];
  const blocks = order
    .map(g => buildIssueBlock(g, grouped[g]))
    .filter(b => b.length > 0)
    .join('\n');

  return frontmatter + blocks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!LINEAR_API_KEY) {
    process.stderr.write(
      '[linear] error: LINEAR_API_KEY is required.\n' +
      'Create an API key at https://linear.app/settings/api\n' +
      'Set it with: export LINEAR_API_KEY=lin_api_xxx\n',
    );
    process.exit(1);
  }

  ensureDirs();

  const state = loadState();
  const updatedAfter = state?.last_run
    ?? new Date(Date.now() - LINEAR_LOOKBACK_DAYS * 86400000).toISOString();

  const teamFilter: Record<string, unknown> | null =
    LINEAR_TEAMS.length > 0
      ? { key: { in: LINEAR_TEAMS } }
      : null;

  process.stdout.write(`[linear] fetching issues updated after ${updatedAfter}\n`);

  const issues = await fetchAllIssues(updatedAfter, teamFilter);

  if (issues.length === 0) {
    process.stdout.write('[linear] no updated issues found\n');
    saveState({ last_run: new Date().toISOString() });
    appendHeartbeat('ok issues=0');
    return;
  }

  process.stdout.write(`[linear] fetched ${issues.length} updated issues\n`);

  const digest = buildDigest(issues);
  const digestPath = join(DIGESTS_DIR, `${todayStr()}.md`);
  writeFileSync(digestPath, digest, 'utf-8');
  process.stdout.write(`[linear] digest written to ${digestPath}\n`);

  saveState({ last_run: new Date().toISOString() });
  appendHeartbeat(`ok issues=${issues.length}`);
}

main().catch(err => {
  process.stderr.write(`[linear] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
