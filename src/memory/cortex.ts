// Nexus AI — Memory Cortex (main coordinator for all memory layers)

import type Database from 'better-sqlite3';
import type { Memory, MemoryLayer, MemoryType, Mistake, UserFact } from '../types.js';
import { generateId, nowISO } from '../utils/helpers.js';
import { createLogger } from '../utils/logger.js';
import { getDatabase } from './database.js';
import { EpisodicMemory } from './episodic.js';
import { ProceduralMemory } from './procedural.js';
import { MemoryRetrieval } from './retrieval.js';
import { SemanticMemory } from './semantic.js';

const log = createLogger('MemoryCortex');

export class MemoryCortex {
  private db: Database.Database;
  readonly episodic: EpisodicMemory;
  readonly semantic: SemanticMemory;
  readonly procedural: ProceduralMemory;
  readonly retrieval: MemoryRetrieval;

  constructor() {
    // Share the singleton connection — avoids dual-handle locking issues
    this.db = getDatabase();

    this.episodic = new EpisodicMemory();
    this.semantic = new SemanticMemory();
    this.procedural = new ProceduralMemory();
    this.retrieval = new MemoryRetrieval(this.db);

    log.info('Memory cortex initialized (shared DB connection)');
  }

  /** Expose the raw database handle (used by consolidation and other internal modules). */
  getDb(): Database.Database {
    return this.db;
  }

  /** Create all required tables if they don't exist. */
  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id                TEXT PRIMARY KEY,
        layer             TEXT NOT NULL CHECK(layer IN ('buffer','episodic','semantic','procedural')),
        type              TEXT NOT NULL CHECK(type IN ('conversation','task','fact','preference','workflow','contact','opinion')),
        content           TEXT NOT NULL,
        summary           TEXT,
        importance        REAL NOT NULL DEFAULT 0.5,
        confidence        REAL NOT NULL DEFAULT 1.0,
        emotional_valence REAL,
        created_at        TEXT NOT NULL,
        last_accessed     TEXT NOT NULL,
        access_count      INTEGER NOT NULL DEFAULT 0,
        tags              TEXT NOT NULL DEFAULT '[]',
        related_memories  TEXT NOT NULL DEFAULT '[]',
        source            TEXT NOT NULL DEFAULT '',
        metadata          TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id   TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        embedding   BLOB NOT NULL,
        model       TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_links (
        source_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        target_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        link_type   TEXT NOT NULL,
        strength    REAL NOT NULL DEFAULT 1.0,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id, link_type)
      );

      CREATE TABLE IF NOT EXISTS user_facts (
        id                  TEXT PRIMARY KEY,
        category            TEXT NOT NULL,
        key                 TEXT NOT NULL UNIQUE,
        value               TEXT NOT NULL,
        confidence          REAL NOT NULL DEFAULT 1.0,
        source_memory_id    TEXT,
        last_confirmed      TEXT,
        contradiction_count INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mistakes (
        id                        TEXT PRIMARY KEY,
        description               TEXT NOT NULL,
        category                  TEXT NOT NULL,
        what_happened             TEXT NOT NULL,
        what_should_have_happened TEXT NOT NULL,
        root_cause                TEXT NOT NULL,
        prevention_strategy       TEXT NOT NULL,
        severity                  TEXT NOT NULL CHECK(severity IN ('minor','moderate','major','critical')),
        resolved                  INTEGER NOT NULL DEFAULT 0,
        recurrence_count          INTEGER NOT NULL DEFAULT 0,
        created_at                TEXT NOT NULL
      );

      -- Indexes for common query patterns
      CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed);
      CREATE INDEX IF NOT EXISTS idx_user_facts_category ON user_facts(category);
      CREATE INDEX IF NOT EXISTS idx_user_facts_key ON user_facts(key);
      CREATE INDEX IF NOT EXISTS idx_mistakes_category ON mistakes(category);
      CREATE INDEX IF NOT EXISTS idx_mistakes_resolved ON mistakes(resolved);
    `);

    log.info('Database schema initialized');
  }

  /** Store a new memory, returns the generated ID. */
  store(memory: Partial<Memory>): string {
    const id = memory.id ?? generateId();
    const now = nowISO();

    this.db
      .prepare(
        `INSERT INTO memories (id, layer, type, content, summary, importance, confidence,
          emotional_valence, created_at, last_accessed, access_count, tags, related_memories,
          source, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        memory.layer ?? 'episodic',
        memory.type ?? 'conversation',
        memory.content ?? '',
        memory.summary ?? null,
        memory.importance ?? 0.5,
        memory.confidence ?? 1.0,
        memory.emotionalValence ?? null,
        memory.createdAt ?? now,
        memory.lastAccessed ?? now,
        memory.accessCount ?? 0,
        JSON.stringify(memory.tags ?? []),
        JSON.stringify(memory.relatedMemories ?? []),
        memory.source ?? '',
        JSON.stringify(memory.metadata ?? {}),
      );

    log.debug({ memoryId: id, layer: memory.layer }, 'Memory stored');
    return id;
  }

  /** Multi-strategy recall with optional filters. */
  recall(
    query: string,
    options?: { layer?: MemoryLayer; limit?: number; minImportance?: number },
  ): Memory[] {
    return this.retrieval.retrieve(query, {
      limit: options?.limit ?? 10,
      layers: options?.layer ? [options.layer] : undefined,
      minImportance: options?.minImportance,
    });
  }

  /** Get the most recent memories across all layers for context assembly. */
  getRecentContext(limit = 10): Memory[] {
    const rows = this.db
      .prepare('SELECT * FROM memories ORDER BY created_at DESC LIMIT ?')
      .all(limit) as RawMemoryRow[];

    return rows.map(rowToMemory);
  }

  /** Store a user fact, delegating to semantic memory. */
  storeFact(fact: Partial<UserFact>): string {
    const stored = this.semantic.storeFact({
      category: (fact.category ?? 'fact') as UserFact['category'],
      key: fact.key ?? generateId(),
      value: fact.value ?? '',
      confidence: fact.confidence ?? 1.0,
      sourceMemoryId: fact.sourceMemoryId ?? undefined,
    });
    return stored.id;
  }

  /** Retrieve facts, optionally filtered by category. */
  getFacts(category?: string): UserFact[] {
    if (category) return this.semantic.getFactsByCategory(category as UserFact['category']);

    const rows = this.db
      .prepare('SELECT * FROM user_facts ORDER BY confidence DESC')
      .all() as RawFactRow[];

    return rows.map(rowToFact);
  }

  /** Record a mistake for the learning system. */
  recordMistake(mistake: Partial<Mistake>): string {
    const id = mistake.id ?? generateId();
    const now = nowISO();

    this.db
      .prepare(
        `INSERT INTO mistakes (id, description, category, what_happened,
          what_should_have_happened, root_cause, prevention_strategy,
          severity, resolved, recurrence_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        mistake.description ?? '',
        mistake.category ?? 'technical',
        mistake.whatHappened ?? '',
        mistake.whatShouldHaveHappened ?? '',
        mistake.rootCause ?? '',
        mistake.preventionStrategy ?? '',
        mistake.severity ?? 'minor',
        mistake.resolved ? 1 : 0,
        mistake.recurrenceCount ?? 0,
        mistake.createdAt ?? now,
      );

    log.debug({ mistakeId: id, severity: mistake.severity }, 'Mistake recorded');
    return id;
  }

  /** Get mistakes, optionally filtered by resolved status. */
  getMistakes(resolved?: boolean): Mistake[] {
    let sql = 'SELECT * FROM mistakes';
    const params: unknown[] = [];

    if (resolved !== undefined) {
      sql += ' WHERE resolved = ?';
      params.push(resolved ? 1 : 0);
    }

    sql += ' ORDER BY created_at DESC';

    const rows = this.db.prepare(sql).all(...params) as RawMistakeRow[];
    return rows.map(rowToMistake);
  }

  /** Update the importance score of a specific memory. */
  updateImportance(id: string, importance: number): void {
    this.db
      .prepare('UPDATE memories SET importance = ? WHERE id = ?')
      .run(importance, id);
  }

  /** Create a typed link between two memories. */
  linkMemories(sourceId: string, targetId: string, linkType: string): void {
    const now = nowISO();

    this.db
      .prepare(
        `INSERT OR REPLACE INTO memory_links (source_id, target_id, link_type, strength, created_at)
        VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sourceId, targetId, linkType, 1.0, now);

    // Also update related_memories arrays on both sides
    for (const [selfId, otherId] of [
      [sourceId, targetId],
      [targetId, sourceId],
    ]) {
      const row = this.db
        .prepare('SELECT related_memories FROM memories WHERE id = ?')
        .get(selfId) as { related_memories: string } | undefined;

      if (row) {
        const related: string[] = JSON.parse(row.related_memories);
        if (!related.includes(otherId)) {
          related.push(otherId);
          this.db
            .prepare('UPDATE memories SET related_memories = ? WHERE id = ?')
            .run(JSON.stringify(related), selfId);
        }
      }
    }

    log.debug({ sourceId, targetId, linkType }, 'Memories linked');
  }

  /** Get aggregate statistics about the memory system. */
  getStats(): {
    totalMemories: number;
    byLayer: Record<string, number>;
    totalFacts: number;
    totalMistakes: number;
  } {
    const totalMemories = (
      this.db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }
    ).c;

    const layerRows = this.db
      .prepare('SELECT layer, COUNT(*) AS c FROM memories GROUP BY layer')
      .all() as { layer: string; c: number }[];

    const byLayer: Record<string, number> = {};
    for (const row of layerRows) {
      byLayer[row.layer] = row.c;
    }

    const totalFacts = (
      this.db.prepare('SELECT COUNT(*) AS c FROM user_facts').get() as { c: number }
    ).c;

    const totalMistakes = (
      this.db.prepare('SELECT COUNT(*) AS c FROM mistakes').get() as { c: number }
    ).c;

    return { totalMemories, byLayer, totalFacts, totalMistakes };
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
    log.info('Database connection closed');
  }
}

// ── Internal helpers ──────────────────────────────────────────────

interface RawMemoryRow {
  id: string;
  layer: string;
  type: string;
  content: string;
  summary: string | null;
  importance: number;
  confidence: number;
  emotional_valence: number | null;
  created_at: string;
  last_accessed: string;
  access_count: number;
  tags: string;
  related_memories: string;
  source: string;
  metadata: string;
}

interface RawFactRow {
  id: string;
  category: string;
  key: string;
  value: string;
  confidence: number;
  source_memory_id: string | null;
  last_confirmed: string | null;
  contradiction_count: number;
  created_at: string;
  updated_at: string;
}

interface RawMistakeRow {
  id: string;
  description: string;
  category: string;
  what_happened: string;
  what_should_have_happened: string;
  root_cause: string;
  prevention_strategy: string;
  severity: string;
  resolved: number;
  recurrence_count: number;
  created_at: string;
}

function rowToMemory(row: RawMemoryRow): Memory {
  return {
    id: row.id,
    layer: row.layer as MemoryLayer,
    type: row.type as MemoryType,
    content: row.content,
    summary: row.summary,
    importance: row.importance,
    confidence: row.confidence,
    emotionalValence: row.emotional_valence,
    createdAt: row.created_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
    tags: JSON.parse(row.tags),
    relatedMemories: JSON.parse(row.related_memories),
    source: row.source,
    metadata: JSON.parse(row.metadata),
  };
}

function rowToFact(row: RawFactRow): UserFact {
  return {
    id: row.id,
    category: row.category as UserFact['category'],
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    sourceMemoryId: row.source_memory_id,
    lastConfirmed: row.last_confirmed,
    contradictionCount: row.contradiction_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMistake(row: RawMistakeRow): Mistake {
  return {
    id: row.id,
    description: row.description,
    category: row.category as Mistake['category'],
    whatHappened: row.what_happened,
    whatShouldHaveHappened: row.what_should_have_happened,
    rootCause: row.root_cause,
    preventionStrategy: row.prevention_strategy,
    severity: row.severity as Mistake['severity'],
    resolved: row.resolved === 1,
    recurrenceCount: row.recurrence_count,
    createdAt: row.created_at,
  };
}
