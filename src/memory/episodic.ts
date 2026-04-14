// Nexus AI — Episodic memory layer (conversations, tasks, interaction events)

import type Database from 'better-sqlite3';
import type { AIMessage, Memory, MemoryLayer, MemoryType } from '../types.js';
import { generateId, nowISO, safeJsonParse } from '../utils/helpers.js';
import { createLogger } from '../utils/logger.js';
import { getDatabase } from './database.js';

const log = createLogger('EpisodicMemory');

export interface StoreOptions {
  type?: MemoryType;
  summary?: string;
  importance?: number;
  confidence?: number;
  emotionalValence?: number;
  tags?: string[];
  relatedMemories?: string[];
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  timeRange?: { from?: string; to?: string };
  tags?: string[];
  types?: MemoryType[];
  minImportance?: number;
  query?: string;
  limit?: number;
  offset?: number;
}

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
    tags: safeJsonParse<string[]>(row.tags, []),
    relatedMemories: safeJsonParse<string[]>(row.related_memories, []),
    source: row.source,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata, {}),
  };
}

export class EpisodicMemory {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
    log.info('Episodic memory initialized');
  }

  /**
   * Store a new episodic memory. Auto-scores importance if not provided.
   */
  store(content: string, options: StoreOptions = {}): Memory {
    const id = generateId();
    const now = nowISO();
    const importance = options.importance ?? this.scoreImportance(content, options);

    this.db
      .prepare(
        `INSERT INTO memories (id, layer, type, content, summary, importance, confidence,
          emotional_valence, created_at, last_accessed, access_count, tags, related_memories,
          source, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        'episodic',
        options.type ?? 'conversation',
        content,
        options.summary ?? null,
        importance,
        options.confidence ?? 1.0,
        options.emotionalValence ?? null,
        now,
        now,
        0,
        JSON.stringify(options.tags ?? []),
        JSON.stringify(options.relatedMemories ?? []),
        options.source ?? 'user',
        JSON.stringify(options.metadata ?? {}),
      );

    const memory: Memory = {
      id,
      layer: 'episodic',
      type: options.type ?? 'conversation',
      content,
      summary: options.summary ?? null,
      importance,
      confidence: options.confidence ?? 1.0,
      emotionalValence: options.emotionalValence ?? null,
      createdAt: now,
      lastAccessed: now,
      accessCount: 0,
      tags: options.tags ?? [],
      relatedMemories: options.relatedMemories ?? [],
      source: options.source ?? 'user',
      metadata: options.metadata ?? {},
    };

    log.debug({ id, type: memory.type, importance }, 'Stored episodic memory');
    return memory;
  }

  /**
   * Store a conversation summary (convenience wrapper).
   */
  storeConversation(
    summary: string,
    messages: AIMessage[],
    importance: number,
  ): string {
    const fullContent = messages.map((m) => `[${m.role}] ${m.content}`).join('\n');
    const memory = this.store(fullContent, {
      type: 'conversation',
      summary,
      importance,
      source: 'conversation',
      metadata: { messageCount: messages.length },
    });
    return memory.id;
  }

  /**
   * Store a general event.
   */
  storeEvent(
    eventType: string,
    description: string,
    metadata?: Record<string, unknown>,
  ): string {
    const memory = this.store(description, {
      type: 'task',
      tags: [eventType],
      source: eventType,
      metadata: metadata ?? {},
    });
    return memory.id;
  }

  /**
   * Retrieve a memory by ID, updating access tracking.
   */
  getById(id: string): Memory | null {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ? AND layer = 'episodic'")
      .get(id) as RawMemoryRow | undefined;

    if (!row) return null;

    const now = nowISO();
    this.db
      .prepare(
        'UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?',
      )
      .run(now, id);

    return rowToMemory({
      ...row,
      last_accessed: now,
      access_count: row.access_count + 1,
    });
  }

  /**
   * Update an existing episodic memory.
   */
  update(
    id: string,
    updates: Partial<
      Pick<
        Memory,
        | 'content'
        | 'summary'
        | 'importance'
        | 'confidence'
        | 'emotionalValence'
        | 'tags'
        | 'metadata'
      >
    >,
  ): boolean {
    const parts: string[] = [];
    const values: unknown[] = [];

    if (updates.content !== undefined) {
      parts.push('content = ?');
      values.push(updates.content);
    }
    if (updates.summary !== undefined) {
      parts.push('summary = ?');
      values.push(updates.summary);
    }
    if (updates.importance !== undefined) {
      parts.push('importance = ?');
      values.push(updates.importance);
    }
    if (updates.confidence !== undefined) {
      parts.push('confidence = ?');
      values.push(updates.confidence);
    }
    if (updates.emotionalValence !== undefined) {
      parts.push('emotional_valence = ?');
      values.push(updates.emotionalValence);
    }
    if (updates.tags !== undefined) {
      parts.push('tags = ?');
      values.push(JSON.stringify(updates.tags));
    }
    if (updates.metadata !== undefined) {
      parts.push('metadata = ?');
      values.push(JSON.stringify(updates.metadata));
    }

    if (parts.length === 0) return false;

    values.push(id);
    const result = this.db
      .prepare(
        `UPDATE memories SET ${parts.join(', ')} WHERE id = ? AND layer = 'episodic'`,
      )
      .run(...values);

    const changed = result.changes > 0;
    if (changed) log.debug({ id }, 'Updated episodic memory');
    return changed;
  }

  /**
   * Delete a memory by ID.
   */
  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM memories WHERE id = ? AND layer = 'episodic'")
      .run(id);
    const deleted = result.changes > 0;
    if (deleted) log.debug({ id }, 'Deleted episodic memory');
    return deleted;
  }

  /**
   * Search episodic memories with filters and keyword matching.
   */
  search(options: SearchOptions = {}): Memory[] {
    const conditions: string[] = ["layer = 'episodic'"];
    const params: unknown[] = [];

    if (options.types && options.types.length > 0) {
      conditions.push(
        `type IN (${options.types.map(() => '?').join(',')})`,
      );
      params.push(...options.types);
    }

    if (options.minImportance !== undefined) {
      conditions.push('importance >= ?');
      params.push(options.minImportance);
    }

    if (options.timeRange?.from) {
      conditions.push('created_at >= ?');
      params.push(options.timeRange.from);
    }

    if (options.timeRange?.to) {
      conditions.push('created_at <= ?');
      params.push(options.timeRange.to);
    }

    if (options.tags && options.tags.length > 0) {
      const tagConditions = options.tags.map(() => 'tags LIKE ? ESCAPE \'\\\'');
      conditions.push(`(${tagConditions.join(' OR ')})`);
      // Escape SQL LIKE wildcards in tag values to prevent injection
      params.push(...options.tags.map((t) => `%"${t.replace(/[%_\\]/g, '\\$&')}"%`));
    }

    if (options.query) {
      const STOP_WORDS = new Set([
        'a','an','the','is','are','was','were','be','been','being',
        'have','has','had','do','does','did','will','would','could','should','may','might',
        'i','me','my','we','our','you','your','he','she','his','her','they','their','it','its',
        'what','which','who','whom','this','that','these','those',
        'am','at','by','for','in','of','on','or','to','up','and','but','not','so',
        'how','when','where','why','there','here',
      ]);
      const terms = options.query
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
      for (const term of terms) {
        conditions.push(
          '(LOWER(content) LIKE ? OR LOWER(summary) LIKE ?)',
        );
        params.push(`%${term}%`, `%${term}%`);
      }
    }

    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const sql = `
      SELECT * FROM memories
      WHERE ${conditions.join(' AND ')}
      ORDER BY importance DESC, created_at DESC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const rows = this.db
      .prepare(sql)
      .all(...params) as RawMemoryRow[];

    // Update access tracking for returned memories
    if (rows.length > 0) {
      const now = nowISO();
      const updateStmt = this.db.prepare(
        'UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?',
      );
      const batchUpdate = this.db.transaction(() => {
        for (const row of rows) {
          updateStmt.run(now, row.id);
        }
      });
      batchUpdate();
    }

    return rows.map(rowToMemory);
  }

  /**
   * Search by time range.
   */
  searchByTime(start: string, end: string, limit = 20): Memory[] {
    return this.search({
      timeRange: { from: start, to: end },
      limit,
    });
  }

  /**
   * Search by content keywords.
   */
  searchByContent(query: string, limit = 10): Memory[] {
    return this.search({ query, limit });
  }

  /**
   * Get recent episodic memories.
   */
  getRecent(limit = 20): Memory[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memories WHERE layer = 'episodic' ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as RawMemoryRow[];
    return rows.map(rowToMemory);
  }

  /**
   * Count episodic memories, optionally filtered by type.
   */
  count(type?: MemoryType): number {
    if (type) {
      const row = this.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM memories WHERE layer = 'episodic' AND type = ?",
        )
        .get(type) as { cnt: number };
      return row.cnt;
    }
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM memories WHERE layer = 'episodic'",
      )
      .get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Heuristic importance scoring based on content analysis.
   */
  private scoreImportance(content: string, options: StoreOptions): number {
    let score = 0.3;

    const wordCount = content.split(/\s+/).length;
    if (wordCount > 100) score += 0.1;
    if (wordCount > 300) score += 0.1;

    const typeBoosts: Record<string, number> = {
      task: 0.15,
      fact: 0.1,
      preference: 0.15,
      workflow: 0.2,
    };
    if (options.type && typeBoosts[options.type]) {
      score += typeBoosts[options.type];
    }

    if (
      options.emotionalValence !== undefined &&
      Math.abs(options.emotionalValence) > 0.5
    ) {
      score += 0.1;
    }

    const importantPatterns = [
      /\b(important|critical|urgent|must|always|never|remember)\b/i,
      /\b(love|hate|prefer|favorite|best|worst)\b/i,
      /\b(password|secret|key|token|api)\b/i,
      /\b(birthday|anniversary|deadline|meeting)\b/i,
    ];
    for (const pattern of importantPatterns) {
      if (pattern.test(content)) {
        score += 0.05;
      }
    }

    if (options.tags && options.tags.length > 0) {
      score += Math.min(options.tags.length * 0.02, 0.1);
    }

    return Math.min(score, 1.0);
  }
}
