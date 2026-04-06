// Nexus AI — Procedural memory (learned workflows, patterns, tool usage)

import type Database from 'better-sqlite3';
import type { Memory, MemoryLayer, MemoryType, Mistake } from '../types.js';
import { generateId, nowISO } from '../utils/helpers.js';
import { createLogger } from '../utils/logger.js';
import { getDatabase } from './database.js';

const log = createLogger('ProceduralMemory');

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
    summary: row.summary ?? null,
    importance: row.importance,
    confidence: row.confidence,
    emotionalValence: row.emotional_valence ?? null,
    createdAt: row.created_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
    tags: JSON.parse(row.tags || '[]'),
    relatedMemories: JSON.parse(row.related_memories || '[]'),
    source: row.source,
    metadata: JSON.parse(row.metadata || '{}'),
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

export class ProceduralMemory {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
    log.info('Procedural memory initialized');
  }

  // ─── Workflow / Procedure Storage ─────────────────────────────────

  /**
   * Store a learned procedure (sequence of steps from experience).
   */
  storeProcedure(
    name: string,
    steps: string[],
    context: string,
    successRate = 1.0,
  ): string {
    const id = generateId();
    const now = nowISO();
    const content = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');

    this.db
      .prepare(
        `INSERT INTO memories (id, layer, type, content, summary, importance, confidence,
          emotional_valence, created_at, last_accessed, access_count, tags, related_memories,
          source, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        'procedural',
        'workflow',
        content,
        name,
        0.7,
        successRate,
        null,
        now,
        now,
        0,
        JSON.stringify([context]),
        JSON.stringify([]),
        'procedural',
        JSON.stringify({ name, steps, context, successRate }),
      );

    log.debug({ id, name, stepCount: steps.length }, 'Stored procedure');
    return id;
  }

  /**
   * Store a tool usage pattern.
   */
  storeToolPattern(
    toolName: string,
    pattern: string,
    exampleInput: string,
    exampleOutput: string,
    successRate = 1.0,
  ): string {
    const id = generateId();
    const now = nowISO();
    const content = `Tool: ${toolName}\nPattern: ${pattern}\nExample Input: ${exampleInput}\nExample Output: ${exampleOutput}`;

    this.db
      .prepare(
        `INSERT INTO memories (id, layer, type, content, summary, importance, confidence,
          emotional_valence, created_at, last_accessed, access_count, tags, related_memories,
          source, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        'procedural',
        'workflow',
        content,
        `Tool pattern: ${toolName} - ${pattern}`,
        0.6,
        successRate,
        null,
        now,
        now,
        0,
        JSON.stringify([toolName, 'tool-pattern']),
        JSON.stringify([]),
        'tool-usage',
        JSON.stringify({
          toolName,
          pattern,
          exampleInput,
          exampleOutput,
          successRate,
        }),
      );

    log.debug({ id, toolName, pattern }, 'Stored tool pattern');
    return id;
  }

  /**
   * Store an error recovery procedure.
   */
  storeErrorRecovery(
    errorType: string,
    errorMessage: string,
    recoverySteps: string[],
    successRate = 1.0,
  ): string {
    const id = generateId();
    const now = nowISO();
    const content = `Error: ${errorType}\nMessage: ${errorMessage}\nRecovery:\n${recoverySteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;

    this.db
      .prepare(
        `INSERT INTO memories (id, layer, type, content, summary, importance, confidence,
          emotional_valence, created_at, last_accessed, access_count, tags, related_memories,
          source, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        'procedural',
        'workflow',
        content,
        `Error recovery: ${errorType}`,
        0.8,
        successRate,
        null,
        now,
        now,
        0,
        JSON.stringify([errorType, 'error-recovery']),
        JSON.stringify([]),
        'error-recovery',
        JSON.stringify({
          errorType,
          errorMessage,
          recoverySteps,
          successRate,
        }),
      );

    log.debug({ id, errorType }, 'Stored error recovery procedure');
    return id;
  }

  /**
   * Retrieve a procedure by its name (stored in summary field).
   */
  getProcedure(name: string): Memory | null {
    const row = this.db
      .prepare(
        "SELECT * FROM memories WHERE layer = 'procedural' AND summary = ? LIMIT 1",
      )
      .get(name) as RawMemoryRow | undefined;

    if (!row) return null;

    const now = nowISO();
    this.db
      .prepare(
        'UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?',
      )
      .run(now, row.id);

    return rowToMemory({
      ...row,
      last_accessed: now,
      access_count: row.access_count + 1,
    });
  }

  /**
   * Find procedures relevant to a given context (keyword match on tags, content, summary).
   */
  findRelevantProcedures(context: string, limit = 10): Memory[] {
    const terms = context
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (terms.length === 0) return [];

    const conditions = terms.map(
      () =>
        '(LOWER(tags) LIKE ? OR LOWER(content) LIKE ? OR LOWER(summary) LIKE ?)',
    );
    const params: unknown[] = [];
    for (const term of terms) {
      const pattern = `%${term}%`;
      params.push(pattern, pattern, pattern);
    }

    const sql = `
      SELECT * FROM memories
      WHERE layer = 'procedural'
        AND (${conditions.join(' OR ')})
      ORDER BY confidence DESC, importance DESC
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db
      .prepare(sql)
      .all(...params) as RawMemoryRow[];
    return rows.map(rowToMemory);
  }

  /**
   * Find tool patterns by tool name.
   */
  findToolPatterns(toolName: string): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
        WHERE layer = 'procedural'
          AND source = 'tool-usage'
          AND tags LIKE ?
        ORDER BY confidence DESC`,
      )
      .all(`%"${toolName}"%`) as RawMemoryRow[];
    return rows.map(rowToMemory);
  }

  /**
   * Find error recovery procedures by error type.
   */
  findErrorRecovery(errorType: string): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
        WHERE layer = 'procedural'
          AND source = 'error-recovery'
          AND tags LIKE ?
        ORDER BY confidence DESC`,
      )
      .all(`%"${errorType}"%`) as RawMemoryRow[];
    return rows.map(rowToMemory);
  }

  /**
   * Update the success rate of a procedure (exponential moving average).
   */
  updateSuccessRate(id: string, success: boolean): void {
    const outcome = success ? 1.0 : 0.0;
    const now = nowISO();

    const row = this.db
      .prepare('SELECT confidence, metadata FROM memories WHERE id = ?')
      .get(id) as { confidence: number; metadata: string } | undefined;

    if (!row) {
      log.warn({ id }, 'Procedure not found for success rate update');
      return;
    }

    const newConfidence = row.confidence * 0.8 + outcome * 0.2;
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    metadata.successRate = newConfidence;

    this.db
      .prepare(
        'UPDATE memories SET confidence = ?, metadata = ?, last_accessed = ? WHERE id = ?',
      )
      .run(newConfidence, JSON.stringify(metadata), now, id);

    log.debug(
      { id, success, newConfidence },
      'Updated procedure success rate',
    );
  }

  /**
   * Get all procedural memories.
   */
  getAll(limit = 100): Memory[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memories WHERE layer = 'procedural' ORDER BY importance DESC, confidence DESC LIMIT ?",
      )
      .all(limit) as RawMemoryRow[];
    return rows.map(rowToMemory);
  }

  // ─── Mistakes ─────────────────────────────────────────────────────

  /**
   * Record a mistake for future prevention.
   */
  recordMistake(
    mistake: Omit<Mistake, 'id' | 'createdAt'>,
  ): Mistake {
    const id = generateId();
    const now = nowISO();

    this.db
      .prepare(
        `INSERT INTO mistakes (id, description, category, what_happened, what_should_have_happened,
          root_cause, prevention_strategy, severity, resolved, recurrence_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        mistake.description,
        mistake.category,
        mistake.whatHappened,
        mistake.whatShouldHaveHappened,
        mistake.rootCause,
        mistake.preventionStrategy,
        mistake.severity,
        mistake.resolved ? 1 : 0,
        mistake.recurrenceCount,
        now,
      );

    log.info(
      { id, category: mistake.category, severity: mistake.severity },
      'Recorded mistake',
    );

    return { id, ...mistake, createdAt: now };
  }

  /**
   * Get mistakes by category.
   */
  getMistakesByCategory(
    category: Mistake['category'],
  ): Mistake[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM mistakes WHERE category = ? ORDER BY created_at DESC',
      )
      .all(category) as RawMistakeRow[];
    return rows.map(rowToMistake);
  }

  /**
   * Get all unresolved mistakes.
   */
  getUnresolvedMistakes(): Mistake[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM mistakes WHERE resolved = 0 ORDER BY severity DESC, created_at DESC',
      )
      .all() as RawMistakeRow[];
    return rows.map(rowToMistake);
  }

  /**
   * Get all mistakes.
   */
  getAllMistakes(limit = 100): Mistake[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM mistakes ORDER BY created_at DESC LIMIT ?',
      )
      .all(limit) as RawMistakeRow[];
    return rows.map(rowToMistake);
  }

  /**
   * Resolve a mistake by ID.
   */
  resolveMistake(id: string): boolean {
    const result = this.db
      .prepare('UPDATE mistakes SET resolved = 1 WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }

  /**
   * Increment the recurrence count of a mistake.
   */
  incrementRecurrence(id: string): void {
    this.db
      .prepare(
        'UPDATE mistakes SET recurrence_count = recurrence_count + 1 WHERE id = ?',
      )
      .run(id);
    log.warn({ id }, 'Mistake recurred');
  }

  /**
   * Search mistakes by keyword.
   */
  searchMistakes(query: string, limit = 20): Mistake[] {
    const pattern = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM mistakes
        WHERE description LIKE ?
          OR what_happened LIKE ?
          OR root_cause LIKE ?
          OR prevention_strategy LIKE ?
        ORDER BY created_at DESC
        LIMIT ?`,
      )
      .all(pattern, pattern, pattern, pattern, limit) as RawMistakeRow[];
    return rows.map(rowToMistake);
  }

  /**
   * Count procedural memories.
   */
  count(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM memories WHERE layer = 'procedural'",
      )
      .get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Count mistakes.
   */
  countMistakes(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM mistakes')
      .get() as { cnt: number };
    return row.cnt;
  }
}
