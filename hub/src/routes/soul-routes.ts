// /soul/* endpoints — same-user instance-to-instance sync. E2E encrypted
// with a user-scoped master key that lives only in the user's Keychain(s).
// The hub sees ciphertext + routing metadata, nothing more.
//
// Key difference from gossip: no friendship check — it's always same-user.
// We still verify:
//   - sender owns from_instance_id
//   - recipient's instance belongs to the same user

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const SendBody = z.object({
  fromInstanceId: z.string().length(32),
  toInstanceId: z.string().length(32),
  ciphertext: z.string().min(1).max(65536), // larger limit for memory payloads
  nonce: z.string().regex(/^[0-9a-f]{24}([0-9a-f]{24})?$/, 'nonce must be 12 or 24 bytes hex'),
});

export async function soulRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // ── POST /soul/send ───────────────────────────────────────────────
  app.post('/soul/send', async (req, reply) => {
    const parsed = SendBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    const db = getDb();
    const from = db.prepare(
      'SELECT id FROM instances WHERE id = ? AND user_id = ?',
    ).get(parsed.data.fromInstanceId, req.userId!) as { id: string } | undefined;
    if (!from) return reply.code(404).send({ error: 'instance_not_found' });

    const to = db.prepare(
      'SELECT id FROM instances WHERE id = ? AND user_id = ?',
    ).get(parsed.data.toInstanceId, req.userId!) as { id: string } | undefined;
    if (!to) return reply.code(404).send({ error: 'recipient_not_same_user' });
    if (to.id === from.id) return reply.code(400).send({ error: 'self_send' });

    const id = randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO soul_queue (id, user_id, from_instance_id, to_instance_id, ciphertext, nonce)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.userId!, parsed.data.fromInstanceId, parsed.data.toInstanceId,
           parsed.data.ciphertext, parsed.data.nonce);
    return reply.code(201).send({ id });
  });

  // ── GET /soul/inbox — undelivered sync messages for caller's instances.
  app.get('/soul/inbox', async (req) => {
    const db = getDb();
    const myInstances = db.prepare('SELECT id FROM instances WHERE user_id = ?')
      .all(req.userId!) as Array<{ id: string }>;
    if (myInstances.length === 0) return { messages: [] };
    const placeholders = myInstances.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, from_instance_id, to_instance_id, ciphertext, nonce, created_at
      FROM soul_queue
      WHERE user_id = ? AND to_instance_id IN (${placeholders}) AND delivered_at IS NULL
      ORDER BY created_at ASC
      LIMIT 100
    `).all(req.userId!, ...myInstances.map((i) => i.id)) as Array<{
      id: string; from_instance_id: string; to_instance_id: string;
      ciphertext: string; nonce: string; created_at: string;
    }>;

    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const ph = ids.map(() => '?').join(',');
      db.prepare(`UPDATE soul_queue SET delivered_at = datetime('now') WHERE id IN (${ph})`).run(...ids);
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
