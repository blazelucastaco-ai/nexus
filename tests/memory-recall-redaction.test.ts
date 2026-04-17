import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryManager } from '../src/memory/index.js';
import { getDatabase } from '../src/memory/database.js';

/**
 * FIND-SEC-07 / FQ-B4: MemoryManager.recall() now passes recalled content
 * through redactSelfDisclosure before returning. This catches the case where
 * a pre-filter memory containing a NEXUS source path has been stored and can
 * now surface into LLM context.
 */

describe('MemoryManager.recall redacts self-disclosure (FIND-SEC-07)', () => {
  let memory: MemoryManager;

  beforeEach(() => {
    memory = new MemoryManager();
    const db = getDatabase();
    db.prepare("DELETE FROM memories WHERE tags LIKE '%recall-redaction-test%'").run();
  });

  it('scrubs NEXUS source paths out of recalled content', async () => {
    // Insert a memory that mentions a NEXUS source path. We bypass the L6
    // store filter by using the raw better-sqlite3 handle directly to
    // simulate a pre-filter row.
    const db = getDatabase();
    db.prepare(
      `INSERT INTO memories (
         id, layer, type, content, tags, importance, confidence, source, metadata, created_at, last_accessed, access_count
       ) VALUES (
         'recall-redact-1', 'episodic', 'fact',
         'I fixed a bug in /Users/lucas/nexus/src/core/orchestrator.ts line 600',
         '["recall-redaction-test"]', 0.8, 0.9, 'test', '{}',
         datetime('now'), datetime('now'), 0
       )`,
    ).run();

    const results = await memory.recall('orchestrator bug fix');
    const hit = results.find((r) => r.id === 'recall-redact-1');
    if (hit) {
      // Must NOT contain the literal source path
      expect(hit.content).not.toContain('/nexus/src/core/orchestrator.ts');
      expect(hit.content).toContain('[redacted]');
    }
  });

  it('leaves benign content untouched', async () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO memories (
         id, layer, type, content, tags, importance, confidence, source, metadata, created_at, last_accessed, access_count
       ) VALUES (
         'recall-redact-2', 'episodic', 'fact',
         'User wants to build a React app in ~/nexus-workspace/myapp',
         '["recall-redaction-test"]', 0.8, 0.9, 'test', '{}',
         datetime('now'), datetime('now'), 0
       )`,
    ).run();

    const results = await memory.recall('react app workspace');
    const hit = results.find((r) => r.id === 'recall-redact-2');
    if (hit) {
      // User-project paths should pass through untouched
      expect(hit.content).toContain('nexus-workspace/myapp');
    }
  });
});
