// Nexus AI — Semantic memory (user facts, preferences, knowledge)

import type Database from 'better-sqlite3';
import type { UserFact } from '../types.js';
import { generateId, nowISO } from '../utils/helpers.js';
import { createLogger } from '../utils/logger.js';
import { getDatabase } from './database.js';

const log = createLogger('SemanticMemory');

type FactCategory = UserFact['category'];

export interface StoreFactOptions {
  category: FactCategory;
  key: string;
  value: string;
  confidence?: number;
  sourceMemoryId?: string | null;
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

function rowToFact(row: RawFactRow): UserFact {
  return {
    id: row.id,
    category: row.category as FactCategory,
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

export class SemanticMemory {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
    log.info('Semantic memory initialized');
  }

  /**
   * Store a new fact. If a fact with the same category+key already exists,
   * update it instead (upsert behavior with contradiction detection).
   */
  storeFact(options: StoreFactOptions): UserFact {
    const {
      category,
      key,
      value,
      confidence = 1.0,
      sourceMemoryId = null,
    } = options;
    const now = nowISO();

    // Check for existing fact with same category+key
    const existing = this.db
      .prepare('SELECT * FROM user_facts WHERE category = ? AND key = ?')
      .get(category, key) as RawFactRow | undefined;

    if (existing) {
      // Same value -- just confirm it
      if (existing.value === value) {
        return this.confirmFact(existing.id);
      }

      // Value differs -- contradiction
      const isContradiction = existing.confidence > 0.3;
      if (isContradiction) {
        log.info(
          { key, oldValue: existing.value, newValue: value },
          'Contradiction detected for fact',
        );
      }

      const newConfidence = isContradiction
        ? Math.max(0.3, confidence * 0.7)
        : confidence;
      const newContradictionCount =
        existing.contradiction_count + (isContradiction ? 1 : 0);

      this.db
        .prepare(
          `UPDATE user_facts SET value = ?, confidence = ?, source_memory_id = ?,
            last_confirmed = ?, contradiction_count = ?, updated_at = ?
          WHERE id = ?`,
        )
        .run(
          value,
          newConfidence,
          sourceMemoryId,
          now,
          newContradictionCount,
          now,
          existing.id,
        );

      return rowToFact({
        ...existing,
        value,
        confidence: newConfidence,
        source_memory_id: sourceMemoryId,
        last_confirmed: now,
        contradiction_count: newContradictionCount,
        updated_at: now,
      });
    }

    // New fact
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO user_facts (id, category, key, value, confidence, source_memory_id,
          last_confirmed, contradiction_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, category, key, value, confidence, sourceMemoryId, now, 0, now, now);

    log.debug({ id, category, key }, 'Stored new fact');

    return {
      id,
      category,
      key,
      value,
      confidence,
      sourceMemoryId,
      lastConfirmed: now,
      contradictionCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Confirm an existing fact (bumps confidence and refreshes last_confirmed).
   */
  confirmFact(id: string): UserFact {
    const now = nowISO();
    this.db
      .prepare(
        `UPDATE user_facts
        SET confidence = MIN(1.0, confidence + 0.1),
            last_confirmed = ?,
            updated_at = ?
        WHERE id = ?`,
      )
      .run(now, now, id);

    const row = this.db
      .prepare('SELECT * FROM user_facts WHERE id = ?')
      .get(id) as RawFactRow;

    log.debug({ id, confidence: row.confidence }, 'Fact confirmed');
    return rowToFact(row);
  }

  /**
   * Retrieve a single fact by key.
   */
  getFact(key: string): UserFact | null {
    const row = this.db
      .prepare('SELECT * FROM user_facts WHERE key = ?')
      .get(key) as RawFactRow | undefined;
    return row ? rowToFact(row) : null;
  }

  /**
   * Retrieve a fact by ID.
   */
  getFactById(id: string): UserFact | null {
    const row = this.db
      .prepare('SELECT * FROM user_facts WHERE id = ?')
      .get(id) as RawFactRow | undefined;
    return row ? rowToFact(row) : null;
  }

  /**
   * Get all facts in a given category, ordered by confidence.
   */
  getFactsByCategory(category: FactCategory): UserFact[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM user_facts WHERE category = ? ORDER BY confidence DESC',
      )
      .all(category) as RawFactRow[];
    return rows.map(rowToFact);
  }

  /**
   * Get all user preferences.
   */
  getAllPreferences(): UserFact[] {
    return this.getFactsByCategory('preference');
  }

  /**
   * Get all facts across all categories.
   */
  getAllFacts(): UserFact[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM user_facts ORDER BY category, confidence DESC',
      )
      .all() as RawFactRow[];
    return rows.map(rowToFact);
  }

  /**
   * Update a fact's value and optionally its confidence.
   */
  updateFact(key: string, value: string, confidence?: number): boolean {
    const now = nowISO();

    if (confidence !== undefined) {
      const result = this.db
        .prepare(
          `UPDATE user_facts SET value = ?, confidence = ?, last_confirmed = ?, updated_at = ?
          WHERE key = ?`,
        )
        .run(value, confidence, now, now, key);
      return result.changes > 0;
    }

    const result = this.db
      .prepare(
        'UPDATE user_facts SET value = ?, last_confirmed = ?, updated_at = ? WHERE key = ?',
      )
      .run(value, now, now, key);
    return result.changes > 0;
  }

  /**
   * Record a contradiction against a fact. Increments count and lowers confidence.
   */
  contradictFact(key: string): boolean {
    const now = nowISO();
    const result = this.db
      .prepare(
        `UPDATE user_facts
        SET contradiction_count = contradiction_count + 1,
            confidence = MAX(0.0, confidence - 0.15),
            updated_at = ?
        WHERE key = ?`,
      )
      .run(now, key);
    if (result.changes > 0) {
      log.info({ key }, 'Fact contradicted');
    }
    return result.changes > 0;
  }

  /**
   * Delete a fact by key.
   */
  deleteFact(key: string): boolean {
    const result = this.db
      .prepare('DELETE FROM user_facts WHERE key = ?')
      .run(key);
    return result.changes > 0;
  }

  /**
   * Delete a fact by ID.
   */
  deleteFactById(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM user_facts WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }

  /**
   * Keyword search across facts (key + value + category).
   */
  searchFacts(query: string, limit = 50): UserFact[] {
    const STOP_WORDS = new Set([
      'a','an','the','is','are','was','were','be','been','being',
      'have','has','had','do','does','did','will','would','could','should','may','might',
      'i','me','my','we','our','you','your','he','she','his','her','they','their','it','its',
      'what','which','who','whom','this','that','these','those',
      'am','at','by','for','in','of','on','or','to','up','and','but','not','so',
      'how','when','where','why','there','here',
    ]);
    const terms = query
      .toLowerCase()
      .replace(/[^\w\s]/g, '') // strip punctuation
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
    if (terms.length === 0) return [];

    const conditions = terms.map(
      () =>
        '(LOWER(key) LIKE ? ESCAPE \'\\\' OR LOWER(value) LIKE ? ESCAPE \'\\\' OR LOWER(category) LIKE ? ESCAPE \'\\\')',
    );
    const params: unknown[] = [];
    for (const term of terms) {
      // Escape LIKE wildcards in user input to prevent substring pollution
      const escaped = term.replace(/[%_\\]/g, '\\$&');
      const pattern = `%${escaped}%`;
      params.push(pattern, pattern, pattern);
    }

    // Match if ANY term matches (OR semantics) — AND was overly restrictive
    const sql = `
      SELECT * FROM user_facts
      WHERE ${conditions.join(' OR ')}
      ORDER BY confidence DESC
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db
      .prepare(sql)
      .all(...params) as RawFactRow[];
    return rows.map(rowToFact);
  }

  /**
   * Count all facts, optionally by category.
   */
  count(category?: FactCategory): number {
    if (category) {
      const row = this.db
        .prepare(
          'SELECT COUNT(*) as cnt FROM user_facts WHERE category = ?',
        )
        .get(category) as { cnt: number };
      return row.cnt;
    }
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM user_facts')
      .get() as { cnt: number };
    return row.cnt;
  }
}
