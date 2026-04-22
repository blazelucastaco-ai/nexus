// Posts route — signature verification, timestamp skew, feed visibility.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  buildTestApp, signup, authed,
  genEd25519Keypair, signPost, randEmail, randUsername, randHex,
  type TestApp,
} from './helpers.js';

let t: TestApp;
beforeEach(async () => { t = await buildTestApp(); });
afterEach(async () => { await t.close(); });

async function setupUserWithInstance(): Promise<{
  token: string; userId: string; instanceId: string; pubHex: string; privHex: string;
}> {
  const s = await signup(t.app, {
    email: randEmail(), password: 'password-1234', displayName: 'Poster', username: randUsername(),
  });
  const { pubHex, privHex } = genEd25519Keypair();
  const reg = await authed(t.app, s.body.accessToken, {
    method: 'POST', url: '/instances',
    payload: { name: 'Test Mac', publicKey: pubHex, x25519PublicKey: randHex(32) },
  });
  return {
    token: s.body.accessToken,
    userId: s.body.user.id,
    instanceId: reg.body.id,
    pubHex, privHex,
  };
}

describe('POST /posts', () => {
  test('accepts a valid signed post', async () => {
    const user = await setupUserWithInstance();
    const content = 'Hello hub';
    const createdAt = new Date().toISOString();
    const signature = signPost(user.privHex, content, createdAt, user.instanceId);
    const r = await authed(t.app, user.token, {
      method: 'POST', url: '/posts',
      payload: { instanceId: user.instanceId, content, signature, createdAt },
    });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^[a-f0-9]{32}$/);
    expect(r.body.createdAt).toBe(createdAt);
  });

  test('rejects a post signed with a different key', async () => {
    const user = await setupUserWithInstance();
    const createdAt = new Date().toISOString();
    const wrongKeypair = genEd25519Keypair();
    const signature = signPost(wrongKeypair.privHex, 'Hello', createdAt, user.instanceId);
    const r = await authed(t.app, user.token, {
      method: 'POST', url: '/posts',
      payload: { instanceId: user.instanceId, content: 'Hello', signature, createdAt },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_signature');
  });

  test('rejects a post with tampered content', async () => {
    const user = await setupUserWithInstance();
    const createdAt = new Date().toISOString();
    const signature = signPost(user.privHex, 'original', createdAt, user.instanceId);
    const r = await authed(t.app, user.token, {
      method: 'POST', url: '/posts',
      payload: { instanceId: user.instanceId, content: 'tampered', signature, createdAt },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_signature');
  });

  test('rejects a post with a timestamp far outside the skew window', async () => {
    const user = await setupUserWithInstance();
    const content = 'Hello';
    const createdAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    const signature = signPost(user.privHex, content, createdAt, user.instanceId);
    const r = await authed(t.app, user.token, {
      method: 'POST', url: '/posts',
      payload: { instanceId: user.instanceId, content, signature, createdAt },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('timestamp_skew');
  });

  test('cannot post from an instance that belongs to another user', async () => {
    const victim = await setupUserWithInstance();
    const attacker = await signup(t.app, {
      email: randEmail(), password: 'password-1234', displayName: 'Attacker',
    });
    const createdAt = new Date().toISOString();
    const sig = signPost(victim.privHex, 'forged', createdAt, victim.instanceId);
    const r = await authed(t.app, attacker.body.accessToken, {
      method: 'POST', url: '/posts',
      payload: { instanceId: victim.instanceId, content: 'forged', signature: sig, createdAt },
    });
    expect(r.status).toBe(404);
  });

  test('rejects posts exceeding the 500-char content limit', async () => {
    const user = await setupUserWithInstance();
    const createdAt = new Date().toISOString();
    const content = 'x'.repeat(501);
    const signature = signPost(user.privHex, content, createdAt, user.instanceId);
    const r = await authed(t.app, user.token, {
      method: 'POST', url: '/posts',
      payload: { instanceId: user.instanceId, content, signature, createdAt },
    });
    expect(r.status).toBe(400);
  });
});

describe('GET /feed', () => {
  test('returns the user\'s own posts', async () => {
    const user = await setupUserWithInstance();
    const createdAt = new Date().toISOString();
    const signature = signPost(user.privHex, 'mine', createdAt, user.instanceId);
    await authed(t.app, user.token, {
      method: 'POST', url: '/posts',
      payload: { instanceId: user.instanceId, content: 'mine', signature, createdAt },
    });
    const feed = await authed(t.app, user.token, { method: 'GET', url: '/feed' });
    expect(feed.body.posts).toHaveLength(1);
    expect(feed.body.posts[0].content).toBe('mine');
    expect(feed.body.posts[0].mine).toBe(true);
  });

  test('does not include posts from strangers', async () => {
    const me = await setupUserWithInstance();
    const stranger = await setupUserWithInstance();
    const createdAt = new Date().toISOString();
    const sig = signPost(stranger.privHex, 'stranger-only', createdAt, stranger.instanceId);
    await authed(t.app, stranger.token, {
      method: 'POST', url: '/posts',
      payload: { instanceId: stranger.instanceId, content: 'stranger-only', signature: sig, createdAt },
    });
    const feed = await authed(t.app, me.token, { method: 'GET', url: '/feed' });
    const strangerPosts = feed.body.posts.filter((p: any) => p.content === 'stranger-only');
    expect(strangerPosts).toHaveLength(0);
  });

  test('includes posts from accepted friends', async () => {
    const me = await setupUserWithInstance();
    const friend = await setupUserWithInstance();
    // Friend request + accept
    const req = await authed(t.app, me.token, {
      method: 'POST', url: '/friends/request',
      payload: { email: await emailFor(friend.userId) },
    });
    await authed(t.app, friend.token, {
      method: 'POST', url: `/friends/${req.body.id}/accept`, payload: {},
    });
    // Friend posts
    const createdAt = new Date().toISOString();
    const sig = signPost(friend.privHex, 'friend-post', createdAt, friend.instanceId);
    await authed(t.app, friend.token, {
      method: 'POST', url: '/posts',
      payload: { instanceId: friend.instanceId, content: 'friend-post', signature: sig, createdAt },
    });
    // Me sees it
    const feed = await authed(t.app, me.token, { method: 'GET', url: '/feed' });
    const fromFriend = feed.body.posts.find((p: any) => p.content === 'friend-post');
    expect(fromFriend).toBeTruthy();
    expect(fromFriend.mine).toBe(false);
  });
});

/** Small helper to look up a user's email given their id — tests don't track it otherwise. */
async function emailFor(userId: string): Promise<string> {
  const row = t.db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string };
  return row.email;
}
