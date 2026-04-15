---
id: weflow-to-vault
name: WeFlow-to-Vault
version: 0.1.0
description: WeChat messages (via WeFlow HTTP gateway) -> vault chat digests
category: sense
secrets:
  - name: WEFLOW_TOKEN
    description: WeFlow HTTP access token (optional, if configured)
    where: WeFlow config file
health_checks:
  - command: 'curl -sf ${WEFLOW_URL:-http://localhost:9898}/api/rooms | grep -q "data" && echo OK'
setup_time: 10 min
cost_estimate: "$0 (local)"
requires: []
---

# WeFlow-to-Vault

Reads WeChat messages from a local [WeFlow](https://github.com/search?q=weflow+wechat) HTTP
gateway and writes dated digest notes to `04-Research/chat-digest/`.

WeFlow is a local WeChat HTTP API gateway that intercepts WeChat PC messages and exposes
a query API. This collector tries `/api/rooms` then `/api/contacts` for room discovery,
and `/api/messages` with both query-param and path-param variants for message history --
covering the range of WeFlow implementations in the wild.

## What it does

- Auto-discovers rooms via `/api/rooms` (falls back to `/api/contacts` on 404)
- Fetches message history with a two-attempt strategy per WeFlow variant
- Tracks `since_time` per room for incremental syncs (no duplicates)
- Maps image/voice/video types to readable placeholders (`[图片]`, `[语音]`, `[视频]`)
- Outputs `~/.vault-mind/recipes/weflow-to-vault/digests/YYYY-MM-DD.md`

## Prerequisites

1. WeFlow installed and running on the same machine as WeChat PC
2. WeChat PC client open and logged in
3. WeFlow configured to intercept WeChat messages

## Output location

```
~/.vault-mind/recipes/weflow-to-vault/
  digests/YYYY-MM-DD.md   -- dated digest (compile.py input)
  state.json               -- per-room since_time cursor
  heartbeat.jsonl          -- sync log
```

## Setup

### Step 1: Install and start WeFlow

Follow your WeFlow distribution's installation guide. WeFlow must be running before
any messages can be collected. Default port is 9898.

### Step 2: (Optional) Set auth token

If your WeFlow is configured with an access token:

```bash
export WEFLOW_TOKEN="your-weflow-token"
```

### Step 3: (Optional) Override server URL

Default is `http://localhost:9898`. Override if WeFlow runs on a different host or port:

```bash
export WEFLOW_URL="http://localhost:9898"
```

### Step 4: (Optional) Pin specific rooms

By default the collector auto-discovers all rooms WeFlow exposes.
To limit to specific room IDs:

```bash
export WEFLOW_ROOMS="room_id_1,room_id_2"
```

Room IDs are the `id` field returned by `/api/rooms` or `/api/contacts`.

### Step 5: (Optional) Adjust lookback window

Controls how far back the first run reaches. Default is 3600 seconds (1 hour).

```bash
export WEFLOW_LOOKBACK_SECS=86400
```

### Step 6: Run first sync

```bash
bun run recipes/collectors/weflow-collector.ts
```

## Cron schedule

```
# Every 30 minutes
*/30 * * * * cd <VAULT_MIND_DIR> && bun run recipes/collectors/weflow-collector.ts >> ~/.vault-mind/recipes/weflow-to-vault/cron.log 2>&1

# Compile digests -> vault 3x/day
0 8,14,22 * * * cd <VAULT_MIND_DIR> && python mcp-server/kb_meta.py compile 04-Research/chat-digest --tier haiku >> ~/.vault-mind/recipes/weflow-to-vault/compile.log 2>&1
```

## Troubleshooting

**`WeFlow server at http://localhost:9898 not responding`**: WeFlow is not running or is
listening on a different port. Start WeFlow and confirm the port, then set `WEFLOW_URL`
accordingly.

**`Both endpoints returned 404`**: Your WeFlow exposes different API paths than the
defaults (`/api/rooms`, `/api/contacts`, `/api/messages`). Check your WeFlow documentation
for the correct paths. You may need to set `WEFLOW_ROOMS` manually to skip auto-discovery
and adjust the message fetch URL if needed.

**No rooms found**: WeFlow is running but has not joined any WeChat groups or has not
received any messages yet. Confirm WeFlow is configured to intercept WeChat PC and that
at least one group chat has recent messages.

**`WARN: failed to fetch room <id>`**: Per-room errors are non-fatal. The collector
continues with remaining rooms. Check the error message for the specific room -- it may
have been deleted or WeFlow lost access to it.

**Messages appear duplicated**: The `since_time` cursor in `state.json` may have been
reset. Delete `~/.vault-mind/recipes/weflow-to-vault/state.json` and re-run with a
`WEFLOW_LOOKBACK_SECS` value that covers only the desired window.
