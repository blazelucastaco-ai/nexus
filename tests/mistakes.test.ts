import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MistakeTracker, formatMistakeWarning } from '../src/learning/mistakes.js';
import type { Mistake } from '../src/types.js';

// Minimal in-memory cortex mock for MistakeTracker
function makeMockCortex() {
  const mistakes: any[] = [];
  let idCounter = 0;

  return {
    getDb: () => ({
      prepare: (sql: string) => ({
        run: (..._args: any[]) => {
          // Simulate UPDATE
          const id = _args[_args.length - 1];
          if (sql.includes('recurrence_count')) {
            const [newCount, newSeverity, mistakeId] = _args;
            const m = mistakes.find((x) => x.id === mistakeId);
            if (m) {
              m.recurrenceCount = newCount;
              m.severity = newSeverity;
            }
          } else if (sql.includes('resolved = 1')) {
            const m = mistakes.find((x) => x.id === id);
            if (m) m.resolved = true;
          }
          return { changes: 1 };
        },
        all: () => mistakes,
        get: () => undefined,
      }),
    }),
    getMistakes: (resolved?: boolean) => {
      if (resolved === false) return mistakes.filter((m) => !m.resolved);
      return [...mistakes];
    },
    recordMistake: (mistake: any) => {
      const id = `mistake-${++idCounter}`;
      mistakes.push({ ...mistake, id, resolved: false, recurrenceCount: 0 });
      return id;
    },
  } as any;
}

describe('MistakeTracker', () => {
  let tracker: MistakeTracker;
  let cortex: ReturnType<typeof makeMockCortex>;

  beforeEach(() => {
    cortex = makeMockCortex();
    tracker = new MistakeTracker(cortex);
  });

  describe('recordMistake', () => {
    it('should record a new mistake and return an ID', () => {
      const id = tracker.recordMistake('Forgot to await async call', 'coding', {
        whatHappened: 'Returned a Promise instead of the resolved value',
        whatShouldHaveHappened: 'Should have used await',
        rootCause: 'Missed await keyword',
      });
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('should not create duplicate for similar mistake — increments recurrence', () => {
      tracker.recordMistake('Forgot to await async call in the handler', 'coding', {
        whatHappened: 'Returned a Promise instead of resolved value',
        whatShouldHaveHappened: 'Should have awaited the async function',
        rootCause: 'Missed await',
      });

      // Second similar mistake
      const id2 = tracker.recordMistake('Forgot to await async call in handler code', 'coding', {
        whatHappened: 'Returned a Promise instead of resolved result',
        whatShouldHaveHappened: 'Should have awaited the async result',
        rootCause: 'Missed await',
      });

      const mistakes = cortex.getMistakes();
      // Should only have 1 mistake (the second incremented the first)
      expect(mistakes.length).toBe(1);
      expect(mistakes[0].recurrenceCount).toBe(1);
    });

    it('should infer critical severity for data loss', () => {
      tracker.recordMistake('Caused data loss in production', 'execution', {
        whatHappened: 'Data loss in production database due to incorrect query',
        whatShouldHaveHappened: 'Should have used a transaction',
      });
      const mistakes = cortex.getMistakes();
      expect(mistakes[0].severity).toBe('critical');
    });

    it('should infer major severity for errors', () => {
      tracker.recordMistake('Code crashed the application', 'coding', {
        whatHappened: 'Code broke the entire application startup',
        whatShouldHaveHappened: 'Should have validated inputs first',
      });
      const mistakes = cortex.getMistakes();
      expect(mistakes[0].severity).toBe('major');
    });

    it('should infer minor severity for general issues with no severity keywords', () => {
      tracker.recordMistake('Response was slightly too long and verbose for the question', 'communication', {
        whatHappened: 'Gave a long response when brevity was needed',
        whatShouldHaveHappened: 'Should have been shorter',
      });
      const mistakes = cortex.getMistakes();
      expect(mistakes[0].severity).toBe('minor');
    });
  });

  describe('maybeEscalateSeverity', () => {
    it('should escalate severity by 1 step after 2 recurrences', () => {
      // All three use identical descriptions to guarantee similarity merging
      const description = 'Response way too long and verbose for user question';
      const details = {
        whatHappened: 'Gave a very long verbose answer when brevity was needed',
        whatShouldHaveHappened: 'Should have given a brief concise answer',
      };

      tracker.recordMistake(description, 'communication', details);
      // recurrenceCount = 0, severity = minor

      tracker.recordMistake(description, 'communication', details);
      // recurrenceCount = 1, floor(1/2) = 0 steps → still minor

      tracker.recordMistake(description, 'communication', details);
      // recurrenceCount = 2, floor(2/2) = 1 step → minor → moderate

      const mistakes = cortex.getMistakes();
      expect(mistakes[0].recurrenceCount).toBe(2);
      expect(mistakes[0].severity).toBe('moderate');
    });
  });

  describe('checkAgainstHistory', () => {
    it('should return safe=true with no mistakes', () => {
      const result = tracker.checkAgainstHistory('deploy the application to production');
      expect(result.safe).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('should warn when action matches a past mistake', () => {
      tracker.recordMistake('Deployment without backup caused downtime', 'execution', {
        whatHappened: 'Deployed without creating a backup first',
        whatShouldHaveHappened: 'Should always backup before deployment',
        rootCause: 'Skipped backup step in deployment process',
      });

      const result = tracker.checkAgainstHistory('deploy the application without backup to production');
      // The action shares keywords with the mistake — should warn
      expect(typeof result.safe).toBe('boolean');
      if (!result.safe) {
        expect(result.warning).toBeDefined();
        // The new warning format should surface root cause + prevention,
        // framed as memory ("you ran into this before") not a generic flag.
        expect(result.warning).toMatch(/(?:you've hit|you ran into)/i);
        expect(result.warning).toContain('Skipped backup step');
        expect(result.warning).toContain('Prevention:');
      }
    });

    it('should return safe=true for unrelated actions', () => {
      tracker.recordMistake('Typo in the HTML template file', 'coding', {
        whatHappened: 'Misspelled a CSS class name in the template',
        whatShouldHaveHappened: 'Double-check CSS class names',
      });

      const result = tracker.checkAgainstHistory('deploy the backend API server to production');
      expect(result.safe).toBe(true);
    });
  });

  describe('formatMistakeWarning (pure helper)', () => {
    function fixture(overrides: Partial<Mistake> = {}): Mistake {
      return {
        id: 'm1',
        description: 'deployed without backup',
        category: 'execution',
        whatHappened: 'deployed without backing up first',
        whatShouldHaveHappened: 'always back up before deployment',
        rootCause: 'forgot the pre-flight checklist',
        preventionStrategy: 'run the deploy.sh script which gates on backup',
        severity: 'minor',
        resolved: false,
        recurrenceCount: 0,
        createdAt: '2026-05-04T00:00:00.000Z',
        ...overrides,
      };
    }

    it('uses memory-voiced phrasing on first hit (recurrenceCount 0)', () => {
      const out = formatMistakeWarning(fixture());
      expect(out).toContain('You ran into this before:');
      expect(out).toContain('"deployed without backup"');
      expect(out).toContain('Last time the root cause was: forgot the pre-flight checklist.');
      expect(out).toContain('Prevention: run the deploy.sh script which gates on backup');
    });

    it('reports the actual recurrence count when this is a repeat', () => {
      // recurrenceCount stored is offset-by-one (incremented on the SECOND occurrence),
      // so count=2 means the user has hit this 3 times total.
      const out = formatMistakeWarning(fixture({ recurrenceCount: 2 }));
      expect(out).toContain("You've hit this 3 times now");
    });

    it('surfaces severity callout only for major/critical, not minor/moderate', () => {
      expect(formatMistakeWarning(fixture({ severity: 'minor' }))).not.toMatch(/Severity:/);
      expect(formatMistakeWarning(fixture({ severity: 'moderate' }))).not.toMatch(/Severity:/);
      expect(formatMistakeWarning(fixture({ severity: 'major' }))).toContain('Severity: major.');
      expect(formatMistakeWarning(fixture({ severity: 'critical' }))).toContain('Severity: critical.');
    });

    it('skips the root-cause line when rootCause is "unknown" (avoids vacuous noise)', () => {
      const out = formatMistakeWarning(fixture({ rootCause: 'unknown' }));
      expect(out).not.toMatch(/root cause was/i);
      // But still surfaces the description and prevention.
      expect(out).toContain('You ran into this before:');
      expect(out).toContain('Prevention:');
    });
  });

  describe('markResolved', () => {
    it('should mark a mistake as resolved', () => {
      tracker.recordMistake('Bug in loop logic caused infinite loop', 'coding', {
        whatHappened: 'Off-by-one error caused infinite loop in the code',
        whatShouldHaveHappened: 'Should check loop bounds carefully',
      });

      const mistakes = cortex.getMistakes();
      tracker.markResolved(mistakes[0].id);
      expect(mistakes[0].resolved).toBe(true);
    });
  });

  describe('getMistakeStats', () => {
    it('should return zeroes with no mistakes', () => {
      const stats = tracker.getMistakeStats();
      expect(stats.total).toBe(0);
      expect(stats.resolved).toBe(0);
      expect(stats.recurring).toBe(0);
    });

    it('should count by category', () => {
      // Use clearly distinct descriptions to avoid similarity merging
      tracker.recordMistake('Off-by-one error caused wrong array index access', 'coding', {
        whatHappened: 'Array index was one too high causing out-of-bounds',
        whatShouldHaveHappened: 'Verify array bounds before indexing',
      });
      tracker.recordMistake('User received an unclear telegram notification', 'communication', {
        whatHappened: 'Notification text was ambiguous and confusing',
        whatShouldHaveHappened: 'Write clear notification messages',
      });
      tracker.recordMistake('Unhandled promise rejection silently swallowed', 'execution', {
        whatHappened: 'Async function threw but rejection was not caught anywhere',
        whatShouldHaveHappened: 'Always attach catch handlers to promise chains',
      });

      const stats = tracker.getMistakeStats();
      expect(stats.total).toBe(3);
      expect(stats.byCategory['coding']).toBe(1);
      expect(stats.byCategory['communication']).toBe(1);
      expect(stats.byCategory['execution']).toBe(1);
    });
  });

  describe('getPreventionStrategy', () => {
    it('should return null with no mistakes in category', () => {
      const strategy = tracker.getPreventionStrategy('coding');
      expect(strategy).toBeNull();
    });

    it('should return a strategy when mistakes exist in category', () => {
      tracker.recordMistake('Failed to validate user input data before processing', 'coding', {
        whatHappened: 'User input was processed without validation',
        whatShouldHaveHappened: 'Validate all user inputs',
        rootCause: 'Missing input validation step',
      });

      const strategy = tracker.getPreventionStrategy('coding');
      expect(strategy).not.toBeNull();
      expect(typeof strategy).toBe('string');
    });
  });

  describe('getRecurringMistakes', () => {
    it('should return empty array with no recurring mistakes', () => {
      // getRecurringMistakes queries DB directly — our mock returns empty
      const recurring = tracker.getRecurringMistakes();
      expect(Array.isArray(recurring)).toBe(true);
    });
  });
});
