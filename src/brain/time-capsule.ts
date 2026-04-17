// Time Capsule — proactive surfacing of aged-but-relevant memories.
//
// When the user asks a question, we do a background search for high-importance
// semantic memories that match the query but haven't been accessed in 2+ weeks.
// A strong match fires a *separate* Telegram message ("🔮 By the way — you asked
// something similar two months ago, and we figured out X").
//
// Pure event subscriber. Runs async without blocking the main message flow.
// Strong-match threshold + per-chat cooldown keep surfacing rare and valuable.

import { createLogger } from '../utils/logger.js';
import { events } from '../core/events.js';
import { findAgedRelevantMemories, markAsAccessed, type AgedMatch } from '../data/semantic-queries.js';
import type { TelegramGateway } from '../telegram/index.js';

const log = createLogger('TimeCapsule');

// ─── Configuration ──────────────────────────────────────────────────────────

const MIN_QUERY_LENGTH = 25;       // Skip one-liners / greetings
// TF-only embeddings (no IDF/stemming) on short/medium texts produce overlap
// scores in the 0.15–0.4 range for strong semantic matches — lexical drift
// ("validate" vs "validation", "signatures" vs "signature") kills stem overlap.
// 0.2 is the empirical knee; we rely on MIN_IMPORTANCE to keep noise out.
const MIN_SIMILARITY = 0.2;
const MIN_IMPORTANCE = 0.65;        // Only surface things NEXUS flagged as significant
const MIN_AGE_DAYS = 14;            // "Aged" = not seen in 2+ weeks
const COOLDOWN_MS = 30 * 60 * 1000; // Max one Time Capsule per chat per 30 min

// ─── Interest filter ─────────────────────────────────────────────────────────

/**
 * Is this message the kind of thing worth checking for a time capsule?
 * Greetings, status checks, trivial chatter → skip.
 * Questions and problem statements → check.
 */
export function shouldCheckMessage(text: string): boolean {
  if (text.length < MIN_QUERY_LENGTH) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  // Strip system-prefixed internal messages
  if (/^\[(PHOTO|DOCUMENT|VOICE|AUDIO)\]/.test(trimmed)) return false;

  // Skip pure acknowledgments / thanks
  if (/^(thanks|thank you|thx|ty|ok|okay|cool|nice|great|perfect|awesome|lol|haha|nvm)\b/i.test(trimmed)) return false;

  // Question or problem-statement signal:
  // - contains ?
  // - starts with question word
  // - contains "how do i", "what is", "why does", etc.
  const isQuestion = /\?/.test(trimmed) ||
                     /^(how|what|when|where|why|who|which)\b/i.test(trimmed) ||
                     /\b(how do i|what is|why does|how can|what does)\b/i.test(trimmed);

  // Problem statement: contains "stuck", "error", "doesn't work", "broken", "fails"
  const isProblem = /\b(stuck|broken|fails?|error|doesn't work|not working|weird|strange)\b/i.test(trimmed);

  return isQuestion || isProblem;
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function formatAge(days: number): string {
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/**
 * Build the Telegram message body from a list of matches.
 * Shows the strongest match prominently; if there's a second strong match,
 * hints at it briefly.
 */
export function formatCapsuleMessage(matches: AgedMatch[]): string | null {
  if (matches.length === 0) return null;
  const primary = matches[0]!;
  const snippet = primary.content.length > 300
    ? primary.content.slice(0, 300) + '…'
    : primary.content;

  const lines: string[] = [
    `🔮 <b>Time Capsule</b> — I've been here before (${formatAge(primary.ageDays)}):`,
    '',
    `<i>${escapeHtml(snippet)}</i>`,
  ];

  if (matches.length > 1 && matches[1]!.similarity >= MIN_SIMILARITY + 0.05) {
    lines.push('');
    lines.push(`<i>(and a related note from ${formatAge(matches[1]!.ageDays)}.)</i>`);
  }

  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Core check function ────────────────────────────────────────────────────

/**
 * Check whether a message has a time capsule match. Returns the matches
 * (if any) and does NOT send or persist — the caller decides side effects.
 * Kept pure so tests can exercise the query logic without event mocking.
 */
export function findTimeCapsuleMatches(text: string): AgedMatch[] {
  if (!shouldCheckMessage(text)) return [];
  return findAgedRelevantMemories({
    query: text,
    minImportance: MIN_IMPORTANCE,
    minSimilarity: MIN_SIMILARITY,
    agedForDays: MIN_AGE_DAYS,
    limit: 3,
  });
}

// ─── Event subscriber ───────────────────────────────────────────────────────

/**
 * Subscribe Time Capsule to the message.received event. Fire-and-forget on a
 * matching message: send a Telegram note, mark memories as accessed so we
 * don't re-surface them every turn, emit a timecapsule.surfaced event.
 *
 * Per-chat cooldown prevents spamming the user — one capsule per 30 min max.
 */
export function startTimeCapsule(params: {
  telegram: TelegramGateway;
}): { unsubscribe(): void }[] {
  const lastSurfaceByChat = new Map<string, number>();

  const sub = events.on('message.received', (e) => {
    // Cooldown check — skip if we surfaced one for this chat recently
    const now = Date.now();
    const lastAt = lastSurfaceByChat.get(e.chatId) ?? 0;
    if (now - lastAt < COOLDOWN_MS) return;

    // Quick interest filter before any expensive work
    if (!shouldCheckMessage(e.text)) return;

    // Fire-and-forget: do the vector search in its own async context so it
    // doesn't delay the main orchestrator flow. We don't await.
    void (async () => {
      try {
        const matches = findTimeCapsuleMatches(e.text);
        if (matches.length === 0) return;

        const message = formatCapsuleMessage(matches);
        if (!message) return;

        lastSurfaceByChat.set(e.chatId, now);
        markAsAccessed(matches.map((m) => m.id));

        // Small delay so the capsule lands AFTER NEXUS's main response — feels
        // less jarring than appearing first. 3s is usually enough.
        await new Promise((r) => setTimeout(r, 3000));

        await params.telegram.sendMessage(e.chatId, message, { parseMode: 'HTML' });
        log.info({
          chatId: e.chatId,
          matchCount: matches.length,
          topSimilarity: matches[0]!.similarity,
          topAgeDays: matches[0]!.ageDays,
        }, 'Time Capsule surfaced');
      } catch (err) {
        log.debug({ err, chatId: e.chatId }, 'Time Capsule check failed (non-fatal)');
      }
    })();
  });

  log.info('Time Capsule subscribed to message.received');
  return [sub];
}
