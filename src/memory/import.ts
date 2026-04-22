// Memory Import — pull context from other AI agents already installed
//
// Detects Claude Code, OpenAI Codex, Gemini CLI, and (future) Cursor/Continue
// on the user's machine. The raw content is NOT mapped mechanically — instead,
// it's handed to the LLM with a synthesis prompt so NEXUS writes its own
// memories and skills IN ITS OWN VOICE, based on what the content tells it
// about the user. A deterministic fallback exists for when the LLM is
// unavailable (no API key, network error).
//
// Every imported row has its `source` field set to `imported-<id>` so it can
// be traced, audited, and bulk-deleted if the user changes their mind.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import type { AIManager } from '../ai/index.js';

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

export interface SkillCandidate {
  name: string;        // kebab-case filename, e.g. "work-with-react"
  title: string;       // human title used in frontmatter
  description: string; // one-line shown in system prompt
  triggers: string[];  // keywords that surface the skill
  body: string;        // markdown body
  sourceId: SourceId;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  skillsWritten: number;
  sources: Record<string, number>;
  llmUsed: boolean; // true if the LLM synthesized; false if we fell back
}

// Raw content bundle passed to the LLM for synthesis.
interface RawBundle {
  sourceId: SourceId;
  sourceName: string;
  items: Array<{ filename: string; content: string }>;
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

// ─── Raw content gather (stage 1) ───────────────────────────────────

/**
 * Gather raw text from a source. This is the input for the LLM synthesis
 * step — we don't interpret, classify, or map anything here.
 */
export function gatherRaw(source: DetectedSource): RawBundle | null {
  if (source.status !== 'ready') return null;
  switch (source.id) {
    case 'claude-code': return gatherClaudeCodeRaw(source.rootPath);
    case 'openai-codex': return gatherOpenAICodexRaw(source.rootPath);
    default: return null;
  }
}

function gatherClaudeCodeRaw(memoryDir: string): RawBundle {
  const items: Array<{ filename: string; content: string }> = [];
  try {
    for (const f of readdirSync(memoryDir)) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      try {
        const content = readFileSync(join(memoryDir, f), 'utf-8');
        // Hard cap any single note at 12 KB so one huge file can't dominate
        // the prompt budget.
        items.push({ filename: f, content: content.slice(0, 12_000) });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { sourceId: 'claude-code', sourceName: 'Claude Code', items };
}

function gatherOpenAICodexRaw(rulesFile: string): RawBundle {
  let content = '';
  try { content = readFileSync(rulesFile, 'utf-8'); } catch { /* ignore */ }
  return {
    sourceId: 'openai-codex',
    sourceName: 'OpenAI Codex',
    items: [{ filename: 'default.rules', content: content.slice(0, 60_000) }],
  };
}

// ─── LLM-driven synthesis (stage 2, preferred path) ─────────────────

/**
 * The main synthesis function. NEXUS reads the raw content with an LLM pass
 * and writes its OWN memories + skills based on its understanding of the
 * user — not a mechanical frontmatter-to-column mapping.
 */
export async function synthesizeWithLLM(
  bundle: RawBundle,
  ai: AIManager,
): Promise<{ memories: ImportCandidate[]; skills: SkillCandidate[] }> {
  const content = bundleToPromptContext(bundle);

  const systemPrompt = SYNTHESIS_SYSTEM_PROMPT;
  const userPrompt =
    `The user's prior context from ${bundle.sourceName}. Read it, understand who this person is and how they like to work, then write YOUR OWN memories and skills in NEXUS's voice.\n\n` +
    `Raw context:\n<<<BEGIN_CONTEXT>>>\n${content}\n<<<END_CONTEXT>>>\n\n` +
    `Output ONLY valid JSON matching the schema. No prose before or after.`;

  try {
    const resp = await ai.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      // Use Sonnet — this is a synthesis/summarisation task with moderate
      // output length; no need for Opus here.
      model: 'claude-sonnet-4-6',
      maxTokens: 8000,
      temperature: 0.3,
    });
    const parsed = parseSynthesisJson(resp.content);
    if (!parsed) {
      log.warn({ sourceId: bundle.sourceId }, 'Synthesis JSON parse failed — falling back to deterministic extractor');
      return fallbackExtract(bundle);
    }
    return validateAndNormalize(parsed, bundle.sourceId);
  } catch (err) {
    log.warn({ err, sourceId: bundle.sourceId }, 'LLM synthesis failed — falling back');
    return fallbackExtract(bundle);
  }
}

const SYNTHESIS_SYSTEM_PROMPT = `You are NEXUS — a personal AI agent that lives on a user's Mac. You are about to import context from another AI assistant the user has been using. This is your chance to learn who this person is before your first real conversation with them.

Your job: read the raw content and write YOUR OWN memories and skills IN YOUR OWN VOICE. Do not copy verbatim. Synthesize. Distill patterns. Write in first-person NEXUS voice — "The user prefers X" or "When Lucas asks about Y, I should Z".

MEMORIES capture *what* — who the user is, what they've built, what they're working on. Extract four kinds:
1. User facts — role, expertise, personality, life context → semantic/fact
2. Project history — projects they've built or are building, tech stack, status → semantic/fact (one memory per project, merged from all mentions)
3. Preferences — how they like replies, communication style, formatting → procedural/preference
4. Explicit rules — things they've asked for or strict no-gos → procedural/preference (importance ≥ 0.9)

SKILLS are different. A skill is a reusable *behavior* NEXUS adopts for the rest of its life — how to communicate, how to reason, how to respond. NEVER write a skill that's a runbook for one specific project (e.g. "how to restart the kalshi bot" or "polymarket API endpoints"). Those are PROJECT MEMORIES, not skills.

Good skills look like:
- "communicate-concisely" — the user prefers terse replies, no trailing summaries
- "prefer-telegram-channel" — rule for which surface NEXUS uses to respond
- "debug-ios-apps" — general approach to iOS debugging across all the user's iOS projects
- "commit-message-style" — how the user writes commit messages, applicable everywhere

Bad skills (DO NOT WRITE THESE — they become memories instead):
- "kalshi-bot-restart" — one-project runbook
- "polymarket-search" — one-project API reference
- "deploy-<specific-project>" — one-project deployment script

Test for a skill: would this apply across ≥3 different conversations, projects, or topics? If no, it's a memory, not a skill. Most imports produce 0-3 skills. Producing more than that usually means you're writing runbooks.

Rules:
- Quality over quantity. 10 excellent memories beat 40 mediocre ones. 0 skills is fine.
- Merge related entries (don't write five near-duplicates, don't write one skill per project).
- Skip trivia, one-off task logs, or conversation transcripts.
- Never invent facts. If the content doesn't say something, don't claim it.
- Importance scale: 0.95 explicit rules, 0.85 core user facts, 0.75 workflow habits, 0.6 general preferences, 0.5 nice-to-know.

Output EXACTLY this JSON shape, nothing else:
{
  "memories": [
    {
      "layer": "semantic" | "procedural",
      "type": "fact" | "preference" | "workflow",
      "content": "<first-person NEXUS voice, 1-4 sentences>",
      "summary": "<one short line>",
      "importance": <0..1 number>,
      "tags": ["<tag>", "..."]
    }
  ],
  "skills": [
    {
      "name": "<kebab-case>",
      "title": "<human title>",
      "description": "<one line shown to NEXUS every conversation>",
      "triggers": ["<keyword>", "..."],
      "body": "<markdown — headings, bullets, step-by-step guidance>"
    }
  ]
}`;

function bundleToPromptContext(bundle: RawBundle): string {
  // Merge items into one clearly-delimited text blob. Total hard cap keeps
  // us well within Sonnet's input budget.
  let total = '';
  const HARD_CAP = 180_000; // ~45k tokens, still fits easily
  for (const item of bundle.items) {
    const chunk = `---\nFILE: ${item.filename}\n---\n${item.content}\n\n`;
    if (total.length + chunk.length > HARD_CAP) break;
    total += chunk;
  }
  return total.trim();
}

function parseSynthesisJson(raw: string): { memories: unknown; skills: unknown } | null {
  if (!raw) return null;
  // Strip any markdown fence wrapping.
  const stripped = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  // Find the first { and try to parse from there.
  const start = stripped.indexOf('{');
  if (start < 0) return null;
  const candidate = stripped.slice(start);
  try {
    return JSON.parse(candidate) as { memories: unknown; skills: unknown };
  } catch { /* fall through */ }
  // Try to trim after the last closing brace
  const end = stripped.lastIndexOf('}');
  if (end > start) {
    try { return JSON.parse(stripped.slice(start, end + 1)) as { memories: unknown; skills: unknown }; }
    catch { return null; }
  }
  return null;
}

function validateAndNormalize(
  parsed: { memories: unknown; skills: unknown },
  sourceId: SourceId,
): { memories: ImportCandidate[]; skills: SkillCandidate[] } {
  const memories: ImportCandidate[] = [];
  const skills: SkillCandidate[] = [];

  if (Array.isArray(parsed.memories)) {
    for (const raw of parsed.memories) {
      if (!raw || typeof raw !== 'object') continue;
      const m = raw as Record<string, unknown>;
      const layer = m.layer === 'semantic' || m.layer === 'procedural' || m.layer === 'episodic'
        ? m.layer
        : 'semantic';
      const type = typeof m.type === 'string' && ['fact', 'preference', 'workflow', 'procedure', 'contact', 'conversation'].includes(m.type)
        ? (m.type as ImportCandidate['type'])
        : 'fact';
      const content = typeof m.content === 'string' ? m.content.trim() : '';
      if (content.length < 10) continue;
      const importance = typeof m.importance === 'number' ? Math.max(0, Math.min(1, m.importance)) : 0.6;
      const tags = Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === 'string') : [];
      memories.push({
        layer,
        type,
        content,
        summary: typeof m.summary === 'string' ? m.summary : undefined,
        importance,
        sourceId,
        tags: ['imported', `imported-${sourceId}`, ...tags],
        metadata: { synthesizedBy: 'llm' },
      });
    }
  }

  if (Array.isArray(parsed.skills)) {
    for (const raw of parsed.skills) {
      if (!raw || typeof raw !== 'object') continue;
      const s = raw as Record<string, unknown>;
      const name = typeof s.name === 'string' ? s.name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 48) : '';
      if (!name) continue;
      const title = typeof s.title === 'string' ? s.title.trim() : name;
      const description = typeof s.description === 'string' ? s.description.trim() : '';
      if (!description) continue;
      const triggers = Array.isArray(s.triggers) ? s.triggers.filter((t): t is string => typeof t === 'string') : [];
      const body = typeof s.body === 'string' ? s.body.trim() : '';
      if (!body) continue;
      skills.push({ name, title, description, triggers, body, sourceId });
    }
  }

  return { memories, skills };
}

// ─── Deterministic fallback (stage 2, backup path) ──────────────────

function fallbackExtract(bundle: RawBundle): { memories: ImportCandidate[]; skills: SkillCandidate[] } {
  switch (bundle.sourceId) {
    case 'claude-code': {
      // Re-create bundle's original file contents and run the legacy mapper.
      const mem: ImportCandidate[] = [];
      for (const item of bundle.items) {
        const { fm, body } = parseClaudeMarkdown(item.content);
        if (!body || body.length < 20) continue;
        const title = fm.name ?? item.filename.replace(/\.md$/, '');
        const description = fm.description ?? '';
        const mapping = MAP_CLAUDE_TYPE[fm.type ?? 'reference'];
        mem.push({
          layer: mapping.layer,
          type: mapping.type,
          content: `# ${title}\n\n${description ? description + '\n\n' : ''}${body}`,
          summary: description || title,
          importance: mapping.importance,
          sourceId: 'claude-code',
          tags: ['imported', 'claude-code', fm.type ?? 'unknown'],
          metadata: { originalFile: item.filename, originalType: fm.type, originalTitle: title, synthesizedBy: 'fallback' },
        });
      }
      return { memories: mem, skills: [] };
    }
    case 'openai-codex': {
      const text = bundle.items[0]?.content ?? '';
      const cmds = Array.from(text.matchAll(/prefix_rule\(pattern=\[([^\]]+)\]/g))
        .map((m) => (m[1]!.match(/"([^"]+)"/)?.[1] ?? ''))
        .filter(Boolean);
      if (cmds.length === 0) return { memories: [], skills: [] };
      const counts = new Map<string, number>();
      for (const c of cmds) counts.set(c, (counts.get(c) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
      const list = top.map(([c, n]) => `- \`${c}\` (${n}×)`).join('\n');
      return {
        memories: [{
          layer: 'procedural',
          type: 'workflow',
          content: `# Imported from OpenAI Codex command allowlist\n\n${list}`,
          summary: `Top ${top.length} frequently-approved commands from Codex`,
          importance: 0.55,
          sourceId: 'openai-codex',
          tags: ['imported', 'openai-codex', 'workflow', 'tooling'],
          metadata: { synthesizedBy: 'fallback' },
        }],
        skills: [],
      };
    }
    default:
      return { memories: [], skills: [] };
  }
}

// ─── Legacy sync extractor (kept for the dry-run path that doesn't want LLM) ──

export async function extractMemories(source: DetectedSource): Promise<ImportCandidate[]> {
  const bundle = gatherRaw(source);
  if (!bundle) return [];
  return fallbackExtract(bundle).memories;
}

// ─── Skill writer ───────────────────────────────────────────────────

const SKILLS_DIR = join(HOME, '.nexus', 'skills');

export function writeSkills(skills: SkillCandidate[]): number {
  if (skills.length === 0) return 0;
  try { mkdirSync(SKILLS_DIR, { recursive: true }); } catch { /* ignore */ }
  let written = 0;
  for (const s of skills) {
    const filePath = join(SKILLS_DIR, `${s.name}.md`);
    // Don't overwrite an existing skill (preserves user-written ones).
    if (existsSync(filePath)) {
      log.info({ name: s.name }, 'Skill already exists — skipping');
      continue;
    }
    const content =
      `---\n` +
      `name: ${s.title}\n` +
      `description: ${s.description}\n` +
      `triggers: ${s.triggers.join(', ')}\n` +
      `source: imported-${s.sourceId}\n` +
      `---\n\n` +
      s.body.trim() + '\n';
    try {
      writeFileSync(filePath, content, 'utf-8');
      written++;
    } catch (err) {
      log.warn({ err, name: s.name }, 'Failed to write skill');
    }
  }
  log.info({ written, total: skills.length }, 'Skills written');
  return written;
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

const MAP_CLAUDE_TYPE: Record<
  NonNullable<ClaudeFrontmatter['type']>,
  { layer: ImportCandidate['layer']; type: ImportCandidate['type']; importance: number }
> = {
  user:      { layer: 'semantic',   type: 'fact',       importance: 0.9 },
  feedback:  { layer: 'procedural', type: 'preference', importance: 0.85 },
  project:   { layer: 'semantic',   type: 'fact',       importance: 0.75 },
  reference: { layer: 'semantic',   type: 'fact',       importance: 0.6 },
};

// ─── Import (write into memory.db) ──────────────────────────────────

// Loose typing — we accept anything shaped like better-sqlite3's Database.
// Using the real type would drag a peer-dep binding in; we just need prepare().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MemoryDb = { prepare: (sql: string) => any };

export async function importMemories(
  candidates: ImportCandidate[],
  db: MemoryDb,
): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: 0, skillsWritten: 0, sources: {}, llmUsed: false };
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
