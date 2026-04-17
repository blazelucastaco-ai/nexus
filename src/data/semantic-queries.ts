// Semantic-memory query repository for cross-subsystem consumers.
//
// This module owns the "aged + relevant" query that Time Capsule uses:
// find high-importance semantic memories that match a query embedding but
// haven't been accessed in a while (signal that they're worth re-surfacing).

import { getDatabase } from '../memory/database.js';
import { computeEmbedding, cosineSimilarity, type SparseVector } from '../memory/embeddings.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SemanticQueryRepo');

export interface AgedMatch {
  id: string;
  content: string;
  type: string;
  importance: number;
  createdAt: string;
  lastAccessed: string | null;
  similarity: number;
  ageDays: number;
}

/**
 * Find semantic memories that match a query by embedding similarity,
 * filtered to the "aged" band — meaningful importance, but hasn't been
 * recalled in a while. Caller supplies a query string; we do the embedding.
 *
 * Strategy:
 * - Fetch candidate rows filtered by importance and last-accessed age (cheap SQL)
 * - Compute cosine similarity against the query embedding (per-row)
 * - Return top-K by similarity above the threshold
 *
 * Returns empty if the query produces a zero-term embedding or nothing matches.
 */
export function findAgedRelevantMemories(params: {
  query: string;
  minImportance?: number;
  minSimilarity?: number;
  agedForDays?: number;
  limit?: number;
}): AgedMatch[] {
  const {
    query,
    minImportance = 0.6,
    minSimilarity = 0.55,
    agedForDays = 14,
    limit = 3,
  } = params;

  const queryVec = computeEmbedding(query);
  if (Object.keys(queryVec).length === 0) return [];

  const cutoffISO = new Date(Date.now() - agedForDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    const db = getDatabase();
    // Candidate filter: semantic layer, importance band, last_accessed old enough
    // (or never accessed — NULL counts as "not recently recalled").
    const rows = db
      .prepare(
        `SELECT m.id, m.content, m.type, m.importance, m.created_at, m.last_accessed,
                e.embedding
         FROM memories m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id
         WHERE m.layer = 'semantic'
           AND m.importance >= ?
           AND (m.last_accessed IS NULL OR m.last_accessed < ?)
           AND e.embedding IS NOT NULL
         ORDER BY m.importance DESC
         LIMIT 200`,
      )
      .all(minImportance, cutoffISO) as Array<{
        id: string; content: string; type: string; importance: number;
        created_at: string; last_accessed: string | null;
        embedding: Buffer;
      }>;

    const scored: AgedMatch[] = [];
    const nowMs = Date.now();

    for (const row of rows) {
      let vec: SparseVector;
      try {
        vec = JSON.parse(row.embedding.toString('utf-8')) as SparseVector;
      } catch {
        continue;
      }
      const similarity = cosineSimilarity(queryVec, vec);
      if (similarity < minSimilarity) continue;

      const ageMs = nowMs - new Date(row.created_at).getTime();
      scored.push({
        id: row.id,
        content: row.content,
        type: row.type,
        importance: row.importance,
        createdAt: row.created_at,
        lastAccessed: row.last_accessed,
        similarity,
        ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  } catch (err) {
    log.debug({ err }, 'findAgedRelevantMemories query failed');
    return [];
  }
}

/**
 * Bump last_accessed on memories that were surfaced — signals they're
 * "fresh again" and shouldn't be surfaced immediately the next turn.
 */
export function markAsAccessed(ids: string[]): void {
  if (ids.length === 0) return;
  try {
    const db = getDatabase();
    const stmt = db.prepare('UPDATE memories SET last_accessed = datetime(\'now\'), access_count = access_count + 1 WHERE id = ?');
    const tx = db.transaction((batch: string[]) => {
      for (const id of batch) stmt.run(id);
    });
    tx(ids);
  } catch (err) {
    log.debug({ err, count: ids.length }, 'markAsAccessed failed');
  }
}
