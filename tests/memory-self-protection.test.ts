import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryManager } from '../src/memory/index.js';
import { getDatabase } from '../src/memory/database.js';

// Verifies that the L6 self-protection filter in MemoryManager.store prevents
// source-code disclosures from landing in the memory DB (where they could
// later be recalled and surfaced back to the user).

describe('MemoryManager self-protection (L6)', () => {
  let memory: MemoryManager;

  beforeEach(() => {
    memory = new MemoryManager();
    // Clear only the rows this test file creates, via a known tag.
    const db = getDatabase();
    db.prepare("DELETE FROM memories WHERE tags LIKE '%self-protection-test%'").run();
  });

  it('refuses to store content containing NEXUS source paths', () => {
    const result = memory.store(
      'episodic',
      'conversation',
      'Found the bug in /Users/lucas/nexus/src/core/orchestrator.ts line 600',
      { tags: ['self-protection-test'] },
    );
    expect(result).toBe('__redacted__');
  });

  it('refuses to store content with NEXUS class declarations', () => {
    const result = memory.store(
      'episodic',
      'fact',
      'export class Orchestrator { public memory: MemoryManager }',
      { tags: ['self-protection-test'] },
    );
    expect(result).toBe('__redacted__');
  });

  it('refuses to store content referencing ~/nexus/src/', () => {
    const result = memory.store(
      'semantic',
      'fact',
      "The introspection module lives at ~/nexus/src/brain/introspection.ts",
      { tags: ['self-protection-test'] },
    );
    expect(result).toBe('__redacted__');
  });

  it('allows normal user-project content through', () => {
    const result = memory.store(
      'episodic',
      'conversation',
      'User wants to build a React app in ~/nexus-workspace/my-app',
      { tags: ['self-protection-test'] },
    );
    // Should NOT be redacted — returns the actual memory object, not '__redacted__'.
    expect(result).not.toBe('__redacted__');
  });

  it('allows buffer-layer storage (short-term) through unchanged', () => {
    // Buffer is the short-term raw message log. We don't filter there —
    // users may mention paths, and filtering would drop their raw utterance.
    // Downstream consolidation applies the filter when promoting to episodic.
    const result = memory.store(
      'buffer',
      'conversation',
      "I'm looking at /Users/lucas/nexus/src/core/orchestrator.ts",
      { tags: ['self-protection-test'], metadata: { role: 'user' } },
    );
    expect(result).not.toBe('__redacted__');
  });
});
