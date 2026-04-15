---
id: linear-to-vault
name: Linear-to-Vault
version: 0.1.0
description: Linear issue activity -> vault project digests
category: sense
secrets:
  - name: LINEAR_API_KEY
    description: Linear personal API key (lin_api_xxx)
    where: https://linear.app/settings/api -> Personal API keys -> Create key
health_checks:
  - command: 'curl -sf -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" -X POST https://api.linear.app/graphql -d "{\"query\":\"{viewer{id}}\"}" | grep -q "id" && echo OK'
setup_time: 5 min
cost_estimate: "$0 (Linear API free tier)"
requires: []
---

# Linear-to-Vault

Fetches recently updated issues from [Linear](https://linear.app) via the GraphQL API
and writes dated digest notes to `04-Research/linear-digest/`.

Issues are grouped by state type (started / unstarted / completed / cancelled) with
priority emoji so you can scan project health at a glance.

## What it does

- Fetches all issues updated since the last run (default: last 1 day on first run)
- Filters by team key if `LINEAR_TEAMS` is set; otherwise fetches all teams
- Groups issues by state type with priority indicators
- Tracks `last_run` timestamp for incremental syncs (no duplicates)
- Outputs `~/.vault-mind/recipes/linear-to-vault/digests/YYYY-MM-DD.md`

## Prerequisites

1. A Linear account with at least one team and some issues
2. A personal API key from https://linear.app/settings/api

## Output location

```
~/.vault-mind/recipes/linear-to-vault/
  digests/YYYY-MM-DD.md   -- dated digest (compile.py input)
  state.json               -- last_run timestamp cursor
  heartbeat.log            -- sync log
```

## Setup

### Step 1: Create a Linear personal API key

Go to https://linear.app/settings/api, scroll to **Personal API keys**, and click
**Create key**. Copy the key -- it starts with `lin_api_`.

### Step 2: Set the API key

```bash
export LINEAR_API_KEY="lin_api_your_key_here"
```

### Step 3: (Optional) Filter to specific teams

By default all teams the key can access are included. To restrict to specific team keys
(shown in Linear URLs as `https://linear.app/<team-key>/...`):

```bash
export LINEAR_TEAMS="eng,design"
```

### Step 4: (Optional) Adjust lookback window

Controls how far back the first run reaches. Default is 1 day.

```bash
export LINEAR_LOOKBACK_DAYS=7
```

Note: the Linear API returns issues ordered by `updatedAt`. The first run fetches
N days of activity; subsequent runs fetch only what changed since the last sync.

### Step 5: Run first sync

```bash
LINEAR_API_KEY=lin_api_xxx bun run recipes/collectors/linear-collector.ts
```

## Cron schedule

```
# Every 30 minutes
*/30 * * * * cd <VAULT_MIND_DIR> && LINEAR_API_KEY=lin_api_xxx bun run recipes/collectors/linear-collector.ts >> ~/.vault-mind/recipes/linear-to-vault/cron.log 2>&1

# Compile digests -> vault 3x/day
0 8,14,22 * * * cd <VAULT_MIND_DIR> && python mcp-server/kb_meta.py compile 04-Research/linear-digest --tier haiku >> ~/.vault-mind/recipes/linear-to-vault/compile.log 2>&1
```

## Troubleshooting

**`LINEAR_API_KEY is required`**: Set `export LINEAR_API_KEY=lin_api_xxx` before running.

**`401 Unauthorized`**: API key is invalid or has been revoked. Generate a new one at https://linear.app/settings/api.

**`GraphQL errors: Field 'issues' doesn't exist`**: API schema mismatch. Check that `LINEAR_API_KEY` is a personal key, not an OAuth token or workspace key.

**No issues found**: Either no issues were updated in the lookback window, or the team key filter does not match. Try increasing `LINEAR_LOOKBACK_DAYS` or clearing `LINEAR_TEAMS`.

**Rate limit (`429`)**: Linear's free tier allows up to 1,500 requests/hour. The 30-minute cron schedule is well within limits for most teams.
