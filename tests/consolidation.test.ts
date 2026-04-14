import { describe, it, expect } from 'vitest';
import { MemoryConsolidation } from '../src/memory/consolidation.js';

describe('MemoryConsolidation', () => {
  describe('runConsolidation', () => {
    it('should run without throwing', () => {
      const consolidation = new MemoryConsolidation();
      expect(() => consolidation.runConsolidation()).not.toThrow();
    });

    it('should return a report with all required fields', () => {
      const consolidation = new MemoryConsolidation();
      const report = consolidation.runConsolidation();

      expect('summarised' in report).toBe(true);
      expect('factsExtracted' in report).toBe(true);
      expect('importanceAdjusted' in report).toBe(true);
      expect('deduplicated' in report).toBe(true);
      expect('garbageCollected' in report).toBe(true);
      expect('durationMs' in report).toBe(true);
    });

    it('should return non-negative counts', () => {
      const consolidation = new MemoryConsolidation();
      const report = consolidation.runConsolidation();

      expect(report.summarised).toBeGreaterThanOrEqual(0);
      expect(report.factsExtracted).toBeGreaterThanOrEqual(0);
      expect(report.importanceAdjusted).toBeGreaterThanOrEqual(0);
      expect(report.deduplicated).toBeGreaterThanOrEqual(0);
      expect(report.garbageCollected).toBeGreaterThanOrEqual(0);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should complete in a reasonable time (under 5 seconds)', () => {
      const consolidation = new MemoryConsolidation();
      const start = Date.now();
      consolidation.runConsolidation();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(5000);
    });
  });

  describe('getStats', () => {
    it('should return stats without throwing', () => {
      const consolidation = new MemoryConsolidation();
      expect(() => consolidation.getStats()).not.toThrow();
    });

    it('should return stats with all required fields', () => {
      const consolidation = new MemoryConsolidation();
      const stats = consolidation.getStats();

      expect('totalMemories' in stats).toBe(true);
      expect('byLayer' in stats).toBe(true);
      expect('avgImportance' in stats).toBe(true);
      expect('totalFacts' in stats).toBe(true);
      expect('totalMistakes' in stats).toBe(true);
      expect('oldestMemory' in stats).toBe(true);
      expect('newestMemory' in stats).toBe(true);
    });

    it('should return non-negative total', () => {
      const consolidation = new MemoryConsolidation();
      const stats = consolidation.getStats();
      expect(stats.totalMemories).toBeGreaterThanOrEqual(0);
      expect(stats.totalFacts).toBeGreaterThanOrEqual(0);
      expect(stats.totalMistakes).toBeGreaterThanOrEqual(0);
    });

    it('should return avgImportance between 0 and 1 when memories exist', () => {
      const consolidation = new MemoryConsolidation();
      const stats = consolidation.getStats();
      if (stats.totalMemories > 0) {
        expect(stats.avgImportance).toBeGreaterThanOrEqual(0);
        expect(stats.avgImportance).toBeLessThanOrEqual(1);
      }
    });

    it('should have a byLayer object', () => {
      const consolidation = new MemoryConsolidation();
      const stats = consolidation.getStats();
      expect(typeof stats.byLayer).toBe('object');
    });
  });
});
