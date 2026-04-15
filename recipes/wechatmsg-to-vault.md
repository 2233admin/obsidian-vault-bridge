---
id: wechatmsg-to-vault
name: WeChatMsg-to-Vault
version: 0.1.0
description: WeChat chat history (via WeChatMsg) -> vault chat digests
category: sense
secrets: []
health_checks:
  - command: 'curl -sf http://localhost:5000/api/getContactList | grep -q "UserName" && echo OK'
setup_time: 30 min (WeChat DB decryption)
cost_estimate: "$0 (local)"
requires: []
---

# WeChatMsg-to-Vault

Reads WeChat group chat history from [WeChatMsg](https://github.com/LC044/WeChatMsg)'s local
HTTP API and writes dated digest notes to `04-Research/chat-digest/`.

WeChatMsg decrypts WeChat's local SQLite database (no cloud API required) and exposes it
via an HTTP server on port 5000. This collector is read-only -- it never writes to WeChat
or WeChatMsg.

## What it does

- Auto-discovers all WeChat group chats, or reads from `WECHATMSG_CONTACTS` if set
- Tracks `since_time` per contact for incremental syncs (no duplicates)
- Handles text, image, voice, video, file, and system message types
- Paginates through full history on first run; incremental on subsequent runs
- Outputs `~/.vault-mind/recipes/wechatmsg-to-vault/digests/YYYY-MM-DD.md`

## Prerequisites

1. Windows PC with WeChat (PC client) installed and logged in
2. WeChatMsg installed and run as administrator (it auto-decrypts the DB and starts the HTTP server)
3. Important: WeChat history must be on the **same machine** running WeChatMsg -- WeChatMsg reads local files only

## Output location

```
~/.vault-mind/recipes/wechatmsg-to-vault/
  digests/YYYY-MM-DD.md   -- dated digest (compile.py input)
  state.json               -- per-contact since_time cursor
  heartbeat.jsonl          -- sync log
```

## Setup

### Step 1: Install WeChatMsg

Download the latest release from https://github.com/LC044/WeChatMsg/releases.
Extract and run `WeChatMsg.exe` as administrator.

### Step 2: Decrypt WeChat database

WeChatMsg will automatically detect and decrypt WeChat's local database on first launch.
This may take a minute. Wait for the main UI to appear and show your contacts.

### Step 3: Verify the HTTP server

WeChatMsg starts a local HTTP server on port 5000 automatically. Verify:

```bash
curl http://localhost:5000/api/getContactList
```

Expected: JSON with a list of contacts including `UserName` and `NickName` fields.

### Step 4: (Optional) Pin specific contacts or groups

By default the collector auto-discovers all WeChat group chats (Type=2).
To include specific contacts by their `wxid_xxx` or room ID:

```bash
export WECHATMSG_CONTACTS="12345678@chatroom,wxid_abc123"
```

### Step 5: (Optional) Adjust lookback window

Controls how far back the first run reaches. Default is 1 day.

```bash
export WECHATMSG_LOOKBACK_DAYS=7
```

### Step 6: (Optional) Override server URL

Default is `http://localhost:5000`. Override if WeChatMsg runs on a different port:

```bash
export WECHATMSG_URL="http://localhost:5001"
```

### Step 7: Run first sync

```bash
bun run recipes/collectors/wechatmsg-collector.ts
```

## Cron schedule

```
# Every 30 minutes (Windows Task Scheduler or WSL cron)
*/30 * * * * cd <VAULT_MIND_DIR> && bun run recipes/collectors/wechatmsg-collector.ts >> ~/.vault-mind/recipes/wechatmsg-to-vault/cron.log 2>&1

# Compile digests -> vault 3x/day
0 8,14,22 * * * cd <VAULT_MIND_DIR> && python mcp-server/kb_meta.py compile 04-Research/chat-digest --tier haiku >> ~/.vault-mind/recipes/wechatmsg-to-vault/compile.log 2>&1
```

## Troubleshooting

**`WeChatMsg server at http://localhost:5000 not responding`**: WeChatMsg is not running or has not fully loaded. Start it as administrator and wait for the UI to appear before running the collector.

**`getContactList code=...`**: WeChatMsg is running but the DB has not been decrypted yet. Wait for WeChatMsg to finish the initial scan, then retry.

**No group chats found**: WeChat has no group chats on this machine, or they have not synced to the local DB. Open WeChat PC client and scroll through your group chats to force a local sync, then retry.

**`getChatHistory ... code=404`**: The contact ID is no longer in WeChat's local DB (may have been deleted or the group disbanded). Remove it from `WECHATMSG_CONTACTS`.

**Collector works but shows old messages only**: WeChat PC must remain open and synced. If WeChat was closed for a period, messages from that period may not be in the local DB.
