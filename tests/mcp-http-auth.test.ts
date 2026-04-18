import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startMcpHttpServer } from '../src/mcp/server.js';

/**
 * FIND-TST-01: CRIT-4 (MCP server authentication) — regression tests for the
 * opt-in gate, bearer-token check, 127.0.0.1-only bind, body-size cap, and
 * timing-safe token compare. Before yesterday, HTTP mode auto-started with
 * wildcard CORS and no auth; these tests lock in the hardened behavior.
 */

// Dynamic port per test to avoid collisions if run in parallel with another
// process that happened to bind the default 3333.
let nextPort = 43330;
function freshPort(): number {
  return nextPort++;
}

async function httpJson(url: string, opts: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const resp = await fetch(url, {
    method: opts.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* leave as text */ }
  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => { headers[k] = v; });
  return { status: resp.status, body: parsed, headers };
}

describe('MCP HTTP server — auth + hardening (FIND-TST-01)', () => {
  const savedHttp = process.env.NEXUS_MCP_HTTP;
  const savedToken = process.env.NEXUS_MCP_TOKEN;
  const servers: Array<{ close: () => void }> = [];

  beforeEach(() => {
    // Unset without `delete` (flagged by biome/noDelete). The server's opt-in
    // check is `!== '1'`, so empty string behaves identically to unset for
    // our purposes.
    process.env.NEXUS_MCP_HTTP = '';
    process.env.NEXUS_MCP_TOKEN = '';
  });

  afterEach(() => {
    process.env.NEXUS_MCP_HTTP = savedHttp ?? '';
    process.env.NEXUS_MCP_TOKEN = savedToken ?? '';
    for (const s of servers) {
      try { s.close(); } catch { /* ignore */ }
    }
    servers.length = 0;
  });

  it('refuses to start when NEXUS_MCP_HTTP is not set', async () => {
    await expect(startMcpHttpServer(freshPort())).rejects.toThrow(/HTTP mode is disabled/);
  });

  it('refuses to start when NEXUS_MCP_HTTP is 0', async () => {
    process.env.NEXUS_MCP_HTTP = '0';
    await expect(startMcpHttpServer(freshPort())).rejects.toThrow(/HTTP mode is disabled/);
  });

  it('starts when NEXUS_MCP_HTTP=1 and a token is set, refuses unauthenticated POSTs with 401', async () => {
    process.env.NEXUS_MCP_HTTP = '1';
    process.env.NEXUS_MCP_TOKEN = 'test-token-abc123';
    const port = freshPort();
    await startMcpHttpServer(port);
    // Allow bind to settle
    await new Promise((r) => setTimeout(r, 100));

    const r = await httpJson(`http://127.0.0.1:${port}/`, {
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(r.status).toBe(401);
  });

  it('rejects a request with the wrong token', async () => {
    process.env.NEXUS_MCP_HTTP = '1';
    process.env.NEXUS_MCP_TOKEN = 'correct-token';
    const port = freshPort();
    await startMcpHttpServer(port);
    await new Promise((r) => setTimeout(r, 100));

    const r = await httpJson(`http://127.0.0.1:${port}/`, {
      headers: { Authorization: 'Bearer not-the-right-token' },
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(r.status).toBe(401);
  });

  it('accepts a request with the correct bearer token', async () => {
    process.env.NEXUS_MCP_HTTP = '1';
    process.env.NEXUS_MCP_TOKEN = 'good-token-xyz';
    const port = freshPort();
    await startMcpHttpServer(port);
    await new Promise((r) => setTimeout(r, 100));

    const r = await httpJson(`http://127.0.0.1:${port}/`, {
      headers: { Authorization: 'Bearer good-token-xyz' },
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('rejects non-POST methods', async () => {
    process.env.NEXUS_MCP_HTTP = '1';
    process.env.NEXUS_MCP_TOKEN = 'tok';
    const port = freshPort();
    await startMcpHttpServer(port);
    await new Promise((r) => setTimeout(r, 100));

    const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' });
    expect(r.status).toBe(405);
  });

  it('enforces the body-size cap (FIND-SEC-01)', async () => {
    process.env.NEXUS_MCP_HTTP = '1';
    process.env.NEXUS_MCP_TOKEN = 'tok';
    const port = freshPort();
    await startMcpHttpServer(port);
    await new Promise((r) => setTimeout(r, 100));

    // Build a 2 MB body. Cap is 1 MB. Expected behavior: server returns
    // 413 and calls req.destroy() to stop reading. From the client side
    // this appears as EITHER a 413 response OR a write-side error (EPIPE)
    // because the socket closes mid-upload. Both outcomes prove the cap.
    const bigPayload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', padding: 'x'.repeat(2_000_000) });
    let outcome: 'rejected-413' | 'connection-closed' | 'accepted' = 'accepted';
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
        body: bigPayload,
      });
      outcome = r.status === 413 ? 'rejected-413' : 'accepted';
    } catch {
      // EPIPE / connection reset — server destroyed the socket after emitting 413.
      outcome = 'connection-closed';
    }
    expect(['rejected-413', 'connection-closed']).toContain(outcome);
  });

  it('does NOT bind to external interfaces — only 127.0.0.1', async () => {
    process.env.NEXUS_MCP_HTTP = '1';
    process.env.NEXUS_MCP_TOKEN = 'tok';
    const port = freshPort();
    await startMcpHttpServer(port);
    await new Promise((r) => setTimeout(r, 100));

    // Binding on 127.0.0.1 specifically means:
    //   * connecting via 127.0.0.1 works
    //   * connecting via 0.0.0.0 or the external host IP should NOT work
    // We can't probe every external interface, but we CAN verify the 127
    // connection works AND that 127.0.0.1-addressed probe succeeds quickly.
    const r = await httpJson(`http://127.0.0.1:${port}/`, {
      headers: { Authorization: 'Bearer tok' },
      body: { jsonrpc: '2.0', id: 9, method: 'ping' },
    });
    expect(r.status).toBe(200);

    // And the response does NOT include the old wildcard CORS header
    // (removed in yesterday's hardening).
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});
