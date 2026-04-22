// Friends flow — request by email/username, accept, block, gossip toggle,
// bidirectional-pair invariant, enumeration safety.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, signup, authed, randEmail, randUsername, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => { t = await buildTestApp(); });
afterEach(async () => { await t.close(); });

async function twoUsers(): Promise<{
  a: { token: string; id: string; email: string; username: string };
  b: { token: string; id: string; email: string; username: string };
}> {
  const aEmail = randEmail(); const aUser = randUsername();
  const bEmail = randEmail(); const bUser = randUsername();
  const aSignup = await signup(t.app, { email: aEmail, password: 'password-1234', displayName: 'A', username: aUser });
  const bSignup = await signup(t.app, { email: bEmail, password: 'password-1234', displayName: 'B', username: bUser });
  return {
    a: { token: aSignup.body.accessToken, id: aSignup.body.user.id, email: aEmail, username: aUser },
    b: { token: bSignup.body.accessToken, id: bSignup.body.user.id, email: bEmail, username: bUser },
  };
}

describe('POST /friends/request', () => {
  test('creates a pending friendship when looking up by email', async () => {
    const { a, b } = await twoUsers();
    const r = await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: { email: b.email },
    });
    expect(r.status).toBe(201);
    expect(r.body.state).toBe('pending');
    expect(r.body.id).toMatch(/^[a-f0-9]{32}$/);
  });

  test('creates a pending friendship when looking up by username', async () => {
    const { a, b } = await twoUsers();
    const r = await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: { username: b.username },
    });
    expect(r.status).toBe(201);
  });

  test('returns 404 for a nonexistent email (no enumeration)', async () => {
    const { a } = await twoUsers();
    const r = await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: { email: `ghost-${Date.now()}@nobody.test` },
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  test('returns 404 for a nonexistent username (no enumeration)', async () => {
    const { a } = await twoUsers();
    const r = await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: { username: 'ghostuser-nobody' },
    });
    expect(r.status).toBe(404);
  });

  test('rejects self-friending', async () => {
    const { a } = await twoUsers();
    const r = await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: { email: a.email },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('self_friend');
  });

  test('rejects empty body', async () => {
    const { a } = await twoUsers();
    const r = await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: {},
    });
    expect(r.status).toBe(400);
  });

  test('is idempotent — requesting twice does not duplicate', async () => {
    const { a, b } = await twoUsers();
    const r1 = await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: { email: b.email },
    });
    const r2 = await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: { email: b.email },
    });
    expect(r1.body.id).toBe(r2.body.id);
    const rows = t.db.prepare('SELECT COUNT(*) as n FROM friendships').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  test('enforces the user_a_id < user_b_id invariant regardless of who requested', async () => {
    const { a, b } = await twoUsers();
    await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: { email: b.email },
    });
    const row = t.db.prepare('SELECT user_a_id, user_b_id FROM friendships').get() as { user_a_id: string; user_b_id: string };
    expect(row.user_a_id < row.user_b_id).toBe(true);
  });
});

describe('POST /friends/:id/accept', () => {
  test('B accepts A\'s request — state flips to accepted', async () => {
    const { a, b } = await twoUsers();
    const req = await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: { email: b.email },
    });
    const r = await authed(t.app, b.token, {
      method: 'POST', url: `/friends/${req.body.id}/accept`, payload: {},
    });
    expect(r.status).toBe(200);
    const row = t.db.prepare('SELECT state FROM friendships WHERE id = ?').get(req.body.id) as { state: string };
    expect(row.state).toBe('accepted');
  });

  test('requester cannot accept their own request', async () => {
    const { a, b } = await twoUsers();
    const req = await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: { email: b.email },
    });
    const r = await authed(t.app, a.token, {
      method: 'POST', url: `/friends/${req.body.id}/accept`, payload: {},
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('cannot_accept_own_request');
  });

  test('a stranger cannot accept someone else\'s friendship', async () => {
    const { a, b } = await twoUsers();
    const stranger = await signup(t.app, { email: randEmail(), password: 'password-1234', displayName: 'Stranger' });
    const req = await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: { email: b.email },
    });
    const r = await authed(t.app, stranger.body.accessToken, {
      method: 'POST', url: `/friends/${req.body.id}/accept`, payload: {},
    });
    expect(r.status).toBe(404);
  });
});

describe('POST /friends/:id/gossip', () => {
  test('both parties must toggle on before gossip_enabled reaches the both-on state (bitmask 3)', async () => {
    const { a, b } = await twoUsers();
    const req = await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: { email: b.email },
    });
    await authed(t.app, b.token, { method: 'POST', url: `/friends/${req.body.id}/accept`, payload: {} });

    // Only A toggles on
    let r = await authed(t.app, a.token, {
      method: 'POST', url: `/friends/${req.body.id}/gossip`, payload: { enabled: true },
    });
    expect(r.status).toBe(200);
    expect(r.body.bothEnabled).toBe(false);

    // Both on now
    r = await authed(t.app, b.token, {
      method: 'POST', url: `/friends/${req.body.id}/gossip`, payload: { enabled: true },
    });
    expect(r.body.bothEnabled).toBe(true);
    const row = t.db.prepare('SELECT gossip_enabled FROM friendships WHERE id = ?').get(req.body.id) as { gossip_enabled: number };
    expect(row.gossip_enabled).toBe(3);

    // Either side opts out → both_enabled flips false
    r = await authed(t.app, a.token, {
      method: 'POST', url: `/friends/${req.body.id}/gossip`, payload: { enabled: false },
    });
    expect(r.body.bothEnabled).toBe(false);
  });

  test('rejects gossip on a non-accepted friendship', async () => {
    const { a, b } = await twoUsers();
    const req = await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: { email: b.email },
    });
    // Not accepted yet
    const r = await authed(t.app, a.token, {
      method: 'POST', url: `/friends/${req.body.id}/gossip`, payload: { enabled: true },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('not_friends');
  });
});

describe('GET /friends', () => {
  test('lists both incoming and outgoing friendships with the right perspective', async () => {
    const { a, b } = await twoUsers();
    const req = await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: { email: b.email },
    });

    const aList = await authed(t.app, a.token, { method: 'GET', url: '/friends' });
    const bList = await authed(t.app, b.token, { method: 'GET', url: '/friends' });
    expect(aList.body.friends[0].requestedByMe).toBe(true);
    expect(aList.body.friends[0].otherUserId).toBe(b.id);
    expect(bList.body.friends[0].requestedByMe).toBe(false);
    expect(bList.body.friends[0].otherUserId).toBe(a.id);
    expect(req.body.id).toBeTruthy();
  });
});

describe('DELETE /friends/:id', () => {
  test('either party can remove the friendship', async () => {
    const { a, b } = await twoUsers();
    const req = await authed(t.app, a.token, {
      method: 'POST', url: '/friends/request', payload: { email: b.email },
    });
    await authed(t.app, b.token, { method: 'POST', url: `/friends/${req.body.id}/accept`, payload: {} });

    const r = await authed(t.app, b.token, { method: 'DELETE', url: `/friends/${req.body.id}` });
    expect(r.status).toBe(200);
    const row = t.db.prepare('SELECT * FROM friendships WHERE id = ?').get(req.body.id);
    expect(row).toBeUndefined();
  });
});
