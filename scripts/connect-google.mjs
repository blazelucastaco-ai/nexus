#!/usr/bin/env node
// One-time: link NEXUS to your Google account (read-only Gmail + Calendar).
//
//   1. In Google Cloud Console: create an OAuth client (type "Desktop app"),
//      enable the Gmail API and Google Calendar API.
//   2. Add to ~/.nexus/.env:
//        GOOGLE_CLIENT_ID=...
//        GOOGLE_CLIENT_SECRET=...
//   3. Run:  node scripts/connect-google.mjs   →  approve in the browser.
//
// A refresh token is saved to ~/.nexus/google.json. After that, NEXUS can read
// your calendar and email. Nothing here is sent anywhere but Google.
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { exec } from 'node:child_process';

async function loadEnvCreds() {
  let id = process.env.GOOGLE_CLIENT_ID;
  let secret = process.env.GOOGLE_CLIENT_SECRET;
  try {
    const env = await readFile(join(homedir(), '.nexus', '.env'), 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^\s*(GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET)\s*=\s*(.+?)\s*$/);
      if (m) {
        const val = m[2].replace(/^["']|["']$/g, '');
        if (m[1] === 'GOOGLE_CLIENT_ID') id = id || val;
        else secret = secret || val;
      }
    }
  } catch {
    /* no .env — rely on process env */
  }
  return { id, secret };
}

const { id: CLIENT_ID, secret: CLIENT_SECRET } = await loadEnvCreds();
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Add them to ~/.nexus/.env first (see the header of this file).');
  process.exit(1);
}

const PORT = 4455;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  }).toString();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (!u.pathname.startsWith('/callback')) {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  const code = u.searchParams.get('code');
  if (!code) {
    res.writeHead(400);
    res.end('No authorization code received.');
    return;
  }
  try {
    const tokResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }),
    });
    const tok = await tokResp.json();
    if (!tok.refresh_token) {
      res.writeHead(200);
      res.end('No refresh token returned. Revoke access at myaccount.google.com/permissions and run this again.');
      console.error('No refresh token:', tok);
      server.close();
      process.exit(1);
    }
    await writeFile(join(homedir(), '.nexus', 'google.json'), JSON.stringify({ refresh_token: tok.refresh_token }, null, 2));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>NEXUS is connected to your Google account.</h2><p>You can close this tab.</p>');
    console.log('✓ Connected. Refresh token saved to ~/.nexus/google.json');
    server.close();
    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    res.writeHead(500);
    res.end('Token exchange failed: ' + (err?.message ?? err));
    console.error(err);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('Opening Google consent in your browser…');
  console.log('If it does not open, visit:\n' + authUrl + '\n');
  exec(`open "${authUrl}"`);
});
