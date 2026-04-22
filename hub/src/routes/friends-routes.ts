// /friends/* endpoints — request, accept, block, list, delete. Bidirectional
// friendship rows enforced with user_a_id < user_b_id so we only store one
// row per pair regardless of who initiated.

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { writeAudit } from '../auth.js';

// Accept either an email or a username — at least one must be present.
// We don't make the client pick a field; whichever they supply we look up.
const RequestBody = z.object({
  email: z.string().max(254).optional(),
  username: z.string().max(64).optional(),
}).refine(
  (v) => Boolean(v.email) || Boolean(v.username),
  { message: 'email_or_username_required' },
);

/** Always produce the (a,b) pair in the same order for storage. */
function orderedPair(u1: string, u2: string): [string, string] {
  return u1 < u2 ? [u1, u2] : [u2, u1];
}

interface FriendRow {
  id: string;
  user_a_id: string;
  user_b_id: string;
  state: 'pending' | 'accepted' | 'blocked';
  requested_by: string;
  gossip_enabled: number;
  created_at: string;
  updated_at: string;
  other_id: string;
  other_email: string;
  other_display_name: string | null;
  other_username: string | null;
}

function listFriendsFor(userId: string): Array<{
  id: string;
  otherUserId: string;
  email: string;
  username: string | null;
  displayName: string | null;
  state: FriendRow['state'];
  requestedByMe: boolean;
  gossipEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT f.*,
      CASE WHEN f.user_a_id = ? THEN f.user_b_id ELSE f.user_a_id END as other_id,
      CASE WHEN f.user_a_id = ? THEN ub.email ELSE ua.email END as other_email,
      CASE WHEN f.user_a_id = ? THEN ub.username ELSE ua.username END as other_username,
      CASE WHEN f.user_a_id = ? THEN ub.display_name ELSE ua.display_name END as other_display_name
    FROM friendships f
    JOIN users ua ON ua.id = f.user_a_id
    JOIN users ub ON ub.id = f.user_b_id
    WHERE f.user_a_id = ? OR f.user_b_id = ?
    ORDER BY f.updated_at DESC
  `).all(userId, userId, userId, userId, userId, userId) as FriendRow[];

  return rows.map((r) => ({
    id: r.id,
    otherUserId: r.other_id,
    email: r.other_email,
    username: r.other_username,
    displayName: r.other_display_name,
    state: r.state,
    requestedByMe: r.requested_by === userId,
    gossipEnabled: r.gossip_enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function friendsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // ── GET /friends ──────────────────────────────────────────────────
  app.get('/friends', async (req) => {
    return { friends: listFriendsFor(req.userId!) };
  });

  // ── POST /friends/request ─────────────────────────────────────────
  app.post('/friends/request', async (req, reply) => {
    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    const db = getDb();
    let target: { id: string } | undefined;
    if (parsed.data.username) {
      target = db.prepare('SELECT id FROM users WHERE username_lower = ?')
        .get(parsed.data.username.toLowerCase()) as { id: string } | undefined;
    } else if (parsed.data.email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.data.email)) {
        return reply.code(400).send({ error: 'invalid_input' });
      }
      target = db.prepare('SELECT id FROM users WHERE email_lower = ?')
        .get(parsed.data.email.toLowerCase()) as { id: string } | undefined;
    }
    // Deliberately return the same 404 whether the user doesn't exist or you're
    // blocked — prevents account enumeration via friend-request probes.
    if (!target) return reply.code(404).send({ error: 'not_found' });
    if (target.id === req.userId!) return reply.code(400).send({ error: 'self_friend' });

    const [a, b] = orderedPair(req.userId!, target.id);
    const existing = db.prepare(
      'SELECT id, state FROM friendships WHERE user_a_id = ? AND user_b_id = ?',
    ).get(a, b) as { id: string; state: string } | undefined;

    if (existing) {
      if (existing.state === 'blocked') return reply.code(404).send({ error: 'not_found' });
      if (existing.state === 'accepted') return reply.code(409).send({ error: 'already_friends' });
      // pending — just return success, don't spam another row
      return reply.send({ id: existing.id, state: 'pending' });
    }

    const id = randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO friendships (id, user_a_id, user_b_id, state, requested_by)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(id, a, b, req.userId!);

    writeAudit(db, 'friend_request', { userId: req.userId!, detail: target.id });
    return reply.code(201).send({ id, state: 'pending' });
  });

  // ── POST /friends/:id/accept ──────────────────────────────────────
  app.post<{ Params: { id: string } }>('/friends/:id/accept', async (req, reply) => {
    const db = getDb();
    const f = db.prepare('SELECT * FROM friendships WHERE id = ?').get(req.params.id) as
      | { user_a_id: string; user_b_id: string; state: string; requested_by: string } | undefined;
    if (!f) return reply.code(404).send({ error: 'not_found' });
    if (f.user_a_id !== req.userId && f.user_b_id !== req.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    // Only the non-requester can accept.
    if (f.requested_by === req.userId) return reply.code(400).send({ error: 'cannot_accept_own_request' });
    if (f.state !== 'pending') return reply.code(400).send({ error: 'not_pending' });

    db.prepare(`
      UPDATE friendships SET state = 'accepted', updated_at = datetime('now') WHERE id = ?
    `).run(req.params.id);
    writeAudit(db, 'friend_accept', { userId: req.userId!, detail: req.params.id });
    return { ok: true };
  });

  // ── POST /friends/:id/block ───────────────────────────────────────
  app.post<{ Params: { id: string } }>('/friends/:id/block', async (req, reply) => {
    const db = getDb();
    const f = db.prepare('SELECT user_a_id, user_b_id FROM friendships WHERE id = ?')
      .get(req.params.id) as { user_a_id: string; user_b_id: string } | undefined;
    if (!f) return reply.code(404).send({ error: 'not_found' });
    if (f.user_a_id !== req.userId && f.user_b_id !== req.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    db.prepare(`
      UPDATE friendships SET state = 'blocked', gossip_enabled = 0, updated_at = datetime('now') WHERE id = ?
    `).run(req.params.id);
    writeAudit(db, 'friend_block', { userId: req.userId!, detail: req.params.id });
    return { ok: true };
  });

  // ── POST /friends/:id/gossip ──────────────────────────────────────
  //  Body { enabled: boolean } — opt in / out of agent-to-agent gossip for
  //  this particular friendship. Requires both parties to have set this
  //  true (we check both flags server-side before routing any message).
  const GossipToggle = z.object({ enabled: z.boolean() });
  app.post<{ Params: { id: string } }>('/friends/:id/gossip', async (req, reply) => {
    const parsed = GossipToggle.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const db = getDb();
    const f = db.prepare('SELECT user_a_id, user_b_id, state FROM friendships WHERE id = ?')
      .get(req.params.id) as { user_a_id: string; user_b_id: string; state: string } | undefined;
    if (!f) return reply.code(404).send({ error: 'not_found' });
    if (f.user_a_id !== req.userId && f.user_b_id !== req.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (f.state !== 'accepted') return reply.code(400).send({ error: 'not_friends' });

    // Per-user gossip preference — we store two flags packed into a bitmask
    // (bit 0 = user_a wants gossip, bit 1 = user_b wants gossip). Only route
    // when both are set. Avoids needing a second table.
    const current = db.prepare('SELECT gossip_enabled FROM friendships WHERE id = ?')
      .get(req.params.id) as { gossip_enabled: number };
    const isA = f.user_a_id === req.userId;
    const myBit = isA ? 1 : 2;
    const next = parsed.data.enabled
      ? (current.gossip_enabled | myBit)
      : (current.gossip_enabled & ~myBit);
    db.prepare(`
      UPDATE friendships SET gossip_enabled = ?, updated_at = datetime('now') WHERE id = ?
    `).run(next, req.params.id);
    return {
      ok: true,
      myPreference: parsed.data.enabled,
      bothEnabled: next === 3,
    };
  });

  // ── DELETE /friends/:id ───────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/friends/:id', async (req, reply) => {
    const db = getDb();
    const f = db.prepare('SELECT user_a_id, user_b_id FROM friendships WHERE id = ?')
      .get(req.params.id) as { user_a_id: string; user_b_id: string } | undefined;
    if (!f) return reply.code(404).send({ error: 'not_found' });
    if (f.user_a_id !== req.userId && f.user_b_id !== req.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    db.prepare('DELETE FROM friendships WHERE id = ?').run(req.params.id);
    writeAudit(db, 'friend_remove', { userId: req.userId!, detail: req.params.id });
    return { ok: true };
  });
}
