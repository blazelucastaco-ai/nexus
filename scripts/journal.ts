#!/usr/bin/env tsx
// nexus journal — view recent task journal entries
// Usage: npx tsx scripts/journal.ts [N]   (default: 20 entries)

import { printRecentJournal } from '../src/brain/task-journal.js';

const n = parseInt(process.argv[2] ?? '20', 10);
printRecentJournal(isNaN(n) ? 20 : n).catch((err) => {
  console.error('Error reading journal:', err);
  process.exit(1);
});
