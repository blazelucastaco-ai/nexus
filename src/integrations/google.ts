// Google (Gmail + Calendar) integration — read-only, OAuth refresh-token flow.
//
// One-time setup (the only step that needs the user — Google's security requires
// an explicit grant, exactly like a wake word needs a mic):
//   1. Create a Google Cloud OAuth client (Desktop) and enable Gmail + Calendar APIs.
//   2. Put GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in ~/.nexus/.env.
//   3. Run `node scripts/connect-google.mjs` and approve — a refresh token is
//      saved to ~/.nexus/google.json. After that, calendar/email "just work".
//
// Everything here is plain fetch against Google's REST API — no extra npm deps.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Google');
const tokenPath = () => join(getDataDir(), 'google.json');

interface StoredToken {
  refresh_token: string;
}

let accessCache: { token: string; expiry: number } | null = null;

/** True when the OAuth client credentials are present (setup step 2 done). */
export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

async function loadRefreshToken(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(tokenPath(), 'utf8')) as StoredToken;
    return parsed.refresh_token || null;
  } catch {
    return null;
  }
}

/** A short, user-facing reason when Google isn't usable yet. null = ready. */
export async function googleNotReadyReason(): Promise<string | null> {
  if (!googleConfigured()) {
    return "Google isn't set up yet — add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to ~/.nexus/.env (from a Google Cloud OAuth client).";
  }
  if (!(await loadRefreshToken())) {
    return "Google isn't connected yet — run `node scripts/connect-google.mjs` once and approve access.";
  }
  return null;
}

async function getAccessToken(): Promise<string> {
  if (accessCache && accessCache.expiry > Date.now() + 60_000) return accessCache.token;
  const refresh = await loadRefreshToken();
  if (!refresh) throw new Error('NOT_CONNECTED');
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Google token refresh failed: HTTP ${resp.status}`);
  const data = (await resp.json()) as { access_token: string; expires_in: number };
  accessCache = { token: data.access_token, expiry: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

/** Upcoming Google Calendar events as a readable list. */
export async function readCalendar(daysAhead = 1): Promise<string> {
  const token = await getAccessToken();
  const now = new Date();
  const end = new Date(now.getTime() + Math.max(1, daysAhead) * 86_400_000);
  const url =
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?' +
    new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '15',
    }).toString();
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`Calendar API HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    items?: Array<{ summary?: string; location?: string; start?: { dateTime?: string; date?: string } }>;
  };
  const items = data.items ?? [];
  if (!items.length) return `Nothing on the calendar in the next ${daysAhead === 1 ? 'day' : `${daysAhead} days`}.`;
  const lines = items.map((e) => {
    const start = e.start?.dateTime
      ? new Date(e.start.dateTime).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      : (e.start?.date ?? 'all day');
    return `- ${e.summary ?? '(no title)'} — ${start}${e.location ? ` (${e.location})` : ''}`;
  });
  return `Upcoming events:\n${lines.join('\n')}\n(Relay these to the user naturally, like a person reading their day, not a raw list.)`;
}

/** Recent Gmail messages (default: unread) — sender, subject, snippet. */
export async function listEmails(query = 'is:unread', max = 8): Promise<string> {
  const token = await getAccessToken();
  const listUrl =
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?' +
    new URLSearchParams({ q: query, maxResults: String(Math.min(Math.max(max, 1), 15)) }).toString();
  const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!listResp.ok) throw new Error(`Gmail list HTTP ${listResp.status}`);
  const list = (await listResp.json()) as { messages?: Array<{ id: string }> };
  const ids = (list.messages ?? []).slice(0, max);
  if (!ids.length) return `No emails matching "${query}".`;
  const out: string[] = [];
  for (const { id } of ids) {
    try {
      const mResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
      );
      if (!mResp.ok) continue;
      const m = (await mResp.json()) as {
        snippet?: string;
        payload?: { headers?: Array<{ name: string; value: string }> };
      };
      const header = (n: string) => m.payload?.headers?.find((h) => h.name === n)?.value ?? '';
      out.push(`- From ${header('From')} — "${header('Subject')}": ${(m.snippet ?? '').slice(0, 140)}`);
    } catch (err) {
      log.warn({ err }, 'gmail message fetch failed');
    }
  }
  return out.length
    ? `${out.length} email(s):\n${out.join('\n')}\n(Summarize these for the user conversationally.)`
    : `No readable emails matching "${query}".`;
}
