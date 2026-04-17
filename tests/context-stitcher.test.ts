import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../src/memory/database.js';
import { storeEmbedding } from '../src/memory/embeddings.js';
import { buildThreadContext, formatAge } from '../src/brain/context-stitcher.js';
import { nanoid } from 'nanoid';

function clearMemories(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM memory_embeddings').run();
  db.prepare('DELETE FROM memories').run();
}

function insertEpisodic(params: {
  content: string;
  type?: string;
  createdAt?: string;
}): string {
  const db = getDatabase();
  const id = nanoid();
  const created = params.createdAt ?? new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO memories (id, layer, type, content, tags, importance, confidence, source, metadata, created_at, last_accessed, access_count)
     VALUES (?, 'episodic', ?, ?, '[]', 0.5, 0.9, 'test', '{}', ?, ?, 0)`,
  ).run(id, params.type ?? 'conversation', params.content, created, created);
  storeEmbedding(id, params.content);
  return id;
}

describe('formatAge', () => {
  it('returns hour/day/week/month forms', () => {
    expect(formatAge(0.5)).toMatch(/1h/);
    expect(formatAge(5)).toBe('5h ago');
    expect(formatAge(24)).toBe('1 day ago');
    expect(formatAge(72)).toBe('3 days ago');
    expect(formatAge(24 * 8)).toBe('1 week ago');
    expect(formatAge(24 * 40)).toBe('1 month ago');
  });
});

describe('buildThreadContext', () => {
  beforeEach(() => clearMemories());

  it('returns null for too-short queries', () => {
    expect(buildThreadContext('hi')).toBeNull();
    expect(buildThreadContext('what?')).toBeNull();
  });

  it('returns null when no matches found', () => {
    insertEpisodic({ content: 'Set up Postgres database migrations with drizzle' });
    const result = buildThreadContext('how do I make a cake from scratch?');
    expect(result).toBeNull();
  });

  it('finds related conversations on the same topic', () => {
    insertEpisodic({
      content: 'Set up Stripe webhook signature validation with raw body middleware for Express',
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const result = buildThreadContext('How do I configure Stripe webhooks?');
    expect(result).not.toBeNull();
    expect(result).toContain('Stripe');
    expect(result).toMatch(/ago/);
  });

  it('formats multiple matches as a list', () => {
    insertEpisodic({
      content: 'Configured the auth middleware using JWT tokens and bcrypt for password hashing',
      createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    insertEpisodic({
      content: 'Debugged auth middleware token expiry bug with JWT refresh tokens',
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const result = buildThreadContext('continuing the auth middleware work on JWT');
    expect(result).not.toBeNull();
    const lines = result!.split('\n');
    expect(lines[0]).toContain('Related prior conversations');
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it('excludes memories from the last hour', () => {
    insertEpisodic({
      content: 'Just now — working on Stripe webhook signature validation',
      createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    });
    const result = buildThreadContext('How do I configure Stripe webhooks?');
    expect(result).toBeNull(); // Recent match filtered out
  });

  it('truncates long content snippets', () => {
    insertEpisodic({
      content: 'Stripe webhook validation ' + 'x'.repeat(500),
    });
    const result = buildThreadContext('How do I configure Stripe webhooks?');
    expect(result).not.toBeNull();
    // Each line (after header) should be bounded
    const lines = result!.split('\n').slice(1);
    for (const l of lines) {
      expect(l.length).toBeLessThan(350);
    }
  });
});
