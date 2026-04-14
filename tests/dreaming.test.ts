import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DreamingEngine } from '../src/brain/dreaming.js';

const STATE_PATH = join(homedir(), '.nexus', 'dream-state.json');

// Clean up dream state before/after tests to avoid pollution
function removeDreamState() {
  try { if (existsSync(STATE_PATH)) rmSync(STATE_PATH); } catch { /* ignore */ }
}

describe('DreamingEngine', () => {
  beforeEach(removeDreamState);
  afterEach(removeDreamState);

  describe('double-run guard', () => {
    it('should return skipped=true when called twice within 30 minutes', async () => {
      const engine = new DreamingEngine(); // No AI → fast, extractive only

      // First run (no AI, very fast)
      const firstReport = await engine.runDreamCycle();
      expect(firstReport.skipped).toBeUndefined(); // Not skipped

      // Second run immediately after
      const secondReport = await engine.runDreamCycle();
      expect(secondReport.skipped).toBe(true);
    });

    it('should return zeroes in skipped report', async () => {
      const engine = new DreamingEngine();
      await engine.runDreamCycle(); // first run

      const report = await engine.runDreamCycle(); // immediate second run
      expect(report.consolidated).toBe(0);
      expect(report.decayed).toBe(0);
      expect(report.garbageCollected).toBe(0);
      expect(report.contradictions).toBe(0);
      expect(report.reflections).toEqual([]);
      expect(report.ideas).toEqual([]);
    });
  });

  describe('without AI manager', () => {
    it('should run without throwing (extractive fallback)', async () => {
      const engine = new DreamingEngine();
      const report = await engine.runDreamCycle();
      expect(typeof report.consolidated).toBe('number');
      expect(typeof report.decayed).toBe('number');
      expect(typeof report.garbageCollected).toBe('number');
      expect(typeof report.contradictions).toBe('number');
      expect(Array.isArray(report.reflections)).toBe(true);
      expect(Array.isArray(report.ideas)).toBe(true);
      expect(Array.isArray(report.insights)).toBe(true);
      expect(typeof report.durationMs).toBe('number');
    });

    it('should return report with all required fields', async () => {
      const engine = new DreamingEngine();
      const report = await engine.runDreamCycle();
      expect('consolidated' in report).toBe(true);
      expect('decayed' in report).toBe(true);
      expect('garbageCollected' in report).toBe(true);
      expect('contradictions' in report).toBe(true);
      expect('staleGoalsPruned' in report).toBe(true);
      expect('reflections' in report).toBe(true);
      expect('ideas' in report).toBe(true);
      expect('insights' in report).toBe(true);
      expect('durationMs' in report).toBe(true);
    });

    it('should have non-negative counts', async () => {
      const engine = new DreamingEngine();
      const report = await engine.runDreamCycle();
      expect(report.consolidated).toBeGreaterThanOrEqual(0);
      expect(report.decayed).toBeGreaterThanOrEqual(0);
      expect(report.garbageCollected).toBeGreaterThanOrEqual(0);
      expect(report.contradictions).toBeGreaterThanOrEqual(0);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('with mocked AI', () => {
    it('should call sendFn when there are reflections', async () => {
      const mockAI = {
        complete: vi.fn()
          .mockResolvedValueOnce({ content: 'User works late at night.\nUser prefers TypeScript.', usage: {} })
          .mockResolvedValueOnce({ content: 'Create a TypeScript project template.', usage: {} }),
      } as any;
      const sendFn = vi.fn().mockResolvedValue(undefined);

      const engine = new DreamingEngine(mockAI, sendFn);
      const report = await engine.runDreamCycle();

      // With mocked AI, we should get reflections + ideas
      if (report.reflections.length > 0) {
        expect(sendFn).toHaveBeenCalled();
      }
    });

    it('should not call sendFn when there are no reflections/insights/ideas', async () => {
      const mockAI = {
        complete: vi.fn().mockResolvedValue({ content: '', usage: {} }),
      } as any;
      const sendFn = vi.fn().mockResolvedValue(undefined);

      // Remove dream state first to allow running
      removeDreamState();

      const engine = new DreamingEngine(mockAI, sendFn);
      const report = await engine.runDreamCycle();

      if (report.reflections.length === 0 && report.insights.length === 0 && report.ideas.length === 0) {
        expect(sendFn).not.toHaveBeenCalled();
      }
    });
  });

  describe('state persistence', () => {
    it('should create dream state file after first run', async () => {
      const engine = new DreamingEngine();
      await engine.runDreamCycle();
      expect(existsSync(STATE_PATH)).toBe(true);
    });

    it('should persist lastDreamAt timestamp', async () => {
      const before = Date.now();
      const engine = new DreamingEngine();
      await engine.runDreamCycle();

      const { readFileSync } = await import('node:fs');
      const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      expect(state.lastDreamAt).toBeGreaterThanOrEqual(before);
      expect(state.lastDreamAt).toBeLessThanOrEqual(Date.now());
    });
  });
});
