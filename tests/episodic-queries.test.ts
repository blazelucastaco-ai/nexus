import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../src/memory/database.js';
import {
  countRecentTaskFailures,
  listActiveGoalContents,
  listStaleGoalCandidates,
  getMemoryTags,
  updateMemoryTags,
  listRecentDreamIdeas,
  getLatestDreamJournal,
  listRecentSessionSummaries,
  countByTag,
} from '../src/data/episodic-queries.js';
import { nanoid } from 'nanoid';

function clearMemories(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM memories').run();
}

function insertMemory(row: {
  id?: string;
  layer?: string;
  type?: string;
  content: string;
  tags?: string;
  importance?: number;
  created_at?: string;
  source?: string;
}): string {
  const db = getDatabase();
  const id = row.id ?? nanoid();
  const created = row.created_at ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (id, layer, type, content, tags, importance, confidence, source, metadata, created_at, last_accessed, access_count)
     VALUES (?, ?, ?, ?, ?, ?, 0.8, ?, '{}', ?, ?, 0)`,
  ).run(
    id,
    row.layer ?? 'episodic',
    row.type ?? 'fact',
    row.content,
    row.tags ?? '[]',
    row.importance ?? 0.5,
    row.source ?? 'test',
    created,
    created,
  );
  return id;
}

describe('EpisodicQueryRepo', () => {
  beforeEach(() => {
    clearMemories();
  });

  describe('countRecentTaskFailures', () => {
    it('returns 0 when no failures', () => {
      const result = countRecentTaskFailures(60 * 60 * 1000);
      expect(result.count).toBe(0);
      expect(result.titles).toEqual([]);
    });

    it('counts failures within the window', () => {
      const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
      insertMemory({ type: 'task', tags: '["task","failure"]', content: 'Task: Deploy API\nResult: failed', created_at: recent });
      insertMemory({ type: 'task', tags: '["task","failure"]', content: 'Task: Run migration\nResult: failed', created_at: recent });

      const result = countRecentTaskFailures(60 * 60 * 1000); // 1 hour window
      expect(result.count).toBe(2);
      expect(result.titles).toContain('Deploy API');
      expect(result.titles).toContain('Run migration');
    });

    it('excludes failures outside the window', () => {
      const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
      insertMemory({ type: 'task', tags: '["task","failure"]', content: 'Task: Old deploy\nResult: failed', created_at: old });

      const result = countRecentTaskFailures(60 * 60 * 1000); // 1 hour window
      expect(result.count).toBe(0);
    });
  });

  describe('listActiveGoalContents', () => {
    it('returns only goals tagged active', () => {
      insertMemory({ tags: '["goal","active"]', content: 'Ship feature X' });
      insertMemory({ tags: '["goal","resolved"]', content: 'Old completed goal' });
      insertMemory({ tags: '["note"]', content: 'Unrelated memory' });

      const goals = listActiveGoalContents(10);
      expect(goals).toHaveLength(1);
      expect(goals[0]).toBe('Ship feature X');
    });
  });

  describe('listStaleGoalCandidates', () => {
    it('returns active goals older than cutoff', () => {
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date().toISOString();

      insertMemory({ tags: '["goal","active"]', content: 'Old goal', created_at: old });
      insertMemory({ tags: '["goal","active"]', content: 'New goal', created_at: recent });

      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const stale = listStaleGoalCandidates(cutoff);
      expect(stale).toHaveLength(1);
      expect(stale[0]?.content).toBe('Old goal');
    });
  });

  describe('getMemoryTags / updateMemoryTags', () => {
    it('reads and writes tags round-trip', () => {
      const id = insertMemory({ content: 'test', tags: '["a","b"]' });

      const got = getMemoryTags(id);
      expect(got).toBe('["a","b"]');

      const ok = updateMemoryTags(id, '["a","c"]');
      expect(ok).toBe(true);

      expect(getMemoryTags(id)).toBe('["a","c"]');
    });

    it('returns null for unknown id', () => {
      expect(getMemoryTags('does-not-exist')).toBeNull();
    });

    it('updateMemoryTags returns false for unknown id', () => {
      expect(updateMemoryTags('does-not-exist', '[]')).toBe(false);
    });
  });

  describe('listRecentDreamIdeas', () => {
    it('returns dream ideas tagged appropriately within window', () => {
      insertMemory({ tags: '["dream-idea"]', content: 'Try Vite for hot reload' });
      insertMemory({ tags: '["dream-idea"]', content: 'Refactor auth module' });
      insertMemory({ tags: '["fact"]', content: 'Unrelated fact' });

      const ideas = listRecentDreamIdeas(5, 2);
      expect(ideas).toHaveLength(2);
      expect(ideas.map((i) => i.content)).toContain('Try Vite for hot reload');
    });

    it('respects the limit', () => {
      insertMemory({ tags: '["dream-idea"]', content: 'A' });
      insertMemory({ tags: '["dream-idea"]', content: 'B' });
      insertMemory({ tags: '["dream-idea"]', content: 'C' });

      const ideas = listRecentDreamIdeas(2, 2);
      expect(ideas).toHaveLength(2);
    });
  });

  describe('getLatestDreamJournal', () => {
    it('returns null when no journal', () => {
      expect(getLatestDreamJournal()).toBeNull();
    });

    it('returns the most recent semantic dream journal', () => {
      const old = new Date(Date.now() - 60 * 1000).toISOString();
      const recent = new Date().toISOString();
      insertMemory({ layer: 'semantic', tags: '["dream-journal"]', content: 'Old journal', created_at: old });
      insertMemory({ layer: 'semantic', tags: '["dream-journal"]', content: 'New journal', created_at: recent });

      const row = getLatestDreamJournal();
      expect(row?.content).toBe('New journal');
    });
  });

  describe('listRecentSessionSummaries', () => {
    it('returns recent session/task rows', () => {
      insertMemory({ tags: '["session-summary"]', content: 'Session summary 1' });
      insertMemory({ tags: '["task","success"]', content: 'Task: x' });
      insertMemory({ tags: '["note"]', content: 'Unrelated' });

      const rows = listRecentSessionSummaries(10);
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('countByTag', () => {
    it('counts memories matching a tag', () => {
      insertMemory({ tags: '["frustration"]', content: 'ugh' });
      insertMemory({ tags: '["frustration"]', content: 'argh' });
      insertMemory({ tags: '["happy"]', content: 'yay' });

      expect(countByTag('frustration')).toBe(2);
      expect(countByTag('happy')).toBe(1);
      expect(countByTag('nonexistent')).toBe(0);
    });

    it('respects sinceISO filter', () => {
      const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date().toISOString();
      insertMemory({ tags: '["x"]', content: 'old', created_at: old });
      insertMemory({ tags: '["x"]', content: 'new', created_at: recent });

      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      expect(countByTag('x', since)).toBe(1);
    });
  });
});
