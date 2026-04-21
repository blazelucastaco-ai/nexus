#!/usr/bin/env tsx
// Memory-import runner — called by the installer app (and anywhere else that
// needs a one-shot import without the interactive CLI prompts).
//
// Input: __NEXUS_IMPORT_SOURCES__=id1,id2,... (env var, comma-separated)
// Output: JSON ImportResult on stdout.

import 'dotenv/config';
import { detectAllSources, extractMemories, importMemories } from '../src/memory/import.js';
import { getDatabase } from '../src/memory/database.js';

async function main(): Promise<void> {
  const raw = process.env.__NEXUS_IMPORT_SOURCES__ ?? '';
  const selected = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  if (selected.size === 0) {
    console.log(JSON.stringify({ imported: 0, skipped: 0, sources: {} }));
    return;
  }
  const sources = (await detectAllSources()).filter(
    (s) => s.status === 'ready' && selected.has(s.id),
  );
  if (sources.length === 0) {
    console.log(JSON.stringify({ imported: 0, skipped: 0, sources: {} }));
    return;
  }
  const candidates = (await Promise.all(sources.map((s) => extractMemories(s)))).flat();
  const db = getDatabase();
  const result = await importMemories(candidates, db);
  console.log(JSON.stringify(result));
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
