// /gossip/* endpoints — E2E-encrypted agent-to-agent messages between
// friends. The hub stores ciphertext only. Key exchange happens client-side
// (X25519 ECDH between instance keypairs), the shared key derives an
// XChaCha20-Poly1305 session key, and every message has a random nonce.
//
// The hub's only security guarantees here:
//   - only accepted friendships can exchange messages
//   - both users must have `gossip_enabled` set on their side of the
//     friendship (bitmask 3 = both enabled)
//   - sender must prove ownership of the `from_instance_id` (it must be one
//     of theirs)
//   - recipient must be an instance belonging to a mutual friend
//   - blocked relationships refuse all routing

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const SendBody = z.object({
  fromInstanceId: z.string().length(32),
  toInstanceId: z.string().length(32),
  ciphertext: z.string().min(1).max(8192),
  // ChaCha20-Poly1305 = 12-byte (24 hex) nonce. Allow 48-hex for future
  // XChaCha20 upgrade.
  nonce: z.string().regex(/^[0-9a-f]{24}([0-9a-f]{24})?$/, 'nonce must be 12 or 24 bytes hex'),
});

export async function gossipRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // ── POST /gossip/send ─────────────────────────────────────────────
  app.post('/gossip/send', async (req, reply) => {
    const parsed = SendBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    const db = getDb();

    // 1. Verify sender owns the from-instance.
    const from = db.prepare(
      'SELECT id, user_id FROM instances WHERE id = ? AND user_id = ?',
    ).get(parsed.data.fromInstanceId, req.userId!) as
      | { id: string; user_id: string } | undefined;
    if (!from) return reply.code(404).send({ error: 'instance_not_found' });

    // 2. Look up the recipient's user.
    const to = db.prepare('SELECT id, user_id FROM instances WHERE id = ?')
      .get(parsed.data.toInstanceId) as { id: string; user_id: string } | undefined;
    if (!to) return reply.code(404).send({ error: 'recipient_not_found' });
    if (to.user_id === req.userId!) return reply.code(400).send({ error: 'self_gossip' });

    // 3. Verify mutual accepted friendship AND both-sides gossip flag.
    const u1 = req.userId! < to.user_id ? req.userId! : to.user_id;
    const u2 = req.userId! < to.user_id ? to.user_id : req.userId!;
    const friendship = db.prepare(
      'SELECT state, gossip_enabled FROM friendships WHERE user_a_id = ? AND user_b_id = ?',
    ).get(u1, u2) as { state: string; gossip_enabled: number } | undefined;
    if (!friendship) return reply.code(403).send({ error: 'not_friends' });
    if (friendship.state !== 'accepted') return reply.code(403).send({ error: 'not_friends' });
    if (friendship.gossip_enabled !== 3) return reply.code(403).send({ error: 'gossip_not_enabled' });

    // 4. Accept ciphertext. Never inspected.
    const id = randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO gossip_queue (id, from_instance_id, to_instance_id, ciphertext, nonce)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, parsed.data.fromInstanceId, parsed.data.toInstanceId,
           parsed.data.ciphertext, parsed.data.nonce);

    return reply.code(201).send({ id });
  });

  // ── GET /gossip/inbox — undelivered messages for the calling user's
  //    instances. Marks them delivered on read.
  app.get('/gossip/inbox', async (req) => {
    const db = getDb();
    const myInstances = db.prepare('SELECT id FROM instances WHERE user_id = ?')
      .all(req.userId!) as Array<{ id: string }>;
    if (myInstances.length === 0) return { messages: [] };
    const placeholders = myInstances.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, from_instance_id, to_instance_id, ciphertext, nonce, created_at
      FROM gossip_queue
      WHERE to_instance_id IN (${placeholders}) AND delivered_at IS NULL
      ORDER BY created_at ASC
      LIMIT 100
    `).all(...myInstances.map((i) => i.id)) as Array<{
      id: string; from_instance_id: string; to_instance_id: string;
      ciphertext: string; nonce: string; created_at: string;
    }>;

    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const ph = ids.map(() => '?').join(',');
      db.prepare(`UPDATE gossip_queue SET delivered_at = datetime('now') WHERE id IN (${ph})`).run(...ids);
    }

    return {
      messages: rows.map((r) => ({
        id: r.id,
        fromInstanceId: r.from_instance_id,
        toInstanceId: r.to_instance_id,
        ciphertext: r.ciphertext,
        nonce: r.nonce,
        createdAt: r.created_at,
      })),
    };
  });
}
