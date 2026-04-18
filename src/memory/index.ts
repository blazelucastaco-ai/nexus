// Nexus AI — Unified Memory Manager

import type {
  AIMessage,
  Memory,
  MemoryLayer,
  MemoryType,
  Mistake,
  UserFact,
} from '../types.js';
import { nowISO } from '../utils/helpers.js';
import { createLogger } from '../utils/logger.js';
import {
  MemoryConsolidation,
  type ConsolidationReport,
  type ConsolidationStats,
} from './consolidation.js';
import { closeDatabase, getDatabase } from './database.js';
import { EpisodicMemory } from './episodic.js';
import { ProceduralMemory } from './procedural.js';
import { SemanticMemory } from './semantic.js';
import { ShortTermMemory, type BufferEntry } from './short-term.js';
import { EmbeddingProvider, cosineSimilarity } from '../providers/embeddings.js';
import { containsSelfDisclosure, redactSelfDisclosure } from '../core/self-protection.js';

const log = createLogger('MemoryManager');

export interface StoreMemoryOptions {
  type?: MemoryType;
  summary?: string;
  importance?: number;
  confidence?: number;
  emotionalValence?: number;
  tags?: string[];
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface RecallOptions {
  layers?: MemoryLayer[];
  types?: MemoryType[];
  limit?: number;
  minImportance?: number;
  timeRange?: { from?: string; to?: string };
  tags?: string[];
}

export interface RelevantContext {
  recentMessages: AIMessage[];
  relevantMemories: Memory[];
  relevantFacts: UserFact[];
  unresolvedMistakes: Mistake[];
}

export class MemoryManager {
  readonly shortTerm: ShortTermMemory;
  readonly episodic: EpisodicMemory;
  readonly semantic: SemanticMemory;
  readonly procedural: ProceduralMemory;
  readonly consolidation: MemoryConsolidation;

  private initialized = false;
  private embeddingProvider?: EmbeddingProvider;
  private embeddingModel = 'local';

  constructor(maxShortTerm = 50) {
    // Initialize the database (creates tables if needed)
    getDatabase();

    this.shortTerm = new ShortTermMemory(maxShortTerm);
    this.episodic = new EpisodicMemory();
    this.semantic = new SemanticMemory();
    this.procedural = new ProceduralMemory();
    this.consolidation = new MemoryConsolidation(this.semantic);

    this.initialized = true;
    log.info('MemoryManager initialized with all layers');
  }

  /**
   * Wire a semantic embedding provider into recall.
   * Call this after construction — openai gives best results, local works offline.
   */
  setEmbeddingProvider(provider: EmbeddingProvider, model = 'local'): void {
    this.embeddingProvider = provider;
    this.embeddingModel = model;
    log.info({ model }, 'Semantic embedding provider wired into MemoryManager');
  }

  // ─── Unified Store ────────────────────────────────────────────────

  /**
   * Store content into a specific memory layer.
   */
  store(
    layer: MemoryLayer,
    type: MemoryType,
    content: string,
    options: StoreMemoryOptions = {},
  ): Memory | BufferEntry | UserFact | string {
    // L6: self-protection — refuse to persist content that contains NEXUS
    // source paths, module names, or architectural disclosures. Prevents
    // leaked disclosures from being recalled later. Exception: 'buffer'
    // layer (short-term) where we also store the user's raw utterances —
    // filtering there could drop legitimate user messages.
    if (layer !== 'buffer' && containsSelfDisclosure(content)) {
      log.warn(
        { layer, type, preview: content.slice(0, 80) },
        'Self-protection: refused to store memory containing self-disclosure',
      );
      // Return a sentinel so callers don't crash. Non-buffer layers' existing
      // callers either ignore the return value or treat string as the id; the
      // id "__redacted__" won't collide with real nanoid ids.
      return '__redacted__';
    }

    switch (layer) {
      case 'buffer': {
        const message: AIMessage = {
          role:
            (options.metadata?.role as AIMessage['role']) ?? 'user',
          content,
        };
        return this.shortTerm.add(message, options.metadata);
      }

      case 'episodic': {
        const memory = this.episodic.store(content, {
          type,
          summary: options.summary,
          importance: options.importance,
          confidence: options.confidence,
          emotionalValence: options.emotionalValence,
          tags: options.tags,
          source: options.source,
          metadata: options.metadata,
        });
        // Generate and store a semantic embedding async (fire-and-forget — never blocks storage)
        if (this.embeddingProvider && typeof (memory as Memory).id === 'string') {
          this.storeEmbeddingAsync((memory as Memory).id, content);
        }
        return memory;
      }

      case 'semantic': {
        const fact = this.semantic.storeFact({
          category: this.typeToFactCategory(type),
          key:
            (options.metadata?.key as string) ??
            `${type}_${nowISO()}`,
          value: content,
          confidence: options.confidence,
          sourceMemoryId:
            (options.metadata?.sourceMemoryId as string) ?? null,
        });
        return fact;
      }

      case 'procedural': {
        return this.procedural.storeProcedure(
          options.summary ?? content.slice(0, 80),
          content.split('\n').filter(Boolean),
          options.tags?.[0] ?? 'general',
          options.confidence,
        );
      }

      default: {
        log.warn(
          { layer },
          'Unknown memory layer, defaulting to episodic',
        );
        return this.episodic.store(content, { type, ...options });
      }
    }
  }

  // ─── Unified Recall ───────────────────────────────────────────────

  /**
   * Search across memory layers for relevant content.
   * Returns a merged, deduplicated, relevance-sorted list of memories.
   * Uses semantic embeddings when an EmbeddingProvider is wired — falls back
   * to keyword scoring otherwise.
   */
  async recall(query: string, options: RecallOptions = {}): Promise<Memory[]> {
    const limit = options.limit ?? 20;
    const layers = options.layers ?? [
      'buffer',
      'episodic',
      'semantic',
      'procedural',
    ];

    const results: Memory[] = [];

    // Search short-term buffer
    if (layers.includes('buffer')) {
      const bufferResults = this.shortTerm.search(query);
      const bufferMemories: Memory[] = bufferResults.map(
        (entry) => ({
          id: entry.id,
          layer: 'buffer' as const,
          type: 'conversation' as const,
          content: entry.message.content ?? '',
          summary: null,
          importance: 0.5,
          confidence: 1.0,
          emotionalValence: null,
          createdAt: entry.timestamp,
          lastAccessed: entry.timestamp,
          accessCount: 0,
          tags: [entry.message.role],
          relatedMemories: [],
          source: 'buffer',
          metadata: entry.metadata,
        }),
      );
      results.push(...bufferMemories);
    }

    // Search episodic memories
    if (layers.includes('episodic')) {
      const episodicResults = this.episodic.search({
        query,
        types: options.types,
        minImportance: options.minImportance,
        timeRange: options.timeRange,
        tags: options.tags,
        limit: limit * 2,
      });
      results.push(...episodicResults);
    }

    // Search semantic memory (facts) and convert to Memory format
    if (layers.includes('semantic')) {
      const facts = this.semantic.searchFacts(query);
      const factMemories: Memory[] = facts.map((fact) => ({
        id: fact.id,
        layer: 'semantic' as const,
        type: 'fact' as const,
        content: `${fact.key}: ${fact.value}`,
        summary: null,
        importance: fact.confidence,
        confidence: fact.confidence,
        emotionalValence: null,
        createdAt: fact.createdAt,
        lastAccessed: fact.updatedAt,
        accessCount: 0,
        tags: [fact.category],
        relatedMemories: [],
        source: 'semantic',
        metadata: { category: fact.category, key: fact.key },
      }));
      results.push(...factMemories);
    }

    // Search procedural memory
    if (layers.includes('procedural')) {
      const procedures =
        this.procedural.findRelevantProcedures(query);
      results.push(...procedures);
    }

    // ── Semantic embedding scores (async, optional) ───────────────────
    // Fetch stored embeddings for all candidates and compute cosine similarity
    // against the query embedding. Blended into the final score below.
    const embeddingScores = await this.fetchEmbeddingScores(query, results);

    // ── Score and rank all results ────────────────────────────────────
    const queryTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    const scored = results.map((memory) => {
      const contentScore = this.scoreContentMatch(memory, queryTerms);
      const importanceScore = memory.importance;
      const semanticScore = embeddingScores.get(memory.id);

      let base: number;
      if (semanticScore !== undefined) {
        // Semantic score available: weight it highest, keyword and importance supplement
        base = semanticScore * 0.50 + contentScore * 0.25 + importanceScore * 0.25;
      } else {
        // No embedding stored yet: fall back to original keyword + importance blend
        base = contentScore * 0.55 + importanceScore * 0.45;
      }

      // 30-day half-life temporal decay for episodic/buffer memories.
      // Semantic and procedural memories are evergreen — exempt from decay.
      const totalScore =
        memory.layer === 'episodic' || memory.layer === 'buffer'
          ? base * this.temporalDecay(memory)
          : base;

      return { memory, score: totalScore };
    });

    // Deduplicate by ID
    const seen = new Set<string>();
    const deduped = scored.filter((item) => {
      if (seen.has(item.memory.id)) return false;
      seen.add(item.memory.id);
      return true;
    });

    // Sort by score descending and return top-K
    deduped.sort((a, b) => b.score - a.score);
    // L6 on recall (FIND-SEC-07): even though containsSelfDisclosure blocks
    // new self-referential memories at store time, pre-existing rows from
    // before the filter existed can still surface. Scrub recalled content
    // through `redactSelfDisclosure` before it enters LLM context.
    return deduped.slice(0, limit).map((s) => ({
      ...s.memory,
      content: redactSelfDisclosure(s.memory.content),
      summary: s.memory.summary ? redactSelfDisclosure(s.memory.summary) : s.memory.summary,
    }));
  }

  // ─── Context Assembly ─────────────────────────────────────────────

  /**
   * Assemble relevant context for the brain to use in generating a response.
   */
  async getRelevantContext(
    query: string,
    recentMessageCount = 10,
    memoryLimit = 15,
  ): Promise<RelevantContext> {
    const recentMessages =
      this.shortTerm.getMessages(recentMessageCount);

    const relevantMemories = await this.recall(query, {
      layers: ['episodic', 'procedural'],
      limit: memoryLimit,
      minImportance: 0.2,
    });

    const relevantFacts = this.semantic.searchFacts(query, 10);

    const unresolvedMistakes =
      this.procedural.getUnresolvedMistakes();

    return {
      recentMessages,
      relevantMemories,
      relevantFacts,
      unresolvedMistakes,
    };
  }

  // ─── Buffer Convenience ───────────────────────────────────────────

  /**
   * Add a message to the short-term buffer.
   */
  addToBuffer(
    role: AIMessage['role'],
    content: string,
    metadata?: Record<string, unknown>,
  ): BufferEntry {
    return this.shortTerm.add({ role, content }, metadata);
  }

  /**
   * Get recent buffer messages.
   */
  getBufferMessages(count?: number): AIMessage[] {
    return this.shortTerm.getMessages(count);
  }

  // ─── Fact Convenience ─────────────────────────────────────────────

  /**
   * Store a user fact.
   */
  storeFact(
    category: UserFact['category'],
    key: string,
    value: string,
    confidence = 0.8,
  ): UserFact {
    return this.semantic.storeFact({
      category,
      key,
      value,
      confidence,
    });
  }

  /**
   * Get facts relevant to a query.
   */
  getRelevantFacts(query: string, limit = 15): UserFact[] {
    return this.semantic.searchFacts(query, limit);
  }

  // ─── Memory Feedback Loop ─────────────────────────────────────────

  /**
   * Bump access_count and slightly increase importance for a list of
   * memory IDs that were actively used in generating a response.
   * This is the self-organizing importance mechanism — memories that get
   * used repeatedly rise to the surface naturally over time.
   */
  bumpMemoryAccess(ids: string[]): void {
    if (ids.length === 0) return;
    try {
      const db = getDatabase();
      const stmt = db.prepare(
        `UPDATE memories
         SET access_count  = access_count + 1,
             last_accessed = datetime('now'),
             importance    = MIN(1.0, importance + 0.02)
         WHERE id = ?`,
      );
      const bumpAll = db.transaction((idList: string[]) => {
        for (const id of idList) stmt.run(id);
      });
      bumpAll(ids);
      log.debug({ count: ids.length }, 'Memory access bumped');
    } catch (err) {
      log.debug({ err }, 'Memory bump skipped');
    }
  }

  // ─── Consolidation ────────────────────────────────────────────────

  /**
   * Run the dream cycle consolidation process.
   */
  consolidate(): ConsolidationReport {
    return this.consolidation.runConsolidation();
  }

  /**
   * Get memory system statistics.
   */
  getStats(): ConsolidationStats & {
    bufferSize: number;
    bufferFull: boolean;
  } {
    const stats = this.consolidation.getStats();
    return {
      ...stats,
      bufferSize: this.shortTerm.size,
      bufferFull: this.shortTerm.isFull,
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  /**
   * Shut down the memory manager, closing the database.
   */
  shutdown(): void {
    log.info('Shutting down MemoryManager');
    closeDatabase();
    this.initialized = false;
  }

  /**
   * Alias for shutdown (backward compat).
   */
  close(): void {
    this.shutdown();
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  /**
   * Generate an embedding for `text` and persist it to memory_embeddings.
   * Fire-and-forget — never throws, never blocks the caller.
   */
  private storeEmbeddingAsync(memoryId: string, text: string): void {
    if (!this.embeddingProvider) return;
    const provider = this.embeddingProvider;
    const model = this.embeddingModel;

    provider.embed(text).then((vector) => {
      try {
        const db = getDatabase();
        db.prepare(
          `INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding, model, created_at)
           VALUES (?, ?, ?, datetime('now'))`,
        ).run(memoryId, Buffer.from(JSON.stringify(vector)), model);
      } catch (err) {
        log.debug({ err, memoryId }, 'Failed to persist embedding — skipping');
      }
    }).catch((err) => {
      log.debug({ err, memoryId }, 'Embedding generation failed — skipping');
    });
  }

  /**
   * Look up stored embeddings for `candidates`, compute cosine similarity against
   * the query embedding, and return a map of memory_id → normalized score [0,1].
   * Returns an empty map if no embedding provider is configured or on any error.
   */
  private async fetchEmbeddingScores(
    query: string,
    candidates: Memory[],
  ): Promise<Map<string, number>> {
    if (!this.embeddingProvider || candidates.length === 0) return new Map();

    const episodicCandidates = candidates.filter((m) => m.layer === 'episodic');
    if (episodicCandidates.length === 0) return new Map();

    try {
      const db = getDatabase();
      const ids = episodicCandidates.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(',');

      const rows = db
        .prepare(`SELECT memory_id, embedding FROM memory_embeddings WHERE memory_id IN (${placeholders})`)
        .all(...ids) as { memory_id: string; embedding: Buffer }[];

      if (rows.length === 0) return new Map();

      const queryEmbedding = await this.embeddingProvider.embed(query);
      const scores = new Map<string, number>();

      for (const row of rows) {
        try {
          const storedVector: number[] = JSON.parse(row.embedding.toString());
          const sim = cosineSimilarity(queryEmbedding, storedVector);
          // Normalize from [-1, 1] to [0, 1] so it blends cleanly with other 0–1 scores
          scores.set(row.memory_id, (sim + 1) / 2);
        } catch {
          // Malformed embedding — skip this entry
        }
      }

      log.debug(
        { queryLen: query.length, candidates: ids.length, scored: scores.size },
        'Embedding recall scores computed',
      );
      return scores;
    } catch (err) {
      log.debug({ err }, 'Embedding recall failed — falling back to keyword scoring');
      return new Map();
    }
  }

  private typeToFactCategory(
    type: MemoryType,
  ): UserFact['category'] {
    switch (type) {
      case 'preference':
        return 'preference';
      case 'contact':
        return 'contact';
      case 'workflow':
        return 'skill';
      case 'fact':
      case 'opinion':
        return 'fact';
      default:
        return 'fact';
    }
  }

  private scoreContentMatch(
    memory: Memory,
    queryTerms: string[],
  ): number {
    if (queryTerms.length === 0) return 0;

    const text =
      `${memory.content} ${memory.summary ?? ''} ${memory.tags.join(' ')}`.toLowerCase();
    let hits = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) hits++;
    }
    return hits / queryTerms.length;
  }

  /** Phase 3.3: 30-day half-life temporal decay multiplier. */
  private temporalDecay(memory: Memory): number {
    const created =
      typeof memory.createdAt === 'string'
        ? new Date(memory.createdAt).getTime()
        : Date.now();
    // Guard: invalid date → treat as recent (no decay)
    if (Number.isNaN(created)) return 1.0;
    const ageDays = (Date.now() - created) / (1000 * 60 * 60 * 24);
    return Math.exp((-0.693 / 30) * ageDays);
  }
}

// ─── Re-exports ───────────────────────────────────────────────────

export { closeDatabase, getDatabase } from './database.js';
export { ShortTermMemory } from './short-term.js';
export type { BufferEntry } from './short-term.js';
export { EpisodicMemory } from './episodic.js';
export type {
  StoreOptions,
  SearchOptions,
} from './episodic.js';
export { SemanticMemory } from './semantic.js';
export type { StoreFactOptions } from './semantic.js';
export { ProceduralMemory } from './procedural.js';
export { MemoryConsolidation } from './consolidation.js';
export type {
  ConsolidationReport,
  ConsolidationStats,
} from './consolidation.js';
