// Conversation-thread query repository.
//
// Cross-session "we've talked about this before" lookups. Pulls prior episodic
// memories (conversations, session summaries, task notes) that match the current
// query by embedding similarity — regardless of age or importance. This is the
// "context stitching" data source: it answers "what have we discussed on this
// topic in prior sessions?"
//
// Distinct from semantic-queries: that module is for aged/important memories
// (Time Capsule's domain). This is for broad topical recall across time.

import { getDatabase } from '../memory/database.js';
import { computeEmbedding, cosineSimilarity, type SparseVector } from '../memory/embeddings.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ConversationQueryRepo');

export interface RelatedConversation {
  id: string;
  content: string;
  type: string;
  tags: string;
  createdAt: string;
  similarity: number;
  ageHours: number;
}

/**
 * Find prior episodic memories related to a query by embedding similarity.
 *
 * Excludes the last N hours (default 1h) so the "current conversation" doesn't
 * echo back at itself. Skips low-similarity matches to keep noise out.
 */
export function findRelatedConversations(params: {
  query: string;
  minSimilarity?: number;
  limit?: number;
  excludeRecentHours?: number;
  maxAgeHours?: number;
}): RelatedConversation[] {
  const {
    query,
    minSimilarity = 0.15,
    limit = 3,
    excludeRecentHours = 1,
    maxAgeHours = 24 * 30, // Default 30 days
  } = params;

  const queryVec = computeEmbedding(query);
  if (Object.keys(queryVec).length === 0) return [];

  const now = Date.now();
  const tooRecentISO = new Date(now - excludeRecentHours * 60 * 60 * 1000).toISOString();
  const tooOldISO = new Date(now - maxAgeHours * 60 * 60 * 1000).toISOString();

  try {
    const db = getDatabase();
    // Pull candidate rows: episodic layer, within time window, with embeddings.
    // Prefer conversation/session-summary/task types — these represent actual
    // thread state, not raw tool logs.
    const rows = db
      .prepare(
        `SELECT m.id, m.content, m.type, m.tags, m.created_at, e.embedding
         FROM memories m
         INNER JOIN memory_embeddings e ON e.memory_id = m.id
         WHERE m.layer = 'episodic'
           AND m.created_at < ?
           AND m.created_at > ?
           AND m.type IN ('conversation', 'task', 'session_summary', 'fact')
         ORDER BY m.created_at DESC
         LIMIT 300`,
      )
      .all(tooRecentISO, tooOldISO) as Array<{
        id: string; content: string; type: string; tags: string;
        created_at: string; embedding: Buffer;
      }>;

    const scored: RelatedConversation[] = [];

    for (const row of rows) {
      let vec: SparseVector;
      try {
        vec = JSON.parse(row.embedding.toString('utf-8')) as SparseVector;
      } catch {
        continue;
      }
      const similarity = cosineSimilarity(queryVec, vec);
      if (similarity < minSimilarity) continue;

      const ageMs = now - new Date(row.created_at).getTime();
      scored.push({
        id: row.id,
        content: row.content,
        type: row.type,
        tags: row.tags,
        createdAt: row.created_at,
        similarity,
        ageHours: ageMs / (60 * 60 * 1000),
      });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  } catch (err) {
    log.debug({ err }, 'findRelatedConversations query failed');
    return [];
  }
}
