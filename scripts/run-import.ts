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

async function main(): Promise<void> {
  const raw = process.env.__NEXUS_IMPORT_SOURCES__ ?? '';
  const selected = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  const empty = { imported: 0, skipped: 0, skillsWritten: 0, sources: {}, llmUsed: false };
  if (selected.size === 0) { console.log(JSON.stringify(empty)); return; }

  const sources = (await detectAllSources()).filter(
    (s) => s.status === 'ready' && selected.has(s.id),
  );
  if (sources.length === 0) { console.log(JSON.stringify(empty)); return; }

  const ai = new AIManager('anthropic');
  const allMemories = [];
  const allSkills = [];
  let llmUsed = false;

  for (const source of sources) {
    const bundle = gatherRaw(source);
    if (!bundle) continue;
    const { memories, skills } = await synthesizeWithLLM(bundle, ai);
    allMemories.push(...memories);
    allSkills.push(...skills);
    // If any memory has metadata.synthesizedBy === 'llm', we used the LLM.
    if (memories.some((m) => (m.metadata as Record<string, unknown>).synthesizedBy === 'llm')) {
      llmUsed = true;
    }
  }

  const db = getDatabase();
  const result = await importMemories(allMemories, db);
  const skillsWritten = writeSkills(allSkills);
  console.log(JSON.stringify({ ...result, skillsWritten, llmUsed }));
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
