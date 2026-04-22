// /instances/* endpoints — register a NEXUS install under the authed user,
// list instances, and ping-in to mark "last seen". Soul/Gossip/Posts will
// hang off the same instance records in Phase 2+.

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { writeAudit, hashIp } from '../auth.js';

// Ed25519 public key as 64-hex-char string.
const PUBKEY_RE = /^[0-9a-f]{64}$/;

const RegisterBody = z.object({
  name: z.string().min(1).max(64),
  publicKey: z.string().regex(PUBKEY_RE, 'public key must be 32-byte hex'),
  x25519PublicKey: z.string().regex(PUBKEY_RE, 'x25519 public key must be 32-byte hex').optional(),
  platform: z.string().max(64).optional(),
  appVersion: z.string().max(32).optional(),
});

export async function instancesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // ── GET /me — who am I? ──────────────────────────────────────────
  app.get('/me', async (req, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT id, email, display_name, created_at FROM users WHERE id = ?').get(req.userId!) as
      | { id: string; email: string; display_name: string | null; created_at: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { id: row.id, email: row.email, displayName: row.display_name, createdAt: row.created_at };
  });

  // ── GET /instances — all NEXUS installs tied to this account ──────
  app.get('/instances', async (req) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, name, public_key, x25519_public_key, platform, app_version, created_at, last_seen_at
      FROM instances
      WHERE user_id = ?
      ORDER BY last_seen_at DESC NULLS LAST, created_at DESC
    `).all(req.userId!) as Array<{
      id: string; name: string; public_key: string; x25519_public_key: string | null;
      platform: string | null; app_version: string | null;
      created_at: string; last_seen_at: string | null;
    }>;
    return {
      instances: rows.map((r) => ({
        id: r.id,
        name: r.name,
        publicKey: r.public_key,
        x25519PublicKey: r.x25519_public_key,
        platform: r.platform,
        appVersion: r.app_version,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
      })),
    };
  });

  // ── GET /instances/:id/keys — fetch a specific instance's public keys.
  //    Used by friends' daemons to look up X25519 public keys for gossip
  //    ECDH. Only returns keys for instances belonging to an accepted mutual
  //    friend, or to the caller themselves (soul sync between own instances).
  app.get<{ Params: { id: string } }>('/instances/:id/keys', async (req, reply) => {
    const db = getDb();
    const inst = db.prepare(`
      SELECT id, user_id, public_key, x25519_public_key FROM instances WHERE id = ?
    `).get(req.params.id) as
      | { id: string; user_id: string; public_key: string; x25519_public_key: string | null }
      | undefined;
    if (!inst) return reply.code(404).send({ error: 'not_found' });

    // Self-owned: always allowed (soul sync target lookup).
    if (inst.user_id === req.userId) {
      return {
        id: inst.id,
        publicKey: inst.public_key,
        x25519PublicKey: inst.x25519_public_key,
      };
    }

    // Otherwise require accepted mutual friendship.
    const u1 = req.userId! < inst.user_id ? req.userId! : inst.user_id;
    const u2 = req.userId! < inst.user_id ? inst.user_id : req.userId!;
    const friendship = db.prepare(
      "SELECT state FROM friendships WHERE user_a_id = ? AND user_b_id = ? AND state = 'accepted'",
    ).get(u1, u2) as { state: string } | undefined;
    if (!friendship) return reply.code(404).send({ error: 'not_found' });

    return {
      id: inst.id,
      publicKey: inst.public_key,
      x25519PublicKey: inst.x25519_public_key,
    };
  });

  // ── POST /instances — register this NEXUS install ────────────────
  app.post('/instances', async (req, reply) => {
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    const db = getDb();

    // If this public key already registered to this user, update instead of
    // inserting — re-registration is safe and idempotent.
    const existing = db.prepare(
      'SELECT id FROM instances WHERE user_id = ? AND public_key = ?',
    ).get(req.userId!, parsed.data.publicKey) as { id: string } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE instances
        SET name = ?, x25519_public_key = COALESCE(?, x25519_public_key),
            platform = ?, app_version = ?, last_seen_at = datetime('now')
        WHERE id = ?
      `).run(parsed.data.name, parsed.data.x25519PublicKey ?? null,
             parsed.data.platform ?? null, parsed.data.appVersion ?? null, existing.id);
      writeAudit(db, 'instance_updated', { userId: req.userId!, detail: existing.id, ipHash: hashIp(req.ip) });
      return { id: existing.id, updated: true };
    }

    const id = randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO instances (id, user_id, name, public_key, x25519_public_key, platform, app_version, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(id, req.userId!, parsed.data.name, parsed.data.publicKey,
           parsed.data.x25519PublicKey ?? null,
           parsed.data.platform ?? null, parsed.data.appVersion ?? null);

    writeAudit(db, 'instance_registered', { userId: req.userId!, detail: id, ipHash: hashIp(req.ip) });
    return reply.code(201).send({ id, created: true });
  });

  // ── POST /instances/:id/ping — mark last-seen ────────────────────
  app.post<{ Params: { id: string } }>('/instances/:id/ping', async (req, reply) => {
    const db = getDb();
    const res = db.prepare(`
      UPDATE instances SET last_seen_at = datetime('now') WHERE id = ? AND user_id = ?
    `).run(req.params.id, req.userId!);
    if (res.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // ── DELETE /instances/:id — unregister (e.g., "sign out this Mac") ──
  app.delete<{ Params: { id: string } }>('/instances/:id', async (req, reply) => {
    const db = getDb();
    const res = db.prepare('DELETE FROM instances WHERE id = ? AND user_id = ?')
      .run(req.params.id, req.userId!);
    if (res.changes === 0) return reply.code(404).send({ error: 'not_found' });
    writeAudit(db, 'instance_removed', { userId: req.userId!, detail: req.params.id });
    return { ok: true };
  });
}
