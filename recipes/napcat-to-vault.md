---
id: napcat-to-vault
name: NapCat-to-Vault
version: 0.1.0
description: QQ group messages (via NapCatQQ OneBot v11) -> vault chat digests
category: sense
secrets:
  - name: NAPCAT_TOKEN
    description: NapCatQQ HTTP access token
    where: NapCatQQ config file -> httpServer -> token
health_checks:
  - command: 'curl -sf -X POST http://localhost:3000/get_bot_info -H "Authorization: Bearer $NAPCAT_TOKEN" | grep -q "user_id" && echo OK'
setup_time: 10 min (after NapCatQQ running)
cost_estimate: "$0 (local)"
requires: []
---

# NapCat-to-Vault

Polls QQ group messages from a local [NapCatQQ](https://github.com/NapNeko/NapCatQQ) server
via the OneBot v11 HTTP API and writes dated digest notes to `04-Research/chat-digest/`.

NapCatQQ is an QQNT-based QQ protocol implementation that exposes a standard OneBot v11
HTTP endpoint. This is a direct path to QQ messages -- an alternative to voile-to-vault
when the Voile database is not set up.

## What it does

- Auto-discovers all QQ groups the bot is in, or reads from `NAPCAT_GROUPS` if set
- Tracks `since_time` per group for incremental syncs (no duplicates)
- Extracts text, @mentions, images, voice, stickers from CQ segment arrays
- Checkpoints state after each group (safe to interrupt and resume)
- Outputs `~/.vault-mind/recipes/napcat-to-vault/digests/YYYY-MM-DD.md`

## Prerequisites

1. Install NapCatQQ from https://github.com/NapNeko/NapCatQQ (follow release instructions for your QQNT version)
2. Enable the HTTP server in NapCatQQ config and set a token
3. Log in to QQ via NapCatQQ and add the bot to the groups you want to monitor
4. Confirm the HTTP server is reachable on port 3000

## Output location

```
~/.vault-mind/recipes/napcat-to-vault/
  digests/YYYY-MM-DD.md   -- dated digest (compile.py input)
  state.json               -- per-group since_time cursor
  heartbeat.log            -- sync log
```

## Setup

### Step 1: Install and start NapCatQQ

Follow the official guide at https://github.com/NapNeko/NapCatQQ.
NapCatQQ requires the QQNT desktop client to be installed.

### Step 2: Enable HTTP server and set token

In NapCatQQ's config file (typically `config/onebot11_<qq>.json`):

```json
{
  "httpServer": {
    "enable": true,
    "port": 3000,
    "token": "your-secret-token"
  }
}
```

Restart NapCatQQ after editing the config.

### Step 3: Set credentials

```bash
export NAPCAT_TOKEN="your-secret-token"
```

### Step 4: (Optional) Pin specific groups

By default the collector auto-discovers all groups the bot is in.
To limit to specific QQ group IDs:

```bash
export NAPCAT_GROUPS="123456789,987654321"
```

### Step 5: (Optional) Adjust lookback window

On first run the collector fetches the last N seconds. Default is 3600 (1 hour).

```bash
export NAPCAT_LOOKBACK_SECS=7200
```

### Step 6: Run first sync

```bash
NAPCAT_TOKEN=your-token bun run recipes/collectors/napcat-collector.ts
```

## Cron schedule

```
# Every 30 minutes
*/30 * * * * cd <VAULT_MIND_DIR> && NAPCAT_TOKEN=your-token bun run recipes/collectors/napcat-collector.ts >> ~/.vault-mind/recipes/napcat-to-vault/cron.log 2>&1

# Compile digests -> vault 3x/day
0 8,14,22 * * * cd <VAULT_MIND_DIR> && python mcp-server/kb_meta.py compile 04-Research/chat-digest --tier haiku >> ~/.vault-mind/recipes/napcat-to-vault/compile.log 2>&1
```

## Troubleshooting

**`NAPCAT_TOKEN is required`**: Set `export NAPCAT_TOKEN=<your-token>` before running.

**`HTTP 401`**: Token mismatch. Verify the token in NapCatQQ config matches `NAPCAT_TOKEN`.

**`HTTP 404` or connection refused**: NapCatQQ HTTP server is not running. Check config and restart NapCatQQ. Default URL is `http://localhost:3000`; override with `NAPCAT_URL`.

**`retcode=100` for a group**: The bot is not in that group. Add the QQ account to the group manually, or remove the group ID from `NAPCAT_GROUPS`.

**No groups found**: The QQ account is not in any groups, or `get_group_list` returned empty. Confirm QQ is logged in via NapCatQQ and at least one group exists.
