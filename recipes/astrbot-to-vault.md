---
id: astrbot-to-vault
name: AstrBot-to-Vault
version: 0.1.0
description: AstrBot conversation history -> vault bot interaction digests
category: sense
secrets: []
health_checks:
  - command: 'test -f "${ASTRBOT_DATA_DIR:-$HOME/AstrBot/data}/data.db" && echo OK'
setup_time: 5 min (after AstrBot running)
cost_estimate: "$0 (local SQLite read)"
requires: []
---

# AstrBot-to-Vault

Reads [AstrBot](https://github.com/Soulter/AstrBot) conversation logs directly from its
SQLite database and writes dated digest notes to `04-Research/astrbot-digest/`.

AstrBot is a multi-platform bot framework supporting QQ, WeChat, Telegram, and others.
This collector captures bot **conversations** -- what users asked the bot -- not general
platform chat. It reads SQLite directly; no AstrBot restart or API access needed.

## What it does

- Reads from AstrBot's `data.db` SQLite file (read-only, no side effects)
- Auto-detects the conversation table and adapts to different AstrBot schema versions
- Filters to user-role messages; optionally filters by platform via `ASTRBOT_PLATFORMS`
- Groups messages by platform and session for easy review
- Outputs `~/.vault-mind/recipes/astrbot-to-vault/digests/YYYY-MM-DD.md`

## Prerequisites

1. [AstrBot](https://github.com/Soulter/AstrBot) installed and running with at least one conversation recorded
2. Bun runtime (for `bun:sqlite`)
3. Read access to the AstrBot data directory

## Output location

```
~/.vault-mind/recipes/astrbot-to-vault/
  digests/YYYY-MM-DD.md   -- dated digest (compile.py input)
  state.json               -- since_time cursor
  heartbeat.jsonl          -- sync log
```

## Setup

### Step 1: Confirm AstrBot data directory

Default paths:
- **Windows**: `C:\Users\<username>\AstrBot\data\`
- **Linux/Mac**: `~/.astrbot/data/`

Verify the database exists:

```bash
# Windows (Git Bash)
ls ~/AstrBot/data/data.db

# Linux/Mac
ls ~/.astrbot/data/data.db
```

### Step 2: (Optional) Override data directory

If AstrBot stores data elsewhere:

```bash
export ASTRBOT_DATA_DIR="/path/to/astrbot/data"
```

Tilde expansion is supported: `export ASTRBOT_DATA_DIR="~/custom/astrbot/data"`.

### Step 3: (Optional) Filter to specific platforms

By default all platforms are included. To restrict:

```bash
export ASTRBOT_PLATFORMS="qq,wechat"
```

Platform names match the `platform` column in AstrBot's DB (e.g., `qq`, `telegram`, `wechat`).

### Step 4: (Optional) Adjust lookback window

Controls how far back the first run reaches. Default is 1 day.

```bash
export ASTRBOT_LOOKBACK_DAYS=7
```

### Step 5: Run first sync

```bash
bun run recipes/collectors/astrbot-collector.ts
```

## Cron schedule

```
# Every 30 minutes
*/30 * * * * cd <VAULT_MIND_DIR> && bun run recipes/collectors/astrbot-collector.ts >> ~/.vault-mind/recipes/astrbot-to-vault/cron.log 2>&1

# Compile digests -> vault 3x/day
0 8,14,22 * * * cd <VAULT_MIND_DIR> && python mcp-server/kb_meta.py compile 04-Research/astrbot-digest --tier haiku >> ~/.vault-mind/recipes/astrbot-to-vault/compile.log 2>&1
```

## Troubleshooting

**`database not found at ...`**: AstrBot has not run yet or data is stored at a non-default path. Set `ASTRBOT_DATA_DIR` to the correct directory. Common alternate locations: `D:\AstrBot\data` (Windows), `/opt/astrbot/data` (Linux server).

**`no conversation table found`**: The DB exists but no conversations have been recorded yet, or AstrBot's schema differs significantly from expected. The collector prints all available table names -- share them when filing a bug.

**`query failed`**: Schema mismatch (AstrBot updated its DB format). The collector auto-detects optional columns (`platform`, `sender_id`, `role`) but requires `session_id`, `content`, and `create_time`. Check table structure with `bun -e "import {Database} from 'bun:sqlite'; const db = new Database('data.db'); console.log(db.query('PRAGMA table_info(messages)').all())"`.

**No messages after platform filter**: The platform name in `ASTRBOT_PLATFORMS` does not match the value stored in the DB. Check what values exist: `SELECT DISTINCT platform FROM <table>`.

**Digest is empty despite AstrBot having conversations**: `create_time` values in the DB may use milliseconds instead of seconds. Check: if times are around `1700000000000`, the DB uses ms. File an issue -- the collector currently assumes Unix seconds.
