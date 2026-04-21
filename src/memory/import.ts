// Memory Import — pull context from other AI agents already installed
//
// Detects Claude Code, OpenAI Codex, Gemini CLI, and (future) Cursor/Continue
// on the user's machine, extracts usable memory content, and merges it into
// NEXUS's memory.db as tagged semantic/procedural entries.
//
// Every imported row has its `source` field set to `imported-<id>` so it can
// be traced, audited, and bulk-deleted if the user changes their mind.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../utils/logger.js';

const log = createLogger('MemoryImport');
const HOME = homedir();

// ─── Types ──────────────────────────────────────────────────────────

export type SourceId = 'claude-code' | 'openai-codex' | 'gemini-cli' | 'cursor';

export interface DetectedSource {
  id: SourceId;
  name: string;
  rootPath: string;
  status: 'ready' | 'empty' | 'coming-soon';
  summary: string; // one-line human-readable summary
  estimatedItems: number;
}

export interface ImportCandidate {
  layer: 'semantic' | 'procedural' | 'episodic';
  type:
    | 'fact'
    | 'preference'
    | 'workflow'
    | 'procedure'
    | 'contact'
    | 'conversation';
  content: string;
  summary?: string;
  importance: number; // 0-1
  sourceId: SourceId;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  sources: Record<string, number>;
}

// ─── Detection ──────────────────────────────────────────────────────

export async function detectAllSources(): Promise<DetectedSource[]> {
  const results: DetectedSource[] = [];
  for (const detect of [detectClaudeCode, detectOpenAICodex, detectGeminiCli, detectCursor]) {
    try {
      const r = await detect();
      if (r) results.push(r);
    } catch (err) {
      log.warn({ err }, 'Source detector threw — skipping');
    }
  }
  return results;
}

async function detectClaudeCode(): Promise<DetectedSource | null> {
  const root = join(HOME, '.claude', 'projects');
  if (!existsSync(root)) return null;
  // Claude Code stores per-project directories named after the encoded path.
  // Memory files live under <project>/memory/*.md with frontmatter.
  let memoryCount = 0;
  let lastUsed = 0;
  let memoryDir = '';
  try {
    for (const entry of readdirSync(root)) {
      const mem = join(root, entry, 'memory');
      if (!existsSync(mem)) continue;
      memoryDir = mem; // use the first one found (Claude typically has one per user home)
      for (const f of readdirSync(mem)) {
        if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
        memoryCount++;
        try {
          const t = statSync(join(mem, f)).mtimeMs;
          if (t > lastUsed) lastUsed = t;
        } catch { /* ignore */ }
      }
      break;
    }
  } catch (err) {
    log.warn({ err }, 'Claude Code scan failed');
  }
  if (memoryCount === 0) {
    return {
      id: 'claude-code',
      name: 'Claude Code',
      rootPath: root,
      status: 'empty',
      summary: 'Installed, but no memory notes to import',
      estimatedItems: 0,
    };
  }
  const when = lastUsed ? ` · last used ${daysAgo(lastUsed)}` : '';
  return {
    id: 'claude-code',
    name: 'Claude Code',
    rootPath: memoryDir,
    status: 'ready',
    summary: `${memoryCount} memory note${memoryCount === 1 ? '' : 's'}${when}`,
    estimatedItems: memoryCount,
  };
}

async function detectOpenAICodex(): Promise<DetectedSource | null> {
  const root = join(HOME, '.codex');
  if (!existsSync(root)) return null;
  const rulesFile = join(root, 'rules', 'default.rules');
  if (!existsSync(rulesFile)) {
    return {
      id: 'openai-codex',
      name: 'OpenAI Codex',
      rootPath: root,
      status: 'empty',
      summary: 'Installed, but no rules file to import',
      estimatedItems: 0,
    };
  }
  let lineCount = 0;
  try {
    const content = readFileSync(rulesFile, 'utf-8');
    lineCount = content.split('\n').filter((l) => l.trim().startsWith('prefix_rule')).length;
  } catch { /* ignore */ }
  if (lineCount === 0) {
    return {
      id: 'openai-codex',
      name: 'OpenAI Codex',
      rootPath: root,
      status: 'empty',
      summary: 'Rules file present but no prefix rules to import',
      estimatedItems: 0,
    };
  }
  return {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    rootPath: rulesFile,
    status: 'ready',
    summary: `${lineCount} command allowlist rules — extracted as workflow hints`,
    estimatedItems: Math.min(lineCount, 30),
  };
}

async function detectGeminiCli(): Promise<DetectedSource | null> {
  const root = join(HOME, '.gemini');
  if (!existsSync(root)) return null;
  // Gemini CLI doesn't currently expose user-memory content in a minable shape
  // (projects.json/state.json are metadata only). Surface as "coming soon".
  return {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    rootPath: root,
    status: 'coming-soon',
    summary: 'Detected, but no user-memory format to import yet',
    estimatedItems: 0,
  };
}

async function detectCursor(): Promise<DetectedSource | null> {
  const roots = [
    join(HOME, 'Library', 'Application Support', 'Cursor'),
    join(HOME, '.cursor'),
  ];
  for (const r of roots) {
    if (existsSync(r)) {
      return {
        id: 'cursor',
        name: 'Cursor',
        rootPath: r,
        status: 'coming-soon',
        summary: 'Detected — rule/preference import coming in a future release',
        estimatedItems: 0,
      };
    }
  }
  return null;
}

// ─── Extraction ─────────────────────────────────────────────────────

export async function extractMemories(source: DetectedSource): Promise<ImportCandidate[]> {
  if (source.status !== 'ready') return [];
  switch (source.id) {
    case 'claude-code': return extractClaudeCode(source.rootPath);
    case 'openai-codex': return extractOpenAICodex(source.rootPath);
    default: return [];
  }
}

interface ClaudeFrontmatter {
  name?: string;
  description?: string;
  type?: 'user' | 'feedback' | 'project' | 'reference';
}

function parseClaudeMarkdown(raw: string): { fm: ClaudeFrontmatter; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw.trim() };
  const fm: ClaudeFrontmatter = {};
  for (const line of m[1]!.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+?)\s*$/);
    if (!kv) continue;
    const k = kv[1]!;
    const v = kv[2]!;
    if (k === 'name') fm.name = v;
    else if (k === 'description') fm.description = v;
    else if (k === 'type' && /^(user|feedback|project|reference)$/.test(v)) {
      fm.type = v as ClaudeFrontmatter['type'];
    }
  }
  return { fm, body: (m[2] ?? '').trim() };
}

function extractClaudeCode(memoryDir: string): ImportCandidate[] {
  if (!existsSync(memoryDir)) return [];
  const out: ImportCandidate[] = [];
  for (const f of readdirSync(memoryDir)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    let raw: string;
    try { raw = readFileSync(join(memoryDir, f), 'utf-8'); } catch { continue; }
    const { fm, body } = parseClaudeMarkdown(raw);
    if (!body || body.length < 20) continue;
    const title = fm.name ?? f.replace(/\.md$/, '');
    const description = fm.description ?? '';
    // Map Claude memory types → NEXUS layer + type
    const mapping = MAP_CLAUDE_TYPE[fm.type ?? 'reference'];
    // Content stored as markdown. Prefix with a title line so it's browsable
    // in the Memory tab without losing structure.
    const content = `# ${title}\n\n${description ? description + '\n\n' : ''}${body}`;
    out.push({
      layer: mapping.layer,
      type: mapping.type,
      content,
      summary: description || title,
      importance: mapping.importance,
      sourceId: 'claude-code',
      tags: ['imported', 'claude-code', fm.type ?? 'unknown'],
      metadata: {
        originalFile: f,
        originalType: fm.type,
        originalTitle: title,
      },
    });
  }
  return out;
}

const MAP_CLAUDE_TYPE: Record<
  NonNullable<ClaudeFrontmatter['type']>,
  { layer: ImportCandidate['layer']; type: ImportCandidate['type']; importance: number }
> = {
  user:      { layer: 'semantic',   type: 'fact',       importance: 0.9 },
  feedback:  { layer: 'procedural', type: 'preference', importance: 0.85 },
  project:   { layer: 'semantic',   type: 'fact',       importance: 0.75 },
  reference: { layer: 'semantic',   type: 'fact',       importance: 0.6 },
};

function extractOpenAICodex(rulesFile: string): ImportCandidate[] {
  // Codex prefix_rule entries tell us which commands the user has previously
  // allowed. They're not memory per se, but they're a strong signal about the
  // user's tooling — npm/uvicorn/curl/polymarket/etc. We fold them into one
  // aggregate procedural note rather than N individual rules.
  const content = readFileSync(rulesFile, 'utf-8');
  const commands = Array.from(content.matchAll(/prefix_rule\(pattern=\[([^\]]+)\]/g))
    .map((m) => {
      const args = m[1]!.match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
      return args[0] ?? '';
    })
    .filter(Boolean);
  if (commands.length === 0) return [];
  // Dedupe + pick the top N most common commands
  const counts = new Map<string, number>();
  for (const c of commands) counts.set(c, (counts.get(c) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const commandList = top.map(([cmd, n]) => `- \`${cmd}\` (${n}×)`).join('\n');
  return [{
    layer: 'procedural',
    type: 'workflow',
    content:
      `# Imported from OpenAI Codex command allowlist\n\n` +
      `These are commands the user has previously approved Codex to run. They\n` +
      `reflect the user's tooling stack and typical workflow. Treat as a hint,\n` +
      `not a hard rule.\n\n` +
      commandList,
    summary: `Top ${top.length} frequently-approved commands from Codex`,
    importance: 0.55,
    sourceId: 'openai-codex',
    tags: ['imported', 'openai-codex', 'workflow', 'tooling'],
    metadata: { totalRules: commands.length, topCommands: top.map(([c]) => c) },
  }];
}

// ─── Import (write into memory.db) ──────────────────────────────────

// Loose typing — we accept anything shaped like better-sqlite3's Database.
// Using the real type would drag a peer-dep binding in; we just need prepare().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MemoryDb = { prepare: (sql: string) => any };

export async function importMemories(
  candidates: ImportCandidate[],
  db: MemoryDb,
): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0, sources: {} };
  const stmt = db.prepare(`
    INSERT INTO memories (
      id, layer, type, content, summary, importance, confidence,
      created_at, last_accessed, access_count, tags, related_memories,
      source, metadata
    ) VALUES (
      @id, @layer, @type, @content, @summary, @importance, 1.0,
      datetime('now'), datetime('now'), 0, @tags, '[]', @source, @metadata
    )
  `);
  // Check for duplicates by content hash (avoids reimporting on a second run).
  const exists = db.prepare(`
    SELECT 1 FROM memories WHERE source = ? AND json_extract(metadata,'$.originalFile') = ? LIMIT 1
  `);
  for (const c of candidates) {
    const source = `imported-${c.sourceId}`;
    const originalFile = (c.metadata.originalFile as string | undefined) ?? '';
    if (originalFile && exists.get(source, originalFile)) {
      result.skipped++;
      continue;
    }
    const id = randomBytes(16).toString('hex');
    try {
      stmt.run({
        id,
        layer: c.layer,
        type: c.type,
        content: c.content,
        summary: c.summary ?? null,
        importance: c.importance,
        tags: JSON.stringify(c.tags),
        source,
        metadata: JSON.stringify(c.metadata),
      });
      result.imported++;
      result.sources[c.sourceId] = (result.sources[c.sourceId] ?? 0) + 1;
    } catch (err) {
      log.warn({ err, sourceId: c.sourceId }, 'Insert failed — skipping one');
      result.skipped++;
    }
  }
  log.info(result, 'Memory import complete');
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────

function daysAgo(ts: number): string {
  const ms = Date.now() - ts;
  const d = Math.round(ms / 86_400_000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  if (d < 60) return `${Math.round(d / 7)}w ago`;
  return `${Math.round(d / 30)}mo ago`;
}
