---
id: gmail-to-vault
name: Gmail-to-Vault
version: 0.1.0
description: Gmail emails (unread / starred / any query) -> vault daily digests
category: sense
secrets:
  - name: GMAIL_CLIENT_ID
    description: Google OAuth 2.0 client ID (Desktop app type)
    where: https://console.cloud.google.com -> APIs & Services -> Credentials -> Create OAuth client ID -> Desktop app
  - name: GMAIL_CLIENT_SECRET
    description: Google OAuth 2.0 client secret (paired with GMAIL_CLIENT_ID)
    where: same credential entry as GMAIL_CLIENT_ID
  - name: GMAIL_REFRESH_TOKEN
    description: Long-lived OAuth refresh token obtained via gmail-setup.ts
    where: run `bun run recipes/collectors/gmail-setup.ts` once after setting CLIENT_ID + CLIENT_SECRET
health_checks:
  - command: 'curl -sf -X POST https://oauth2.googleapis.com/token -d "client_id=$GMAIL_CLIENT_ID&client_secret=$GMAIL_CLIENT_SECRET&refresh_token=$GMAIL_REFRESH_TOKEN&grant_type=refresh_token" | grep -q "access_token" && echo OK'
setup_time: 15 min (one-time OAuth flow)
cost_estimate: "$0 (Gmail API free tier, 1B units/day quota)"
requires: []
---

# Gmail-to-Vault

Fetches Gmail messages matching a configurable query and writes dated digest notes
to `04-Research/email-digest/`.

Emails are grouped by sender domain and include subject, date, and snippet so your
inbox lands in the knowledge graph and gets compiled with the rest of your vault.

## What it does

- Fetches messages matching `GMAIL_QUERY` since the last run
- Default query: `is:unread` — only unseen mail
- Extracts sender, subject, date, snippet per message
- Groups by sender domain in the digest for easy scanning
- Tracks `last_synced` timestamp for incremental syncs (no duplicates)
- Outputs `~/.vault-mind/recipes/gmail-to-vault/digests/YYYY-MM-DD.md`

## Prerequisites

1. A Google account with Gmail
2. A Google Cloud project with the Gmail API enabled
3. An OAuth 2.0 Desktop app credential
4. A refresh token obtained by running the one-time setup script

## Output location

```
~/.vault-mind/recipes/gmail-to-vault/
  digests/YYYY-MM-DD.md   -- dated digest (compile.py input)
  state.json               -- last_synced timestamp cursor
  heartbeat.log            -- sync log
```

## Setup

### Step 1: Create a Google Cloud project and enable Gmail API

1. Go to https://console.cloud.google.com
2. Create a new project (or select an existing one)
3. Navigate to **APIs & Services -> Library**
4. Search for "Gmail API" and click **Enable**

### Step 2: Create OAuth 2.0 credentials

1. Go to **APIs & Services -> Credentials**
2. Click **+ Create Credentials -> OAuth client ID**
3. Application type: **Desktop app**
4. Name it anything (e.g. "vault-mind")
5. Click **Create** and copy the **Client ID** and **Client Secret**

### Step 3: Set client credentials

```bash
export GMAIL_CLIENT_ID="your-client-id.apps.googleusercontent.com"
export GMAIL_CLIENT_SECRET="GOCSPX-your-secret"
```

### Step 4: Run the one-time setup script to get a refresh token

```bash
GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=xxx bun run recipes/collectors/gmail-setup.ts
```

This opens your browser, asks you to sign in and grant permission to read Gmail,
then prints your `GMAIL_REFRESH_TOKEN`. The token is durable -- save it somewhere
safe (e.g. a `.env` file or password manager). You only need to run this once.

### Step 5: Set the refresh token

```bash
export GMAIL_REFRESH_TOKEN="your-refresh-token"
```

### Step 6: (Optional) Customize the query

Default: fetch unread mail. Override with any Gmail search query:

```bash
# Starred mail
export GMAIL_QUERY="is:starred"

# Mail from a specific domain
export GMAIL_QUERY="from:@notion.so OR from:@linear.app"

# All mail in last N days (uses last_synced by default -- this overrides)
export GMAIL_QUERY="newer_than:1d"
```

### Step 7: Run first sync

```bash
GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=xxx GMAIL_REFRESH_TOKEN=xxx \
  bun run recipes/collectors/gmail-collector.ts
```

## Cron schedule

```
# Every 30 minutes
*/30 * * * * cd <VAULT_MIND_DIR> && GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=xxx GMAIL_REFRESH_TOKEN=xxx bun run recipes/collectors/gmail-collector.ts >> ~/.vault-mind/recipes/gmail-to-vault/cron.log 2>&1

# Compile digests -> vault 3x/day
0 8,14,22 * * * cd <VAULT_MIND_DIR> && python mcp-server/kb_meta.py compile 04-Research/email-digest --tier haiku >> ~/.vault-mind/recipes/gmail-to-vault/compile.log 2>&1
```

## Troubleshooting

**`GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN is required`**: All three secrets must be set before running.

**`invalid_grant`**: The refresh token has been revoked or is invalid. Re-run `gmail-setup.ts` to get a new one. This happens if you revoke access in Google Account settings or the token is unused for 6 months (personal accounts only).

**`insufficient authentication scopes`**: The refresh token was obtained with a narrower scope. Re-run `gmail-setup.ts` -- it requests `https://www.googleapis.com/auth/gmail.readonly`.

**`quotaExceeded`**: Gmail API has a default quota of 1B units/day. Each `messages.get` costs 5 units. With `GMAIL_MAX_RESULTS=50` and a 30-min cron that is ~7,200 units/day -- well within limits. If you hit quota, reduce `GMAIL_MAX_RESULTS` or increase the cron interval.

**`redirect_uri_mismatch`**: The setup script uses `http://localhost:PORT/callback`. Ensure the Google Cloud credential has `http://localhost` added to the Authorized redirect URIs (or just leave it set to Desktop app type, which allows arbitrary localhost ports).
