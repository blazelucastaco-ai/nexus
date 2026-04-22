#!/usr/bin/env tsx
// Memory-import runner — called by the installer app (and anywhere else that
// needs a one-shot import without the interactive CLI prompts).
//
// Input: __NEXUS_IMPORT_SOURCES__=id1,id2,... (env var, comma-separated)
// Output: JSON ImportResult on stdout.

import 'dotenv/config';
import {
  detectAllSources,
  gatherRaw,
  synthesizeWithLLM,
  writeSkills,
  importMemories,
} from '../src/memory/import.js';
import { getDatabase } from '../src/memory/database.js';
import { AIManager } from '../src/ai/index.js';

/**
 * Emit a progress event. The installer-app parent process reads these line by
 * line off stdout and forwards them to the wizard renderer.
 */
function emit(event: {
  type: 'phase';
  phase: string;
  label: string;
  pct: number;
  source?: string;
}): void {
  console.log(JSON.stringify(event));
}

async function main(): Promise<void> {
  const raw = process.env.__NEXUS_IMPORT_SOURCES__ ?? '';
  const selected = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  const empty = {
    imported: 0, skipped: 0, skillsWritten: 0, sources: {},
    llmUsed: false, alreadyImported: [] as string[],
  };
  if (selected.size === 0) { console.log(JSON.stringify({ type: 'done', result: empty })); return; }

  emit({ type: 'phase', phase: 'detecting', label: 'Scanning for agents…', pct: 5 });
  const sources = (await detectAllSources()).filter(
    (s) => s.status === 'ready' && selected.has(s.id),
  );
  if (sources.length === 0) { console.log(JSON.stringify({ type: 'done', result: empty })); return; }

  // Open the DB first so we can check what's already imported per source —
  // that lets us short-circuit and avoid spending LLM tokens on a no-op.
  const db = getDatabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const countStmt = (db as any).prepare(
    "SELECT COUNT(*) as count FROM memories WHERE source = ?",
  );

  const ai = new AIManager('anthropic');
  const allMemories = [];
  const allSkills = [];
  let llmUsed = false;
  const alreadyImported: string[] = [];

  // Partition sources into fresh vs already-imported up front.
  const freshSources: typeof sources = [];
  for (const s of sources) {
    const existing = (countStmt.get(`imported-${s.id}`) as { count: number }).count;
    if (existing > 0) {
      alreadyImported.push(s.name);
      emit({
        type: 'phase',
        phase: 'already-imported',
        label: `${s.name}: already merged (${existing} memor${existing === 1 ? 'y' : 'ies'})`,
        pct: 10,
        source: s.name,
      });
    } else {
      freshSources.push(s);
    }
  }

  // Budget the 15-90% range across the fresh-source loop.
  const perSource = freshSources.length > 0 ? 75 / freshSources.length : 0;

  for (let i = 0; i < freshSources.length; i++) {
    const source = freshSources[i]!;
    const base = 15 + i * perSource;

    emit({
      type: 'phase', phase: 'reading',
      label: `Reading ${source.name}…`,
      pct: Math.round(base),
      source: source.name,
    });
    const bundle = gatherRaw(source);
    if (!bundle) continue;

    emit({
      type: 'phase', phase: 'synthesizing',
      label: `${source.name} → Claude is reading and writing NEXUS's memory…`,
      pct: Math.round(base + perSource * 0.15),
      source: source.name,
    });
    const { memories, skills } = await synthesizeWithLLM(bundle, ai);
    allMemories.push(...memories);
    allSkills.push(...skills);
    if (memories.some((m) => (m.metadata as Record<string, unknown>).synthesizedBy === 'llm')) {
      llmUsed = true;
    }

    emit({
      type: 'phase', phase: 'source-done',
      label: `${source.name}: ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'} · ${skills.length} skill${skills.length === 1 ? '' : 's'}`,
      pct: Math.round(base + perSource),
      source: source.name,
    });
  }

  emit({ type: 'phase', phase: 'persisting', label: 'Writing memories to SQLite…', pct: 92 });
  const result = await importMemories(allMemories, db);

  emit({ type: 'phase', phase: 'skills', label: `Writing ${allSkills.length} skill file${allSkills.length === 1 ? '' : 's'}…`, pct: 97 });
  const skillsWritten = writeSkills(allSkills);

  emit({ type: 'phase', phase: 'done', label: 'Complete.', pct: 100 });
  console.log(JSON.stringify({
    type: 'done',
    result: { ...result, skillsWritten, llmUsed, alreadyImported },
  }));
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
