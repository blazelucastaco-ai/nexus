// NEXUS Hub — SQLite schema + migrations.
//
// All tables for the full feature set are declared here. Phase 1 only uses
// users/instances/sessions. Phase 2+ will wire friendships/posts/gossip_queue
// to actual endpoints; declaring them now keeps migrations additive.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const path = process.env.DB_PATH ?? './data/hub.db';
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id              TEXT PRIMARY KEY,
      email           TEXT NOT NULL UNIQUE,
      email_lower     TEXT NOT NULL UNIQUE,
      password_hash   TEXT NOT NULL,
      display_name    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at   TEXT,
      failed_logins   INTEGER NOT NULL DEFAULT 0,
      locked_until    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(email_lower);

    -- Each NEXUS install. The hub never sees the private key; only the
    -- Ed25519 public key used to verify signed posts / messages.
    CREATE TABLE IF NOT EXISTS instances (
      id                TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name              TEXT NOT NULL,
      public_key        TEXT NOT NULL,         -- Ed25519 (post signing)
      x25519_public_key TEXT,                  -- X25519 (gossip/soul ECDH)
      platform          TEXT,
      app_version       TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_instances_user ON instances(user_id);

    -- Additive migration: earlier instances were registered without an
    -- x25519 key. Safe no-op on fresh DBs.
    -- (SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS, so we
    -- introspect and add conditionally.)

    -- Refresh tokens. One row per active session. Deleting = logout on that device.
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      instance_id  TEXT REFERENCES instances(id) ON DELETE SET NULL,
      token_hash   TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL,
      revoked_at   TEXT,
      user_agent   TEXT,
      ip_hash      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

    -- Phase 2: Friends. Bidirectional — one row per pair regardless of who
    -- initiated. user_a_id < user_b_id enforced in app code to avoid dupes.
    CREATE TABLE IF NOT EXISTS friendships (
      id              TEXT PRIMARY KEY,
      user_a_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state           TEXT NOT NULL CHECK(state IN ('pending','accepted','blocked')),
      requested_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gossip_enabled  INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_a_id, user_b_id),
      CHECK(user_a_id < user_b_id)
    );

    CREATE INDEX IF NOT EXISTS idx_friendships_a ON friendships(user_a_id);
    CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_b_id);

    -- Phase 2: Posts to the hub feed. Signed by the posting instance so the
    -- hub operator can't forge them — friends verify the signature client-side.
    CREATE TABLE IF NOT EXISTS posts (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      instance_id   TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      content       TEXT NOT NULL,
      signature     TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_posts_user_created ON posts(user_id, created_at DESC);

    -- Phase 2: Gossip messages. End-to-end encrypted — the hub only ever sees
    -- ciphertext + metadata. Decryption key is the shared secret derived from
    -- the friend-pair X25519 handshake, negotiated client-side.
    CREATE TABLE IF NOT EXISTS gossip_queue (
      id                 TEXT PRIMARY KEY,
      from_instance_id   TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      to_instance_id     TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      ciphertext         TEXT NOT NULL,
      nonce              TEXT NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_gossip_to ON gossip_queue(to_instance_id, delivered_at);

    -- Phase 3: Soul sync — same-user instance-to-instance messages. Also E2E
    -- encrypted. Key derivation uses the user's master key, derived from the
    -- password via a KDF and kept in Keychain. Hub sees only ciphertext.
    CREATE TABLE IF NOT EXISTS soul_queue (
      id                 TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_instance_id   TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      to_instance_id     TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      ciphertext         TEXT NOT NULL,
      nonce              TEXT NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_soul_to ON soul_queue(to_instance_id, delivered_at);

    -- Audit log — security-relevant events. Never stores tokens or passwords.
    CREATE TABLE IF NOT EXISTS audit_log (
      id          TEXT PRIMARY KEY,
      user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
      action      TEXT NOT NULL,
      detail      TEXT,
      ip_hash     TEXT,
      user_agent  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_audit_user_created ON audit_log(user_id, created_at DESC);
  `);

  // Additive column migration for existing hubs that deployed before
  // x25519 support landed. PRAGMA table_info introspects the schema so we
  // only attempt the ALTER when needed.
  const instanceCols = d.prepare('PRAGMA table_info(instances)').all() as Array<{ name: string }>;
  if (!instanceCols.some((c) => c.name === 'x25519_public_key')) {
    d.exec('ALTER TABLE instances ADD COLUMN x25519_public_key TEXT');
  }

  // Additive: username column on users. Older hubs only had email — we keep
  // email as the canonical identifier and make username a friendlier handle
  // used for friend search. username_lower is the lookup index.
  const userCols = d.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (!userCols.some((c) => c.name === 'username')) {
    d.exec('ALTER TABLE users ADD COLUMN username TEXT');
  }
  if (!userCols.some((c) => c.name === 'username_lower')) {
    d.exec('ALTER TABLE users ADD COLUMN username_lower TEXT');
  }
  // Unique index — sparse so existing rows with NULL username don't collide.
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(username_lower) WHERE username_lower IS NOT NULL');
}

// CLI entrypoint: `tsx src/db.ts --migrate` to run migrations without starting the server.
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--migrate')) {
    getDb();
    console.log('Migrations applied.');
    process.exit(0);
  }
}
