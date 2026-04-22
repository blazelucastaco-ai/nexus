// Gossip + Soul routing — ACL enforcement, both-parties-enabled gate, same-user invariant.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  buildTestApp, signup, authed, randEmail, randUsername, randHex,
  type TestApp,
} from './helpers.js';

let t: TestApp;
beforeEach(async () => { t = await buildTestApp(); });
afterEach(async () => { await t.close(); });

async function setupUser(): Promise<{
  token: string; userId: string; instanceIds: string[];
}> {
  const s = await signup(t.app, {
    email: randEmail(), password: 'password-1234', displayName: 'X', username: randUsername(),
  });
  const instanceIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const reg = await authed(t.app, s.body.accessToken, {
      method: 'POST', url: '/instances',
      payload: { name: `Mac ${i}`, publicKey: randHex(32), x25519PublicKey: randHex(32) },
    });
    instanceIds.push(reg.body.id);
  }
  return { token: s.body.accessToken, userId: s.body.user.id, instanceIds };
}

async function acceptedFriendship(): Promise<{
  a: { token: string; userId: string; instanceId: string };
  b: { token: string; userId: string; instanceId: string };
  friendshipId: string;
}> {
  const a = await setupUser();
  const b = await setupUser();
  const aEmail = (t.db.prepare('SELECT email FROM users WHERE id = ?').get(a.userId) as { email: string }).email;
  const bEmail = (t.db.prepare('SELECT email FROM users WHERE id = ?').get(b.userId) as { email: string }).email;
  const req = await authed(t.app, a.token, {
    method: 'POST', url: '/friends/request', payload: { email: bEmail },
  });
  await authed(t.app, b.token, { method: 'POST', url: `/friends/${req.body.id}/accept`, payload: {} });
  return {
    a: { token: a.token, userId: a.userId, instanceId: a.instanceIds[0]! },
    b: { token: b.token, userId: b.userId, instanceId: b.instanceIds[0]! },
    friendshipId: req.body.id,
  };
}

async function enableGossipBothWays(friendshipId: string, aToken: string, bToken: string): Promise<void> {
  await authed(t.app, aToken, {
    method: 'POST', url: `/friends/${friendshipId}/gossip`, payload: { enabled: true },
  });
  await authed(t.app, bToken, {
    method: 'POST', url: `/friends/${friendshipId}/gossip`, payload: { enabled: true },
  });
}

const VALID_NONCE = 'aabbccddeeff001122334455';
const VALID_CIPHERTEXT = 'aGVsbG8tY2lwaGVydGV4dA==';

describe('POST /gossip/send', () => {
  test('rejects when gossip is not mutually enabled', async () => {
    const { a, b } = await acceptedFriendship();
    const r = await authed(t.app, a.token, {
      method: 'POST', url: '/gossip/send',
      payload: {
        fromInstanceId: a.instanceId, toInstanceId: b.instanceId,
        ciphertext: VALID_CIPHERTEXT, nonce: VALID_NONCE,
      },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('gossip_not_enabled');
  });

  test('accepts when both parties have gossip on', async () => {
    const { a, b, friendshipId } = await acceptedFriendship();
    await enableGossipBothWays(friendshipId, a.token, b.token);
    const r = await authed(t.app, a.token, {
      method: 'POST', url: '/gossip/send',
      payload: {
        fromInstanceId: a.instanceId, toInstanceId: b.instanceId,
        ciphertext: VALID_CIPHERTEXT, nonce: VALID_NONCE,
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^[a-f0-9]{32}$/);
  });

  test('fails again when either side opts out after enabling', async () => {
    const { a, b, friendshipId } = await acceptedFriendship();
    await enableGossipBothWays(friendshipId, a.token, b.token);
    // A opts out
    await authed(t.app, a.token, {
      method: 'POST', url: `/friends/${friendshipId}/gossip`, payload: { enabled: false },
    });
    const r = await authed(t.app, a.token, {
      method: 'POST', url: '/gossip/send',
      payload: {
        fromInstanceId: a.instanceId, toInstanceId: b.instanceId,
        ciphertext: VALID_CIPHERTEXT, nonce: VALID_NONCE,
      },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('gossip_not_enabled');
  });

  test('rejects invalid nonce format', async () => {
    const { a, b, friendshipId } = await acceptedFriendship();
    await enableGossipBothWays(friendshipId, a.token, b.token);
    const r = await authed(t.app, a.token, {
      method: 'POST', url: '/gossip/send',
      payload: {
        fromInstanceId: a.instanceId, toInstanceId: b.instanceId,
        ciphertext: VALID_CIPHERTEXT, nonce: 'not-hex',
      },
    });
    expect(r.status).toBe(400);
  });

  test('cannot send from an instance you don\'t own', async () => {
    const { a, b, friendshipId } = await acceptedFriendship();
    await enableGossipBothWays(friendshipId, a.token, b.token);
    const r = await authed(t.app, b.token, {  // B sending, but claims to be from A's instance
      method: 'POST', url: '/gossip/send',
      payload: {
        fromInstanceId: a.instanceId, toInstanceId: b.instanceId,
        ciphertext: VALID_CIPHERTEXT, nonce: VALID_NONCE,
      },
    });
    expect(r.status).toBe(404);
  });
});

describe('GET /gossip/inbox', () => {
  test('returns messages directed at the caller\'s instances only', async () => {
    const { a, b, friendshipId } = await acceptedFriendship();
    await enableGossipBothWays(friendshipId, a.token, b.token);
    // A sends
    await authed(t.app, a.token, {
      method: 'POST', url: '/gossip/send',
      payload: {
        fromInstanceId: a.instanceId, toInstanceId: b.instanceId,
        ciphertext: VALID_CIPHERTEXT, nonce: VALID_NONCE,
      },
    });
    // B reads inbox
    const inbox = await authed(t.app, b.token, { method: 'GET', url: '/gossip/inbox' });
    expect(inbox.body.messages).toHaveLength(1);
    expect(inbox.body.messages[0].toInstanceId).toBe(b.instanceId);
    // A reads their own inbox — should be empty
    const aInbox = await authed(t.app, a.token, { method: 'GET', url: '/gossip/inbox' });
    expect(aInbox.body.messages).toHaveLength(0);
  });
});

describe('POST /soul/send', () => {
  test('routes between two instances of the same user', async () => {
    const u = await setupUser();
    const r = await authed(t.app, u.token, {
      method: 'POST', url: '/soul/send',
      payload: {
        fromInstanceId: u.instanceIds[0], toInstanceId: u.instanceIds[1],
        ciphertext: VALID_CIPHERTEXT, nonce: VALID_NONCE,
      },
    });
    expect(r.status).toBe(201);
  });

  test('refuses cross-user routing (soul is same-user only)', async () => {
    const me = await setupUser();
    const other = await setupUser();
    const r = await authed(t.app, me.token, {
      method: 'POST', url: '/soul/send',
      payload: {
        fromInstanceId: me.instanceIds[0], toInstanceId: other.instanceIds[0],
        ciphertext: VALID_CIPHERTEXT, nonce: VALID_NONCE,
      },
    });
    expect(r.status).toBe(404);
  });
});

describe('GET /soul/inbox', () => {
  test('surfaces same-user messages to the receiving instance', async () => {
    const u = await setupUser();
    await authed(t.app, u.token, {
      method: 'POST', url: '/soul/send',
      payload: {
        fromInstanceId: u.instanceIds[0], toInstanceId: u.instanceIds[1],
        ciphertext: VALID_CIPHERTEXT, nonce: VALID_NONCE,
      },
    });
    const inbox = await authed(t.app, u.token, { method: 'GET', url: '/soul/inbox' });
    expect(inbox.body.messages).toHaveLength(1);
  });
});
