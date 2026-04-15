// Runtime Skill Injection — FIX 5
//
// Scans ~/.nexus/skills/ for SKILL.md files with YAML frontmatter.
// Discovered skills are injected into the system prompt so the LLM
// knows what capabilities are available.
//
// Skill file format:
//   ---
//   name: My Skill
//   description: One-line summary shown in system prompt
//   triggers: keyword1, keyword2
//   ---
//   ## Body
//   Detailed instructions...

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Skills');

export interface Skill {
  name: string;
  description: string;
  triggers: string[];
  body: string;
  fileName: string;
}

const SKILLS_DIR = join(homedir(), '.nexus', 'skills');

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const metaBlock = match[1] ?? '';
  const body = match[2] ?? '';
  const meta: Record<string, string> = {};

  for (const line of metaBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) meta[key] = value;
  }

  return { meta, body };
}

export async function loadSkills(): Promise<Skill[]> {
  // Ensure skills directory exists
  await mkdir(SKILLS_DIR, { recursive: true });

  let entries: string[];
  try {
    const dirents = await readdir(SKILLS_DIR);
    entries = dirents.filter((f) => f.endsWith('.md'));
  } catch {
    log.warn({ dir: SKILLS_DIR }, 'Could not read skills directory');
    return [];
  }

  const skills: Skill[] = [];

  for (const fileName of entries) {
    try {
      const raw = await readFile(join(SKILLS_DIR, fileName), 'utf-8');
      const { meta, body } = parseFrontmatter(raw);

      if (!meta.name || !meta.description) {
        log.warn({ fileName }, 'Skill missing name or description — skipping');
        continue;
      }

      skills.push({
        name: meta.name,
        description: meta.description,
        triggers: meta.triggers ? meta.triggers.split(',').map((t) => t.trim()) : [],
        body: body.trim(),
        fileName,
      });
    } catch (err) {
      log.warn({ fileName, err }, 'Failed to load skill file');
    }
  }

  log.info({ count: skills.length, dir: SKILLS_DIR }, 'Skills loaded');
  return skills;
}

/**
 * Score a skill's relevance to a piece of text (0 = no match, higher = more relevant).
 * Matches against skill name, description, and trigger keywords.
 */
function scoreSkillRelevance(skill: Skill, text: string): number {
  const lower = text.toLowerCase();
  let score = 0;

  // Trigger keyword matches (strongest signal)
  for (const trigger of skill.triggers) {
    if (lower.includes(trigger.toLowerCase())) score += 3;
  }

  // Name / description word matches
  const nameWords = skill.name.toLowerCase().split(/\s+/);
  for (const word of nameWords) {
    if (word.length > 3 && lower.includes(word)) score += 1;
  }

  return score;
}

/**
 * Select the most relevant skills for a given request text.
 * Returns at most `maxSkills` skills with a relevance score > 0,
 * sorted by score descending. Falls back to all skills if nothing matches.
 */
export function selectRelevantSkills(skills: Skill[], text: string, maxSkills = 3): Skill[] {
  if (skills.length === 0) return [];

  const scored = skills
    .map((s) => ({ skill: s, score: scoreSkillRelevance(s, text) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSkills)
    .map((s) => s.skill);

  // If nothing matched, return the top 2 by name (generic fallback)
  return scored.length > 0 ? scored : skills.slice(0, 2);
}

/**
 * Build the skills section to inject into the system prompt.
 * Pass `text` to select only relevant skills; omit to include all.
 * Returns empty string if no skills found.
 */
export function buildSkillsPrompt(skills: Skill[], text?: string): string {
  if (skills.length === 0) return '';

  const relevant = text ? selectRelevantSkills(skills, text) : skills;
  if (relevant.length === 0) return '';

  const lines = [
    '## Active Skills',
    '',
    ...relevant.flatMap((s) => [
      `### ${s.name}`,
      s.description,
      '',
      s.body,
      '',
    ]),
  ];

  return lines.join('\n');
}
