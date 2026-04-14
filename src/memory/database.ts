// Nexus AI — SQLite database setup and migrations

import Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';
import { getDbPath } from '../config.js';

const log = createLogger('Database');

let db: Database.Database | null = null;

/**
 * Get (or create) the singleton database connection.
 * Enables WAL mode for concurrent reads and sets performance pragmas.
 */
export function getDatabase(): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  log.info({ path: dbPath }, 'Opening SQLite database');

  db = new Database(dbPath);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -64000'); // 64 MB

  runMigrations(db);

  log.info('Database initialized');
  return db;
}

/**
 * Close the database connection cleanly.
 */
export function closeDatabase(): void {
  if (db) {
    log.info('Closing database');
    // Force WAL checkpoint so all writes are in the main DB file before close.
    // This ensures memories written in this process are visible to future processes.
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { log.warn({ e }, 'WAL checkpoint failed — DB may have unflushed writes'); }
    db.close();
    db = null;
  }
}

// ─── Migrations ───────────────────────────────────────────────────

type Migration =
  | { version: number; description: string; sql: string; run?: never }
  | { version: number; description: string; run: (db: Database.Database) => void; sql?: never };

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Create memories table',
    sql: `
      CREATE TABLE IF NOT EXISTS memories (
        id              TEXT PRIMARY KEY,
        layer           TEXT NOT NULL CHECK(layer IN ('buffer','episodic','semantic','procedural')),
        type            TEXT NOT NULL CHECK(type IN ('conversation','task','fact','preference','workflow','contact','opinion','mistake','procedure')),
        content         TEXT NOT NULL,
        summary         TEXT,
        importance      REAL NOT NULL DEFAULT 0.5,
        confidence      REAL NOT NULL DEFAULT 1.0,
        emotional_valence REAL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed   TEXT NOT NULL DEFAULT (datetime('now')),
        access_count    INTEGER NOT NULL DEFAULT 0,
        tags            TEXT NOT NULL DEFAULT '[]',
        related_memories TEXT NOT NULL DEFAULT '[]',
        source          TEXT NOT NULL DEFAULT 'system',
        metadata        TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
    `,
  },
  {
    version: 2,
    description: 'Create memory_embeddings table',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id   TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        embedding   BLOB NOT NULL,
        model       TEXT NOT NULL DEFAULT 'local',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 3,
    description: 'Create memory_links table',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_links (
        source_id     TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        target_id     TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        link_type     TEXT NOT NULL DEFAULT 'related',
        strength      REAL NOT NULL DEFAULT 1.0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (source_id, target_id)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_id);
    `,
  },
  {
    version: 4,
    description: 'Create user_facts table',
    sql: `
      CREATE TABLE IF NOT EXISTS user_facts (
        id                TEXT PRIMARY KEY,
        category          TEXT NOT NULL CHECK(category IN ('preference','contact','habit','skill','fact')),
        key               TEXT NOT NULL,
        value             TEXT NOT NULL,
        confidence        REAL NOT NULL DEFAULT 1.0,
        source_memory_id  TEXT REFERENCES memories(id) ON DELETE SET NULL,
        last_confirmed    TEXT,
        contradiction_count INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_user_facts_category ON user_facts(category);
      CREATE INDEX IF NOT EXISTS idx_user_facts_key ON user_facts(key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_facts_cat_key ON user_facts(category, key);
    `,
  },
  {
    version: 5,
    description: 'Create mistakes table',
    sql: `
      CREATE TABLE IF NOT EXISTS mistakes (
        id                      TEXT PRIMARY KEY,
        description             TEXT NOT NULL,
        category                TEXT NOT NULL CHECK(category IN ('technical','preference','timing','communication')),
        what_happened           TEXT NOT NULL,
        what_should_have_happened TEXT NOT NULL,
        root_cause              TEXT NOT NULL,
        prevention_strategy     TEXT NOT NULL,
        severity                TEXT NOT NULL CHECK(severity IN ('minor','moderate','major','critical')),
        resolved                INTEGER NOT NULL DEFAULT 0,
        recurrence_count        INTEGER NOT NULL DEFAULT 0,
        created_at              TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_mistakes_category ON mistakes(category);
      CREATE INDEX IF NOT EXISTS idx_mistakes_severity ON mistakes(severity);
      CREATE INDEX IF NOT EXISTS idx_mistakes_resolved ON mistakes(resolved);
    `,
  },
  {
    version: 6,
    description: 'Create detected_patterns table for PatternRecognizer persistence',
    sql: `
      CREATE TABLE IF NOT EXISTS detected_patterns (
        id           TEXT PRIMARY KEY,
        description  TEXT NOT NULL UNIQUE,
        confidence   REAL NOT NULL DEFAULT 0.5,
        hit_count    INTEGER NOT NULL DEFAULT 1,
        detected_at  TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON detected_patterns(confidence DESC);
      CREATE INDEX IF NOT EXISTS idx_patterns_last_seen ON detected_patterns(last_seen DESC);
    `,
  },
  {
    version: 7,
    description: 'Create reminders table for SchedulerAgent persistence',
    sql: `
      CREATE TABLE IF NOT EXISTS reminders (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        message       TEXT NOT NULL DEFAULT '',
        trigger_at    TEXT NOT NULL,
        recurring     INTEGER NOT NULL DEFAULT 0,
        interval_ms   INTEGER,
        status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','fired','cancelled')),
        fired_count   INTEGER NOT NULL DEFAULT 0,
        fired_at      TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
      CREATE INDEX IF NOT EXISTS idx_reminders_trigger_at ON reminders(trigger_at);
    `,
  },
  {
    version: 8,
    description: 'Create scheduled_tasks table with full schema',
    run(db) {
      // Create table with full schema (covers fresh installs)
      db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id                    TEXT PRIMARY KEY,
          name                  TEXT NOT NULL UNIQUE,
          cron_expression       TEXT NOT NULL,
          command               TEXT NOT NULL,
          enabled               INTEGER NOT NULL DEFAULT 1,
          last_run              TEXT,
          next_run              TEXT,
          created_at            TEXT NOT NULL,
          last_exit_code        INTEGER,
          last_duration_ms      INTEGER,
          consecutive_failures  INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled  ON scheduled_tasks(enabled);
        CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(next_run);
      `);

      // Safely add extra columns if the table was created by the old ensureSchedulerSchema()
      // (which only had the base 8 columns). SQLite has no ADD COLUMN IF NOT EXISTS, so we
      // inspect the existing columns and skip any that are already present.
      const existing = new Set(
        (db.pragma('table_info(scheduled_tasks)') as Array<{ name: string }>).map((r) => r.name),
      );
      if (!existing.has('last_exit_code')) {
        db.exec('ALTER TABLE scheduled_tasks ADD COLUMN last_exit_code INTEGER');
      }
      if (!existing.has('last_duration_ms')) {
        db.exec('ALTER TABLE scheduled_tasks ADD COLUMN last_duration_ms INTEGER');
      }
      if (!existing.has('consecutive_failures')) {
        db.exec(
          'ALTER TABLE scheduled_tasks ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0',
        );
      }
    },
  },
];

function runMigrations(database: Database.Database): void {
  // Create migrations tracking table
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const appliedVersions = new Set(
    database
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row: any) => row.version as number),
  );

  const pending = MIGRATIONS.filter((m) => !appliedVersions.has(m.version));

  if (pending.length === 0) {
    log.debug('No pending migrations');
    return;
  }

  const applyMigration = database.transaction((migration: Migration) => {
    log.info({ version: migration.version, description: migration.description }, 'Applying migration');
    if (migration.run) {
      migration.run(database);
    } else {
      database.exec(migration.sql);
    }
    database
      .prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  });

  for (const migration of pending) {
    applyMigration(migration);
  }

  log.info({ count: pending.length }, 'Migrations complete');
}
