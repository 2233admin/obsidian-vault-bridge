#!/usr/bin/env bun
// gmail-setup.ts -- One-time OAuth 2.0 setup to obtain a Gmail refresh token.
// Run once, save the printed GMAIL_REFRESH_TOKEN, never run again.
//
// Usage:
//   GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=xxx bun run recipes/collectors/gmail-setup.ts

import { createServer } from 'node:http';

const CLIENT_ID = process.env.GMAIL_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET ?? '';

if (!CLIENT_ID || !CLIENT_SECRET) {
  process.stderr.write(
    '[gmail-setup] error: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET are required.\n' +
    'Create a Desktop app credential at https://console.cloud.google.com -> APIs & Services -> Credentials\n',
  );
  process.exit(1);
}

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const PORT = 9876;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

// ---------------------------------------------------------------------------
// Build authorization URL
// ---------------------------------------------------------------------------

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent'); // force refresh_token issuance

process.stdout.write('[gmail-setup] Opening browser for Google OAuth consent...\n');
process.stdout.write(`[gmail-setup] If the browser does not open, visit:\n  ${authUrl.toString()}\n\n`);

// Open browser (cross-platform)
const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
Bun.spawnSync([opener, authUrl.toString()], { shell: true });

// ---------------------------------------------------------------------------
// Local redirect server — waits for the authorization code
// ---------------------------------------------------------------------------

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const error = url.searchParams.get('error');
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h2>OAuth error: ${error}</h2><p>You can close this tab.</p>`);
      server.close();
      reject(new Error(`OAuth error: ${error}`));
      return;
    }

    const authCode = url.searchParams.get('code');
    if (!authCode) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h2>No code in response</h2><p>You can close this tab.</p>');
      server.close();
      reject(new Error('No authorization code in callback'));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Authorization successful</h2><p>You can close this tab and return to the terminal.</p>');
    server.close();
    resolve(authCode);
  });

  server.listen(PORT, () => {
    process.stdout.write(`[gmail-setup] Waiting for OAuth callback on http://localhost:${PORT}/callback ...\n`);
  });

  // Timeout after 5 minutes
  setTimeout(() => {
    server.close();
    reject(new Error('OAuth callback timed out after 5 minutes'));
  }, 5 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// Exchange authorization code for tokens
// ---------------------------------------------------------------------------

process.stdout.write('[gmail-setup] Exchanging authorization code for tokens...\n');

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }),
});

if (!tokenRes.ok) {
  const body = await tokenRes.text();
  process.stderr.write(`[gmail-setup] Token exchange failed (HTTP ${tokenRes.status}): ${body}\n`);
  process.exit(1);
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

const tokens = (await tokenRes.json()) as TokenResponse;

if (!tokens.refresh_token) {
  process.stderr.write(
    '[gmail-setup] No refresh_token in response.\n' +
    'This happens if you previously authorized this app without prompt=consent.\n' +
    'Go to https://myaccount.google.com/permissions, revoke access for this app, then re-run.\n',
  );
  process.exit(1);
}

process.stdout.write('\n============================================================\n');
process.stdout.write('SUCCESS -- save this refresh token in your environment:\n\n');
process.stdout.write(`export GMAIL_REFRESH_TOKEN="${tokens.refresh_token}"\n`);
process.stdout.write('\n============================================================\n');
process.stdout.write('You do NOT need to run this script again.\n');
process.stdout.write('The refresh token is durable until manually revoked.\n');
