// Nexus AI — Multi-strategy memory retrieval with fusion scoring

import type Database from 'better-sqlite3';
import type { Memory, MemoryLayer, MemoryType } from '../types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('MemoryRetrieval');

export interface RetrievalOptions {
  limit?: number;
  layers?: MemoryLayer[];
  minImportance?: number;
}

interface ScoredMemory {
  memory: Memory;
  score: number;
}

export class MemoryRetrieval {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Multi-strategy retrieval with fusion scoring.
   *
   * Scoring formula:
   *   (contentMatch * 0.35) + (recency * 0.20) + (importance * 0.20)
   *   + (tagMatch * 0.15) + (accessFrequency * 0.10)
   */
  retrieve(query: string, options?: RetrievalOptions): Memory[] {
    const limit = options?.limit ?? 10;
    const minImportance = options?.minImportance ?? 0;
    const layers = options?.layers;

    // Pull a broad candidate set from SQLite
    const candidates = this.getCandidates(query, layers, minImportance);
    log.debug({ candidateCount: candidates.length, query }, 'Candidates fetched');

    // Score each candidate with the fusion formula
    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const nowMs = Date.now();

    const scored: ScoredMemory[] = candidates.map((memory) => {
      const contentScore = this.scoreContent(memory, queryTerms);
      const recencyScore = this.scoreRecency(memory, nowMs);
      const importanceScore = memory.importance; // already 0-1
      const tagScore = this.scoreTags(memory, queryTerms);
      const frequencyScore = this.scoreFrequency(memory);

      const score =
        contentScore * 0.35 +
        recencyScore * 0.2 +
        importanceScore * 0.2 +
        tagScore * 0.15 +
        frequencyScore * 0.1;

      return { memory, score };
    });

    // Sort descending by score, return top-K
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, limit).map((s) => s.memory);

    // Touch last_accessed on returned memories
    this.touchAccessed(results.map((m) => m.id));

    return results;
  }

  // ── Strategy 1: Content/keyword match ──────────────────────────

  private scoreContent(memory: Memory, queryTerms: string[]): number {
    if (queryTerms.length === 0) return 0;

    const text = `${memory.content} ${memory.summary ?? ''}`.toLowerCase();
    let hits = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) hits++;
    }
    return hits / queryTerms.length;
  }

  // ── Strategy 2: Recency bias (exponential decay) ──────────────

  private scoreRecency(memory: Memory, nowMs: number): number {
    const createdMs = new Date(memory.createdAt).getTime();
    const ageMs = nowMs - createdMs;
    const ageHours = ageMs / (1000 * 60 * 60);
    // Half-life of ~48 hours
    return Math.exp(-0.0144 * ageHours);
  }

  // ── Strategy 3: Importance filter (handled by SQL + direct value)

  // ── Strategy 4: Tag matching ──────────────────────────────────

  private scoreTags(memory: Memory, queryTerms: string[]): number {
    if (queryTerms.length === 0 || memory.tags.length === 0) return 0;

    const lowerTags = memory.tags.map((t) => t.toLowerCase());
    let hits = 0;
    for (const term of queryTerms) {
      if (lowerTags.some((tag) => tag.includes(term))) hits++;
    }
    return hits / queryTerms.length;
  }

  // ── Strategy 5: Access frequency ──────────────────────────────

  private scoreFrequency(memory: Memory): number {
    // Logarithmic scaling so frequent access helps but doesn't dominate
    return Math.min(1.0, Math.log2(memory.accessCount + 1) / 10);
  }

  // ── Candidate fetching ────────────────────────────────────────

  private getCandidates(
    query: string,
    layers?: MemoryLayer[],
    minImportance = 0,
  ): Memory[] {
    const pattern = `%${query}%`;
    let sql = `
      SELECT * FROM memories
      WHERE importance >= ?
        AND (content LIKE ? OR summary LIKE ? OR tags LIKE ?)
    `;
    const params: unknown[] = [minImportance, pattern, pattern, pattern];

    if (layers && layers.length > 0) {
      const placeholders = layers.map(() => '?').join(', ');
      sql += ` AND layer IN (${placeholders})`;
      params.push(...layers);
    }

    sql += ' ORDER BY created_at DESC LIMIT 200';

    const rows = this.db.prepare(sql).all(...params) as RawMemoryRow[];
    return rows.map(rowToMemory);
  }

  // ── Touch accessed ────────────────────────────────────────────

  private touchAccessed(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?',
    );
    for (const id of ids) {
      stmt.run(now, id);
    }
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
