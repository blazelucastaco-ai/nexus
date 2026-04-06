import OpenAI from "openai";

export type EmbeddingProviderType = "openai" | "ollama" | "local";

export interface EmbeddingConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
}

/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1 (1 = identical direction).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

export class EmbeddingProvider {
  private providerType: EmbeddingProviderType;
  private config: EmbeddingConfig;
  private openaiClient?: OpenAI;

  constructor(providerType: EmbeddingProviderType, config: EmbeddingConfig = {}) {
    this.providerType = providerType;
    this.config = config;

    if (providerType === "openai") {
      if (!config.apiKey) {
        throw new Error("OpenAI embedding provider requires an apiKey");
      }
      this.openaiClient = new OpenAI({ apiKey: config.apiKey });
    }
  }

  async embed(text: string): Promise<number[]> {
    switch (this.providerType) {
      case "openai":
        return this.embedOpenAI(text);
      case "ollama":
        return this.embedOllama(text);
      case "local":
        return this.embedLocal(text);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    switch (this.providerType) {
      case "openai":
        return this.embedBatchOpenAI(texts);
      case "ollama":
        return this.embedBatchOllama(texts);
      case "local":
        return texts.map((t) => this.embedLocalSync(t));
    }
  }

  cosineSimilarity(a: number[], b: number[]): number {
    return cosineSimilarity(a, b);
  }

  // --- OpenAI ---

  private async embedOpenAI(text: string): Promise<number[]> {
    const result = await this.openaiClient!.embeddings.create({
      model: this.config.model ?? "text-embedding-3-small",
      input: text,
      ...(this.config.dimensions ? { dimensions: this.config.dimensions } : {}),
    });

    return result.data[0].embedding;
  }

  private async embedBatchOpenAI(texts: string[]): Promise<number[][]> {
    // OpenAI supports batch input natively (up to 2048 items)
    const batchSize = 2048;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      const result = await this.openaiClient!.embeddings.create({
        model: this.config.model ?? "text-embedding-3-small",
        input: batch,
        ...(this.config.dimensions ? { dimensions: this.config.dimensions } : {}),
      });

      // Sort by index to ensure order matches input
      const sorted = result.data.sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        allEmbeddings.push(item.embedding);
      }
    }

    return allEmbeddings;
  }

  // --- Ollama ---

  private async embedOllama(text: string): Promise<number[]> {
    const baseUrl = (this.config.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    const model = this.config.model ?? "nomic-embed-text";

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`Ollama embed error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { embeddings: number[][] };
    return data.embeddings[0];
  }

  private async embedBatchOllama(texts: string[]): Promise<number[][]> {
    const baseUrl = (this.config.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    const model = this.config.model ?? "nomic-embed-text";

    // Ollama /api/embed supports array input
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`Ollama embed error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { embeddings: number[][] };
    return data.embeddings;
  }

  // --- Local TF-IDF with hashing trick ---

  private static readonly HASH_DIMENSIONS = 384;

  private embedLocalSync(text: string): number[] {
    const dims = this.config.dimensions ?? EmbeddingProvider.HASH_DIMENSIONS;
    const vector = new Float64Array(dims);

    const tokens = this.tokenize(text);
    if (tokens.length === 0) return Array.from(vector);

    // Term frequency
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    // Hashing trick: map each token to a bucket and accumulate TF weight
    for (const [token, count] of tf) {
      const hash = this.hashString(token);
      const bucket = Math.abs(hash) % dims;
      // Use sign of a second hash to reduce collisions
      const sign = this.hashString(`${token}_salt`) % 2 === 0 ? 1 : -1;
      vector[bucket] += sign * (count / tokens.length);
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < dims; i++) {
      norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);

    if (norm > 0) {
      for (let i = 0; i < dims; i++) {
        vector[i] /= norm;
      }
    }

    return Array.from(vector);
  }

  private async embedLocal(text: string): Promise<number[]> {
    return this.embedLocalSync(text);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }

  /**
   * FNV-1a 32-bit hash for deterministic bucket assignment.
   */
  private hashString(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) | 0;
    }
    return hash;
  }
}
