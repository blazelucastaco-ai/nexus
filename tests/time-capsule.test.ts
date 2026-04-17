import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDatabase } from '../src/memory/database.js';
import {
  shouldCheckMessage,
  formatCapsuleMessage,
  findTimeCapsuleMatches,
  startTimeCapsule,
} from '../src/brain/time-capsule.js';
import { events } from '../src/core/events.js';
import { storeEmbedding } from '../src/memory/embeddings.js';
import { nanoid } from 'nanoid';
import type { AgedMatch } from '../src/data/semantic-queries.js';

function clearMemories(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM memory_embeddings').run();
  db.prepare('DELETE FROM memories').run();
}

// memories.last_accessed is NOT NULL in the schema. Tests that want to simulate
// "never accessed / aged" pass `lastAccessed: null` — we substitute a very old
// ISO date so the NOT NULL constraint is satisfied and the query's "aged" branch
// still matches.
const ANCIENT_ISO = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

function insertSemantic(params: {
  content: string;
  importance?: number;
  createdAt?: string;
  lastAccessed?: string | null;
  type?: string;
}): string {
  const db = getDatabase();
  const id = nanoid();
  const created = params.createdAt ?? new Date().toISOString();
  const lastAccessed =
    params.lastAccessed === undefined
      ? created
      : params.lastAccessed === null
        ? ANCIENT_ISO
        : params.lastAccessed;
  db.prepare(
    `INSERT INTO memories (id, layer, type, content, tags, importance, confidence, source, metadata, created_at, last_accessed, access_count)
     VALUES (?, 'semantic', ?, ?, '[]', ?, 0.9, 'test', '{}', ?, ?, 0)`,
  ).run(
    id,
    params.type ?? 'fact',
    params.content,
    params.importance ?? 0.7,
    created,
    lastAccessed,
  );
  storeEmbedding(id, params.content);
  return id;
}

describe('shouldCheckMessage', () => {
  it('skips short messages', () => {
    expect(shouldCheckMessage('hi')).toBe(false);
    expect(shouldCheckMessage('thanks!')).toBe(false);
  });

  it('skips pure acknowledgments', () => {
    expect(shouldCheckMessage('thanks that helped a lot')).toBe(false);
    expect(shouldCheckMessage('ok got it')).toBe(false);
  });

  it('accepts questions', () => {
    expect(shouldCheckMessage('How do I configure stripe webhooks again?')).toBe(true);
    expect(shouldCheckMessage('why does the auth module keep failing?')).toBe(true);
    expect(shouldCheckMessage('What is the correct way to handle this?')).toBe(true);
  });

  it('accepts problem statements', () => {
    expect(shouldCheckMessage('my build is broken and nothing I try works')).toBe(true);
    expect(shouldCheckMessage('keep getting this weird error on deploy')).toBe(true);
    expect(shouldCheckMessage('I am stuck on the payment flow')).toBe(true);
  });

  it('skips system-prefixed messages', () => {
    expect(shouldCheckMessage('[PHOTO] /path/to/image.jpg what is this?')).toBe(false);
    expect(shouldCheckMessage('[VOICE] something long here blah blah blah')).toBe(false);
  });
});

describe('formatCapsuleMessage', () => {
  const baseMatch: AgedMatch = {
    id: 'm1',
    content: 'Stripe webhook signature validation requires the raw body — use Express raw middleware.',
    type: 'fact',
    importance: 0.8,
    createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    lastAccessed: null,
    similarity: 0.75,
    ageDays: 90,
  };

  it('returns null for empty matches', () => {
    expect(formatCapsuleMessage([])).toBeNull();
  });

  it('formats a single match with age', () => {
    const msg = formatCapsuleMessage([baseMatch])!;
    expect(msg).toContain('Time Capsule');
    expect(msg).toContain('3 months ago');
    expect(msg).toContain('Stripe webhook');
  });

  it('hints at second strong match', () => {
    const second: AgedMatch = {
      ...baseMatch,
      id: 'm2',
      content: 'A different related fact',
      similarity: 0.7,
      ageDays: 45,
    };
    const msg = formatCapsuleMessage([baseMatch, second])!;
    expect(msg).toContain('and a related note');
  });

  it('does not hint at weak second match', () => {
    const second: AgedMatch = {
      ...baseMatch,
      id: 'm2',
      similarity: 0.2, // at MIN_SIMILARITY, not +0.05 above — shouldn't hint
      ageDays: 45,
    };
    const msg = formatCapsuleMessage([baseMatch, second])!;
    expect(msg).not.toContain('and a related note');
  });

  it('truncates long content', () => {
    const long: AgedMatch = {
      ...baseMatch,
      content: 'x'.repeat(600),
    };
    const msg = formatCapsuleMessage([long])!;
    expect(msg).toContain('…');
    expect(msg.length).toBeLessThan(800);
  });

  it('formats age in days under 30', () => {
    const m: AgedMatch = { ...baseMatch, ageDays: 21 };
    expect(formatCapsuleMessage([m])).toContain('21 days ago');
  });

  it('formats age in years for > 12 months', () => {
    const m: AgedMatch = { ...baseMatch, ageDays: 400 };
    expect(formatCapsuleMessage([m])).toContain('year');
  });
});

describe('findTimeCapsuleMatches', () => {
  beforeEach(() => clearMemories());

  it('returns empty for unqualifying messages', () => {
    // Short greeting — not checked
    expect(findTimeCapsuleMatches('hi')).toEqual([]);
  });

  it('finds aged high-importance match for a similar query', () => {
    const oldISO = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    insertSemantic({
      content: 'Stripe webhook signature validation requires the raw body — use Express raw middleware before json parser',
      importance: 0.8,
      createdAt: oldISO,
      lastAccessed: oldISO, // accessed long ago
    });

    const matches = findTimeCapsuleMatches('How do I validate Stripe webhook signatures again?');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.content).toContain('Stripe webhook');
    expect(matches[0]!.ageDays).toBeGreaterThanOrEqual(14);
  });

  it('skips recently accessed memories', () => {
    insertSemantic({
      content: 'Stripe webhook signature validation requires raw body middleware setup',
      importance: 0.9,
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      lastAccessed: new Date().toISOString(), // accessed just now
    });

    const matches = findTimeCapsuleMatches('How do I validate Stripe webhook signatures?');
    expect(matches).toEqual([]);
  });

  it('skips low-importance memories', () => {
    insertSemantic({
      content: 'Stripe webhook signature validation',
      importance: 0.3, // below threshold
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      lastAccessed: null,
    });

    const matches = findTimeCapsuleMatches('How do I validate Stripe webhook signatures?');
    expect(matches).toEqual([]);
  });

  it('skips unrelated matches (similarity too low)', () => {
    insertSemantic({
      content: 'TypeScript generics require explicit type parameters in arrow functions',
      importance: 0.8,
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      lastAccessed: null,
    });

    const matches = findTimeCapsuleMatches('Why is my CSS breaking in Safari?');
    expect(matches).toEqual([]);
  });
});

describe('startTimeCapsule event subscriber', () => {
  let subs: { unsubscribe(): void }[] = [];
  const sendMessage = vi.fn(async () => undefined);

  const fakeTelegram = {
    sendMessage,
  } as any;

  beforeEach(() => {
    clearMemories();
    events.clear();
    sendMessage.mockClear();
  });

  afterEach(() => {
    for (const s of subs) s.unsubscribe();
  });

  it('subscribes and does nothing on unqualifying messages', async () => {
    subs = startTimeCapsule({ telegram: fakeTelegram });

    events.emit({ type: 'message.received', chatId: 'c1', text: 'hi', textLen: 2 });

    // Give time for any async handler
    await new Promise((r) => setTimeout(r, 100));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not surface when no aged match found', async () => {
    // No memories at all
    subs = startTimeCapsule({ telegram: fakeTelegram });

    events.emit({
      type: 'message.received',
      chatId: 'c1',
      text: 'How do I configure the Supabase auth callback URL?',
      textLen: 60,
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not throw on event handler errors', () => {
    subs = startTimeCapsule({ telegram: fakeTelegram });
    expect(() => {
      events.emit({ type: 'message.received', chatId: 'c1', text: 'how do i x?', textLen: 11 });
    }).not.toThrow();
  });
});
