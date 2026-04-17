// Context Stitcher — builds "we've talked about this before" injections.
//
// Called synchronously in the message pipeline (between memory-synthesis and
// prompt-build). For a given user message, finds prior episodic memories on
// the same topic and formats them as a compact context block that the main
// LLM sees in its system prompt.
//
// This is the "continuation awareness" layer: Lucas asks "how's the auth work
// going?" and NEXUS automatically knows that 5 days ago we set up the JWT
// middleware, because those memories surface through stitching — no manual
// recall or question-routing required.
//
// Pure function — no side effects, no events. Just data in → prompt text out.

import { findRelatedConversations, type RelatedConversation } from '../data/conversation-queries.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ContextStitcher');

// ─── Config ─────────────────────────────────────────────────────────────────

const MIN_QUERY_LENGTH = 15;   // Skip trivial messages
const MIN_SIMILARITY = 0.18;   // Slightly tighter than data-layer default
const MAX_MATCHES = 3;
const MAX_CONTENT_LEN = 280;   // Per-match truncation

// ─── Main entry ─────────────────────────────────────────────────────────────

/**
 * Build a "related prior conversations" context block for the current user
 * message, or return null if nothing relevant was found.
 *
 * The output is a paragraph formatted for inclusion in the system prompt:
 *
 *   Related prior conversations on this topic:
 *   - 3d ago: <snippet>
 *   - 1w ago: <snippet>
 */
export function buildThreadContext(query: string): string | null {
  if (!query || query.trim().length < MIN_QUERY_LENGTH) return null;

  try {
    const matches = findRelatedConversations({
      query,
      minSimilarity: MIN_SIMILARITY,
      limit: MAX_MATCHES,
      excludeRecentHours: 1,
      maxAgeHours: 24 * 30, // 30 days
    });

    if (matches.length === 0) return null;

    const lines: string[] = ['Related prior conversations on this topic:'];
    for (const m of matches) {
      const when = formatAge(m.ageHours);
      const snippet = compressContent(m.content);
      lines.push(`- ${when}: ${snippet}`);
    }
    return lines.join('\n');
  } catch (err) {
    log.debug({ err }, 'buildThreadContext failed');
    return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function formatAge(hours: number): string {
  if (hours < 1) return `<1h ago`;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return `1 day ago`;
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return `1 week ago`;
  if (weeks < 5) return `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return `1 month ago`;
  return `${months} months ago`;
}

/**
 * Memory content often has repeated "User said:" / "NEXUS replied:" preambles.
 * Strip common noise and truncate.
 */
function compressContent(s: string): string {
  let t = s.replace(/^(User|NEXUS|Assistant)\s*(said|replied|wrote)?:\s*/i, '').trim();
  // Collapse whitespace
  t = t.replace(/\s+/g, ' ');
  if (t.length > MAX_CONTENT_LEN) {
    t = t.slice(0, MAX_CONTENT_LEN) + '…';
  }
  return t;
}

// Re-export for tests that want to assert shape
export type { RelatedConversation };
