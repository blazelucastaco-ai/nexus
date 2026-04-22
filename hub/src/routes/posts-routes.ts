// /posts + /feed endpoints.
//
// Posts are short public-facing messages from the user's NEXUS instance,
// signed by that instance's Ed25519 private key so friends can verify
// authenticity client-side without trusting the hub.
//
// Signature input: canonicalized `${content}\n${createdAt}\n${instanceId}`.
// Hub verifies with the registered public key before accepting.

import type { FastifyInstance } from 'fastify';
import { randomBytes, verify as cryptoVerify, createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const PostBody = z.object({
  instanceId: z.string().length(32),
  content: z.string().min(1).max(500),
  signature: z.string().min(32).max(200), // base64
});

function canonicalPostInput(content: string, createdAt: string, instanceId: string): Buffer {
  return Buffer.from(`${content}\n${createdAt}\n${instanceId}`, 'utf-8');
}

/** Verify an Ed25519 signature of `data` using a 32-byte raw public key (hex). */
function verifyEd25519(pubKeyHex: string, data: Buffer, signatureBase64: string): boolean {
  try {
    // Node's crypto wants a KeyObject. Build one from the raw 32-byte key by
    // wrapping it in the minimal DER structure.
    const keyBuf = Buffer.from(pubKeyHex, 'hex');
    if (keyBuf.length !== 32) return false;
    const derPrefix = Buffer.from('302a300506032b6570032100', 'hex'); // SPKI header for Ed25519
    const spki = Buffer.concat([derPrefix, keyBuf]);
    const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const sig = Buffer.from(signatureBase64, 'base64');
    return cryptoVerify(null, data, pub, sig);
  } catch {
    return false;
  }
}

export async function postsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // ── POST /posts — create a new post, verify signature ─────────────
  app.post('/posts', async (req, reply) => {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    const db = getDb();
    const inst = db.prepare(
      'SELECT id, public_key FROM instances WHERE id = ? AND user_id = ?',
    ).get(parsed.data.instanceId, req.userId!) as
      | { id: string; public_key: string } | undefined;
    if (!inst) return reply.code(404).send({ error: 'instance_not_found' });

    const createdAt = new Date().toISOString();
    const input = canonicalPostInput(parsed.data.content, createdAt, parsed.data.instanceId);
    if (!verifyEd25519(inst.public_key, input, parsed.data.signature)) {
      return reply.code(400).send({ error: 'bad_signature' });
    }

    const id = randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO posts (id, user_id, instance_id, content, signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.userId!, parsed.data.instanceId, parsed.data.content, parsed.data.signature, createdAt);

    return reply.code(201).send({ id, createdAt });
  });

  // ── GET /feed — posts from the user's accepted friends ────────────
  app.get('/feed', async (req) => {
    const db = getDb();
    // All accepted friendships for this user → pull the other side's user_id.
    const friendIds = db.prepare(`
      SELECT CASE WHEN user_a_id = ? THEN user_b_id ELSE user_a_id END as other
      FROM friendships
      WHERE (user_a_id = ? OR user_b_id = ?)
        AND state = 'accepted'
    `).all(req.userId!, req.userId!, req.userId!) as Array<{ other: string }>;

    // Always include self-posts (a user reading their own feed expects their
    // own stuff to show up too).
    const ids = [req.userId!, ...friendIds.map((f) => f.other)];
    if (ids.length === 0) return { posts: [] };

    const placeholders = ids.map(() => '?').join(',');
    const posts = db.prepare(`
      SELECT p.id, p.user_id, p.instance_id, p.content, p.signature, p.created_at,
             u.email, u.display_name, i.public_key, i.name as instance_name
      FROM posts p
      JOIN users u ON u.id = p.user_id
      JOIN instances i ON i.id = p.instance_id
      WHERE p.user_id IN (${placeholders})
      ORDER BY p.created_at DESC
      LIMIT 50
    `).all(...ids) as Array<{
      id: string; user_id: string; instance_id: string; content: string;
      signature: string; created_at: string; email: string;
      display_name: string | null; public_key: string; instance_name: string;
    }>;

    return {
      posts: posts.map((p) => ({
        id: p.id,
        userId: p.user_id,
        displayName: p.display_name,
        email: p.email,
        instanceId: p.instance_id,
        instanceName: p.instance_name,
        instancePublicKey: p.public_key,
        content: p.content,
        signature: p.signature,
        createdAt: p.created_at,
      })),
    };
  });
}
