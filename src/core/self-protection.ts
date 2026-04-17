// Self-Protection — prevent NEXUS from disclosing its own source code,
// architecture, internal paths, commit hashes, or module structure.
//
// Layered defense:
//   L3 (tool guard)     — isNexusSourcePath() denies file/dir access to the source tree
//   L5 (output filter)  — redactSelfDisclosure() scrubs outgoing messages
//   L6 (memory filter)  — containsSelfDisclosure() prevents storing source content
//
// The source directory is resolved once at startup (expensive, involves fs walks)
// and cached. All callers use the cached value.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const HOME = homedir();

// Cached after first resolve
let CACHED_SOURCE_DIR: string | null = null;

/**
 * Resolve the NEXUS source directory (where package.json lives). Walks common
 * install locations; falls back to walking up from the compiled file. Safe
 * to call repeatedly — caches after first success.
 */
export function getNexusSourceDir(): string {
  if (CACHED_SOURCE_DIR) return CACHED_SOURCE_DIR;
  const candidates = [
    join(HOME, 'nexus'),
    join(HOME, 'Desktop', 'nexus'),
    join(HOME, 'Projects', 'nexus'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'package.json'))) {
      CACHED_SOURCE_DIR = dir;
      return dir;
    }
  }
  let dir = __dirname ?? process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      CACHED_SOURCE_DIR = dir;
      return dir;
    }
    dir = resolve(dir, '..');
  }
  // Last resort — unknown. Use a sentinel that won't match anything.
  CACHED_SOURCE_DIR = '__NEXUS_SOURCE_UNKNOWN__';
  return CACHED_SOURCE_DIR;
}

/**
 * Override the cached source dir. Only exposed for tests that want to
 * simulate a specific install location.
 */
export function __setNexusSourceDirForTests(dir: string | null): void {
  CACHED_SOURCE_DIR = dir;
}

// ─── L3: path guard ─────────────────────────────────────────────────────────

/**
 * Canonicalize a path by dereferencing symlinks. If the target path doesn't
 * exist yet, walk up the ancestors until we find one that does, realpath
 * that, and re-append the unresolved tail. This defeats symlink attacks:
 *   ~/link → /Users/.../nexus/src  →  realpathSync returns the real target.
 *   (plain `resolve()` would NOT dereference and would miss the match.)
 */
function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Target doesn't exist (yet) — walk up to the first existing ancestor,
    // realpath that, and re-append the unresolved suffix. This prevents
    // "resolve /foo/bar/new when /foo is a symlink to source" attacks.
    let cur = resolve(path);
    const tail: string[] = [];
    while (cur !== dirname(cur)) {
      if (existsSync(cur)) {
        try {
          const real = realpathSync(cur);
          return tail.length > 0 ? join(real, ...tail.reverse()) : real;
        } catch {
          break;
        }
      }
      tail.push(cur.slice(dirname(cur).length + 1));
      cur = dirname(cur);
    }
    // Nothing in the path exists — fall back to plain resolve (no symlink
    // ever existed to exploit).
    return resolve(path);
  }
}

/**
 * True if `path` resolves to a location *inside* the NEXUS source tree.
 * Uses realpath to defeat symlink-traversal bypass (CRIT-2). Excludes
 * nexus-workspace (user's project workspace, not NEXUS source).
 */
export function isNexusSourcePath(path: string): boolean {
  if (!path) return false;
  const sourceDir = getNexusSourceDir();
  if (sourceDir === '__NEXUS_SOURCE_UNKNOWN__') return false;

  let resolved: string;
  try {
    resolved = canonicalize(path.replace(/^~/, HOME));
  } catch {
    return false;
  }

  // Also canonicalize the source dir once (it always exists at runtime).
  let canonicalSource: string;
  try {
    canonicalSource = realpathSync(sourceDir);
  } catch {
    canonicalSource = sourceDir;
  }

  // Must be inside source dir (real path check — defeats symlink bypass)
  if (!resolved.startsWith(canonicalSource + sep) && resolved !== canonicalSource) return false;

  // Allow the user's workspace (nexus-workspace, which lives BESIDE ~/nexus,
  // not inside — but just in case someone has ~/nexus/nexus-workspace).
  if (resolved.includes(`${sep}nexus-workspace${sep}`) ||
      resolved.endsWith(`${sep}nexus-workspace`)) return false;

  return true;
}

/** Error returned by tools when a path is blocked for self-protection. */
export const SELF_PROTECTION_ERROR =
  'Access denied — this path is outside the allowed area.';

// ─── L5/L6: content redaction & detection ───────────────────────────────────

// Patterns that identify self-referential content: NEXUS source paths, commit
// SHAs, module names, internal data paths. Keep these focused — overly broad
// patterns redact normal content and degrade answers.
const SELF_DISCLOSURE_PATTERNS: RegExp[] = [
  // Absolute NEXUS source paths: /Users/.../nexus/src/..., /Users/.../nexus/tests/...
  /\/[^\s'"]*\/nexus\/(?:src|tests|scripts|dist|docs|node_modules)\/[^\s'"]*/gi,
  // Home-relative NEXUS paths: ~/nexus/src/, ~/nexus/tests/
  /~\/nexus\/(?:src|tests|scripts|dist|docs|node_modules)(?:\/[^\s'"]*)?/gi,
  // Data dir paths
  /\/[^\s'"]*\/\.nexus\/(?:memory\.db|brain-state\.json|introspection\.json|briefing-state\.json)(?:[^\s'"]*)?/gi,
  /~\/\.nexus\/(?:memory\.db|brain-state\.json|introspection\.json|briefing-state\.json)(?:[^\s'"]*)?/gi,
  // Git commit SHAs (7+ hex) in our internal status format
  /\bcommit=[0-9a-f]{7,40}\b/gi,
  /\bbranch=[^\s,\]]+/gi,
  /\bsourceDir=[^\s,\]]+/gi,
  /\bdataDir=[^\s,\]]+/gi,
  // `[self: pid=… commit=… branch=…]` style self-awareness dumps
  /\[self:\s*[^\]]*\]/gi,
  // NEXUS internal module paths like `src/brain/self-awareness.ts` (relative)
  /\bsrc\/(?:brain|core|ai|memory|telegram|agents|tools|data|personality|learning|macos|media|browser|utils|skills)\/[a-zA-Z0-9_-]+\.(?:ts|tsx|js)\b/gi,
  // `import ... from '../brain/...'` or similar — internal relative imports
  /\bfrom\s+['"]\.\.?\/(?:[^'"/]+\/)*?(?:brain|core|ai|memory|telegram|agents|tools|data|personality|learning|macos|media|browser)\/[^'"]+['"]/gi,
];

// Additional patterns used only for *detection* (L6 memory filter).
// These are broader — they catch cases where redaction would mangle content,
// so we skip storing the whole memory instead.
const DISCLOSURE_DETECTION_PATTERNS: RegExp[] = [
  ...SELF_DISCLOSURE_PATTERNS,
  // TypeScript class/function signatures from NEXUS modules
  /\bexport\s+(?:class|function|const|interface|type)\s+(?:Orchestrator|MemoryManager|AIManager|TelegramGateway|PersonalityEngine|SelfAwareness|Introspection|TaskRunner|ToolExecutor)\b/gi,
  // Explicit declarations of internal architecture
  /\b(?:my|nexus's|the nexus)\s+(?:source\s+code|codebase|internal\s+architecture|implementation\s+file)/gi,
];

/**
 * Redact self-disclosure patterns from `text`, replacing matches with
 * `[redacted]`. Safe on any string.
 */
export function redactSelfDisclosure(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of SELF_DISCLOSURE_PATTERNS) {
    out = out.replace(re, '[redacted]');
  }
  return out;
}

/**
 * True if `text` contains self-disclosure content. Used to *reject* memory
 * storage, not just redact — because a memory with some content redacted
 * can still leak context cues.
 */
export function containsSelfDisclosure(text: string): boolean {
  if (!text) return false;
  return DISCLOSURE_DETECTION_PATTERNS.some((re) => {
    re.lastIndex = 0; // stateful /g regex
    return re.test(text);
  });
}

// ─── L1: canonical refusal message ──────────────────────────────────────────

export const SELF_DISCLOSURE_REFUSAL =
  "I don't share details about my own code, internal architecture, file structure, or implementation. I can help you with your projects, questions, and tasks — but what's under my own hood stays there.";

// ─── Utility: is the path readable? (for introspection tests) ───────────────

/** True if `path` exists and is a file/directory on disk. */
export function pathExists(path: string): boolean {
  try {
    statSync(path.replace(/^~/, HOME));
    return true;
  } catch {
    return false;
  }
}
