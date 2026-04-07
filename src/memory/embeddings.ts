// Nexus AI — Local TF-IDF-style text embeddings (no external API)
//
// Produces sparse unit-normalized word-frequency vectors stored in the
// memory_embeddings table. Suitable for cosine similarity on short/medium text.

import { getDatabase } from './database.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Embeddings');

const STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should',
  'i','me','my','we','our','you','your','he','she','his','her','they','their','it','its',
  'this','that','these','those','what','which','who','whom',
  'am','at','by','for','in','of','on','or','to','up','and','but','not','so',
  'how','when','where','why','there','here','just','also','about','with','from',
  'can','may','might','must','shall','need','dare','used','ought',
]);

export type SparseVector = Record<string, number>;

/**
 * Tokenize text into lower-cased alphabetic tokens, stripping stop words.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Compute a TF-style unit-normalized sparse vector for text.
 * Returns {} for empty / all-stop-word input.
 */
export function computeEmbedding(text: string): SparseVector {
  const tokens = tokenize(text);
  if (tokens.length === 0) return {};

  const freq: Record<string, number> = {};
  for (const t of tokens) {
    freq[t] = (freq[t] ?? 0) + 1;
  }

  // L2-normalize so dot product == cosine similarity
  let norm = 0;
  for (const v of Object.values(freq)) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return {};

  const result: SparseVector = {};
  for (const [k, v] of Object.entries(freq)) {
    result[k] = v / norm;
  }
  return result;
}

/**
 * Cosine similarity between two sparse unit-normalized vectors.
 * Result is in [0, 1] for non-negative frequency vectors.
 */
export function cosineSimilarity(a: SparseVector, b: SparseVector): number {
  // Iterate over the smaller set for efficiency
  const [small, large] =
    Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];

  let dot = 0;
  for (const [k, va] of Object.entries(small)) {
    const vb = large[k];
    if (vb !== undefined) dot += va * vb;
  }
  return dot;
}

// ── Database helpers ──────────────────────────────────────────────────────────

/**
 * Compute and upsert an embedding for a memory ID.
 * Safe to call multiple times — uses INSERT OR REPLACE.
 */
export function storeEmbedding(memoryId: string, text: string): void {
  const db = getDatabase();
  const vec = computeEmbedding(text);
  const termCount = Object.keys(vec).length;
  if (termCount === 0) return;

  const blob = Buffer.from(JSON.stringify(vec), 'utf-8');
  db.prepare(
    `INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding, model)
     VALUES (?, ?, 'tfidf-local')`,
  ).run(memoryId, blob);

  log.debug({ memoryId, terms: termCount }, 'Embedding stored');
}

/**
 * Retrieve a parsed sparse vector for a memory ID.
 * Returns null if no embedding exists or if parsing fails.
 */
export function getEmbedding(memoryId: string): SparseVector | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT embedding FROM memory_embeddings WHERE memory_id = ?')
    .get(memoryId) as { embedding: Buffer } | undefined;

  if (!row) return null;
  try {
    return JSON.parse(row.embedding.toString('utf-8')) as SparseVector;
  } catch {
    return null;
  }
}

/**
 * Fetch all stored embeddings for batch vector search.
 * Returns [memoryId, vector] pairs, skipping corrupted entries.
 */
export function getAllEmbeddings(): Array<{ memoryId: string; vector: SparseVector }> {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT memory_id, embedding FROM memory_embeddings')
    .all() as { memory_id: string; embedding: Buffer }[];

  const result: Array<{ memoryId: string; vector: SparseVector }> = [];
  for (const row of rows) {
    try {
      result.push({
        memoryId: row.memory_id,
        vector: JSON.parse(row.embedding.toString('utf-8')) as SparseVector,
      });
    } catch {
      // skip corrupted entries silently
    }
  }
  return result;
}

/**
 * Find the top-K most similar embeddings to a query text.
 * Returns pairs of [memoryId, cosineSimilarity] sorted descending.
 */
export function vectorSearch(
  queryText: string,
  topK = 20,
): Array<{ memoryId: string; score: number }> {
  const queryVec = computeEmbedding(queryText);
  if (Object.keys(queryVec).length === 0) return [];

  const all = getAllEmbeddings();
  const scored = all
    .map(({ memoryId, vector }) => ({
      memoryId,
      score: cosineSimilarity(queryVec, vector),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}
