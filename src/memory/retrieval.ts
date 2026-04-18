// Nexus AI — Multi-strategy memory retrieval with fusion scoring
//
// Scoring pipeline (Phase 3.2 + 3.3):
//   hybridContent = 0.6 * keywordScore + 0.4 * vectorScore
//   base = hybridContent * 0.40 + importanceScore * 0.25
//        + tagScore * 0.20 + frequencyScore * 0.15
//   finalScore = base * temporalDecay   (episodic/buffer only — 30-day half-life)

import type Database from 'better-sqlite3';
import type { Memory, MemoryLayer, MemoryType } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { safeJsonParse } from '../utils/helpers.js';
import { vectorSearch, cosineSimilarity, computeEmbedding } from './embeddings.js';

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

// Layers whose memories decay over time (episodic knowledge fades; semantic/procedural is evergreen)
const DECAYING_LAYERS = new Set<MemoryLayer>(['buffer', 'episodic']);

export class MemoryRetrieval {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Multi-strategy retrieval with hybrid BM25+vector fusion and temporal decay.
   *
   * Scoring formula:
   *   hybridContent  = 0.6 * keywordScore + 0.4 * vectorScore
   *   base           = hybridContent * 0.40 + importanceScore * 0.25
   *                  + tagScore * 0.20 + frequencyScore * 0.15
   *   finalScore     = base * temporalDecay   (episodic/buffer: 30-day half-life)
   *                    base                   (semantic/procedural: exempt from decay)
   */
  retrieve(query: string, options?: RetrievalOptions): Memory[] {
    const limit = options?.limit ?? 10;
    const minImportance = options?.minImportance ?? 0;
    const layers = options?.layers;

    // Pull a broad candidate set from SQLite via keyword LIKE
    const candidates = this.getCandidates(query, layers, minImportance);
    log.debug({ candidateCount: candidates.length, query }, 'Candidates fetched');

    // Build vector score map from embedding search (top 50 by cosine similarity)
    const vectorScores = this.buildVectorScoreMap(query, 50);

    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);

    const scored: ScoredMemory[] = candidates.map((memory) => {
      // --- Keyword score (BM25-like term overlap) ---
      const keywordScore = this.scoreContent(memory, queryTerms);

      // --- Vector score (cosine similarity from embedding index) ---
      const vectorScore = vectorScores.get(memory.id) ?? 0;

      // --- Hybrid content score ---
      const hybridContent = 0.6 * keywordScore + 0.4 * vectorScore;

      // --- Other factors ---
      const importanceScore = memory.importance;
      const tagScore = this.scoreTags(memory, queryTerms);
      const frequencyScore = this.scoreFrequency(memory);

      // --- Base combined score ---
      const base =
        hybridContent * 0.40 +
        importanceScore * 0.25 +
        tagScore * 0.20 +
        frequencyScore * 0.15;

      // --- Temporal decay (Phase 3.3) ---
      // Formula: score *= exp(-0.693 / 30 * ageDays)  → 30-day half-life
      // Semantic and procedural memories are evergreen — exempt from decay.
      const score = DECAYING_LAYERS.has(memory.layer)
        ? base * this.temporalDecay(memory)
        : base;

      return { memory, score };
    });

    // Augment with any vector-only hits not already in keyword candidates
    // (memories that match semantically but not lexically)
    const candidateIds = new Set(candidates.map((m) => m.id));
    const vectorOnlyHits = this.getVectorOnlyHits(vectorScores, candidateIds, minImportance, layers);

    for (const memory of vectorOnlyHits) {
      const vectorScore = vectorScores.get(memory.id) ?? 0;
      const base =
        0.4 * vectorScore +
        0.25 * memory.importance +
        0.15 * this.scoreFrequency(memory);

      const score = DECAYING_LAYERS.has(memory.layer)
        ? base * this.temporalDecay(memory)
        : base;

      scored.push({ memory, score });
    }

    // Sort descending by score, then MMR re-rank for diversity
    scored.sort((a, b) => b.score - a.score);
    const reranked = mmrRerank(scored.map((s) => ({ ...s, content: s.memory.content })));
    const results = reranked.slice(0, limit).map((s) => s.memory);

    // Touch last_accessed on returned memories
    this.touchAccessed(results.map((m) => m.id));

    return results;
  }

  // ── Phase 3.3: Temporal decay ──────────────────────────────────────────────

  private temporalDecay(memory: Memory): number {
    const createdMs = new Date(memory.createdAt).getTime();
    // Guard: invalid date → treat as recent (no decay)
    if (Number.isNaN(createdMs)) return 1.0;
    const ageDays = (Date.now() - createdMs) / (1000 * 60 * 60 * 24);
    // Half-life = 30 days: decay = exp(-ln2 / 30 * ageDays)
    return Math.exp((-0.693 / 30) * ageDays);
  }

  // ── Phase 3.2: Vector score map ────────────────────────────────────────────

  private buildVectorScoreMap(query: string, topK: number): Map<string, number> {
    const hits = vectorSearch(query, topK);
    const map = new Map<string, number>();
    for (const { memoryId, score } of hits) {
      map.set(memoryId, score);
    }
    return map;
  }

  /**
   * Fetch memories that matched via vector search but were not returned by
   * the keyword LIKE query.
   */
  private getVectorOnlyHits(
    vectorScores: Map<string, number>,
    excludeIds: Set<string>,
    minImportance: number,
    layers?: MemoryLayer[],
  ): Memory[] {
    const idsToFetch = [...vectorScores.keys()].filter((id) => !excludeIds.has(id));
    if (idsToFetch.length === 0) return [];

    const placeholders = idsToFetch.map(() => '?').join(', ');
    let sql = `SELECT * FROM memories WHERE id IN (${placeholders}) AND importance >= ?`;
    const params: unknown[] = [...idsToFetch, minImportance];

    if (layers && layers.length > 0) {
      const lp = layers.map(() => '?').join(', ');
      sql += ` AND layer IN (${lp})`;
      params.push(...layers);
    }

    const rows = this.db.prepare(sql).all(...params) as RawMemoryRow[];
    return rows.map(rowToMemory);
  }

  // ── Strategy 1: Keyword / BM25-like match ──────────────────────────────────

  private scoreContent(memory: Memory, queryTerms: string[]): number {
    if (queryTerms.length === 0) return 0;

    const text = `${memory.content} ${memory.summary ?? ''}`.toLowerCase();
    let hits = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) hits++;
    }
    return hits / queryTerms.length;
  }

  // ── Strategy 3: Tag matching ───────────────────────────────────────────────

  private scoreTags(memory: Memory, queryTerms: string[]): number {
    if (queryTerms.length === 0 || memory.tags.length === 0) return 0;

    const tagString = memory.tags.join(' ').toLowerCase();
    let hits = 0;
    for (const term of queryTerms) {
      if (tagString.includes(term)) hits++;
    }
    return hits / queryTerms.length;
  }

  // ── Strategy 4: Access frequency ──────────────────────────────────────────

  private scoreFrequency(memory: Memory): number {
    return Math.min(1.0, Math.log2(memory.accessCount + 1) / 10);
  }

  // ── Candidate fetching (keyword LIKE) ─────────────────────────────────────

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

  // ── Touch accessed ─────────────────────────────────────────────────────────

  private touchAccessed(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    // Single batched UPDATE via IN (…) — previously this was N individual
    // prepared-statement runs wrapped in a transaction (FIND-PRF-04). One
    // statement is simpler and measurably faster on typical 20-result recalls.
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(
      `UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id IN (${placeholders})`,
    );
    stmt.run(now, ...ids);
  }
}

// ── MMR Re-ranking ────────────────────────────────────────────────────────────

function mmrRerank(results: any[], lambda = 0.7): any[] {
  if (results.length <= 1) return results;
  const tokenize = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(Boolean));
  const jaccard = (a: Set<string>, b: Set<string>) => {
    let inter = 0;
    for (const x of a) { if (b.has(x)) inter++; }
    return inter / (a.size + b.size - inter || 1);
  };
  const selected: any[] = [results[0]];
  const remaining = results.slice(1);
  while (remaining.length > 0 && selected.length < results.length) {
    let bestIdx = 0, bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const rel = remaining[i].score || 0;
      const candidateTokens = tokenize(remaining[i].content || '');
      // Use reduce instead of spread to avoid stack overflow on large arrays
      const maxSim = selected.reduce((max, s) => {
        const sim = jaccard(candidateTokens, tokenize(s.content || ''));
        return sim > max ? sim : max;
      }, 0);
      const mmr = lambda * rel - (1 - lambda) * maxSim;
      if (mmr > bestScore) { bestScore = mmr; bestIdx = i; }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]);
  }
  return selected;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

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
    tags: safeJsonParse<string[]>(row.tags, []),
    relatedMemories: safeJsonParse<string[]>(row.related_memories, []),
    source: row.source,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata, {}),
  };
}
