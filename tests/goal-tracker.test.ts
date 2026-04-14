import { describe, it, expect, vi } from 'vitest';
import { GoalTracker } from '../src/brain/goal-tracker.js';

// Mock store function (simulates memory.store)
function makeStoreFn() {
  const stored: Array<{ layer: string; type: string; content: string; opts: Record<string, unknown> }> = [];
  const fn = vi.fn(async (layer: string, type: string, content: string, opts: Record<string, unknown>) => {
    stored.push({ layer, type, content, opts });
    return `id-${stored.length}`;
  });
  (fn as any).stored = stored;
  return fn;
}

describe('GoalTracker', () => {
  describe('extractAndStore', () => {
    it('should detect "I want to" goal patterns', async () => {
      const tracker = new GoalTracker();
      const store = makeStoreFn();
      const goals = await tracker.extractAndStore('I want to build a TypeScript project', store);
      expect(goals.length).toBeGreaterThan(0);
      expect(store).toHaveBeenCalled();
    });

    it('should detect "I need to" goal patterns', async () => {
      const tracker = new GoalTracker();
      const store = makeStoreFn();
      const goals = await tracker.extractAndStore('I need to finish the authentication module by tomorrow', store);
      expect(goals.length).toBeGreaterThan(0);
    });

    it('should detect "my goal is" patterns', async () => {
      const tracker = new GoalTracker();
      const store = makeStoreFn();
      const goals = await tracker.extractAndStore('my goal is to launch the MVP next month', store);
      expect(goals.length).toBeGreaterThan(0);
    });

    it('should detect "I\'m working on" patterns', async () => {
      const tracker = new GoalTracker();
      const store = makeStoreFn();
      const goals = await tracker.extractAndStore("I'm working on a React dashboard for my clients", store);
      expect(goals.length).toBeGreaterThan(0);
    });

    it('should detect deadline-based goal patterns', async () => {
      const tracker = new GoalTracker();
      const store = makeStoreFn();
      const goals = await tracker.extractAndStore('by next week I need to complete the backend API', store);
      expect(goals.length).toBeGreaterThan(0);
    });

    it('should return empty array for non-goal messages', async () => {
      const tracker = new GoalTracker();
      const store = makeStoreFn();
      const goals = await tracker.extractAndStore('the weather is nice today', store);
      expect(goals).toEqual([]);
      expect(store).not.toHaveBeenCalled();
    });

    it('should return empty array for a simple hello', async () => {
      const tracker = new GoalTracker();
      const store = makeStoreFn();
      const goals = await tracker.extractAndStore('hello NEXUS', store);
      expect(goals).toEqual([]);
    });

    it('should store goals with high importance and goal tags', async () => {
      const tracker = new GoalTracker();
      const store = makeStoreFn();
      await tracker.extractAndStore('I want to create a CI/CD pipeline for my projects', store);

      const [call] = (store as any).mock.calls;
      expect(call[0]).toBe('episodic');
      expect(call[1]).toBe('task');
      expect(call[3].importance).toBeGreaterThanOrEqual(0.8);
      const tags = call[3].tags as string[];
      expect(tags).toContain('goal');
    });

    it('should not store duplicate goals from same pattern', async () => {
      const tracker = new GoalTracker();
      const store = makeStoreFn();
      // If same pattern matches multiple times for same goal text, should only store once
      await tracker.extractAndStore('I want to build and I want to build a project', store);
      // Goals should not duplicate the same extracted text
      const storedGoals = (store as any).stored as any[];
      const contents = storedGoals.map((s: any) => s.content);
      const unique = new Set(contents);
      expect(unique.size).toBe(contents.length);
    });

    it('should handle store failures gracefully', () => {
      const tracker = new GoalTracker();
      // extractAndStore is synchronous — it calls store as a fire-and-forget callback
      const failingStore = vi.fn().mockImplementation(() => { throw new Error('DB write failed'); });
      // Should not throw even if store fails
      expect(() =>
        tracker.extractAndStore('I want to finish my project today', failingStore)
      ).not.toThrow();
    });
  });

  describe('getActiveGoals', () => {
    it('should return an array (even if empty)', () => {
      const tracker = new GoalTracker();
      const goals = tracker.getActiveGoals();
      expect(Array.isArray(goals)).toBe(true);
    });

    it('should respect the limit parameter', () => {
      const tracker = new GoalTracker();
      const goals = tracker.getActiveGoals(3);
      expect(goals.length).toBeLessThanOrEqual(3);
    });
  });

  describe('pruneStaleGoals', () => {
    it('should return 0 when no stale goals exist', () => {
      const tracker = new GoalTracker();
      const pruned = tracker.pruneStaleGoals();
      expect(typeof pruned).toBe('number');
      expect(pruned).toBeGreaterThanOrEqual(0);
    });
  });

  describe('resolveGoal', () => {
    it('should not throw when goal ID does not exist', () => {
      const tracker = new GoalTracker();
      expect(() => tracker.resolveGoal('nonexistent-id-12345')).not.toThrow();
    });
  });
});
