// Brain Phase 1.2 — Personality State Persistence
// Brain Phase 2.1 — Mood History, Circadian Baseline, Relationship Score
// Brain Phase 2.2 — Opinion History with Drift
// Brain Phase 2.3 — Disagreement Calibration History
//
// Saves and loads personality state to/from ~/.nexus/brain-state.json so NEXUS
// retains its emotional context, warmth, opinions, and interaction history across restarts.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import type { EmotionalState } from '../types.js';
import type { Opinion, DisagreementRecord } from '../personality/opinions.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('StatePersistence');

const STATE_PATH = join(homedir(), '.nexus', 'brain-state.json');
const STATE_VERSION = 4;

// ── Types ──────────────────────────────────────────────────────────────────

export interface MoodHistoryEntry {
  valence: number;
  timestamp: string; // ISO 8601
}

export interface BrainStateFile {
  version: number;
  savedAt: string;
  emotionalState: EmotionalState;
  mood: number;
  relationshipWarmth: number;
  relationshipScore: number;           // 0-1, grows with positive interactions
  messageCount: number;
  totalInteractionCount: number;       // canonical lifetime interaction counter
  firstInteraction: string;
  firstSeenTimestamp: string;          // canonical first-seen timestamp
  lastSeenTimestamp: string;           // most recent interaction
  opinions: Opinion[];
  moodHistory: MoodHistoryEntry[];     // last 50 entries with timestamps
  dailyMoodBaseline: number;           // -1 to 1, computed from time-of-day at save time
  // Phase 2.2: per-topic opinion drift history
  opinionHistory: Record<string, Array<{ stance: number; confidence: number; timestamp: string; reason: string }>>;
  // Phase 2.3: per-topic disagreement outcome history
  disagreementHistory: Record<string, DisagreementRecord[]>;
}

// ── File I/O ───────────────────────────────────────────────────────────────

/** Load brain state from disk. Returns null if no state file exists or it's unreadable. */
export function loadBrainState(): BrainStateFile | null {
  try {
    const raw = readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as BrainStateFile;

    if (parsed.version === 1) {
      // Migrate v1 → v2: fill Phase 2.1 defaults from existing fields
      const now = new Date().toISOString();
      parsed.version = 2;
      parsed.moodHistory = [];
      parsed.dailyMoodBaseline = 0;
      parsed.totalInteractionCount = parsed.messageCount ?? 0;
      parsed.firstSeenTimestamp = parsed.firstInteraction ?? now;
      parsed.lastSeenTimestamp = now;
      parsed.relationshipScore = Math.min((parsed.relationshipWarmth ?? 0) * 0.5, 1);
      log.info({ path: STATE_PATH }, 'Brain state migrated v1→v2');
    }

    if (parsed.version === 2) {
      // Migrate v2 → v3: add empty opinion history
      parsed.version = 3;
      parsed.opinionHistory = {};
      log.info({ path: STATE_PATH }, 'Brain state migrated v2→v3');
    }

    if (parsed.version === 3) {
      // Migrate v3 → v4: add empty disagreement history
      parsed.version = 4;
      parsed.disagreementHistory = {};
      log.info({ path: STATE_PATH }, 'Brain state migrated v3→v4');
    }

    if (parsed.version !== STATE_VERSION) {
      log.warn({ path: STATE_PATH, version: parsed.version }, 'Brain state version mismatch, ignoring');
      return null;
    }

    log.info({ path: STATE_PATH, savedAt: parsed.savedAt }, 'Brain state loaded');
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err }, 'Could not read brain state, starting fresh');
    }
    return null;
  }
}

/** Save brain state to disk synchronously (called from debounced wrapper). */
export function saveBrainState(state: BrainStateFile): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify({ ...state, savedAt: new Date().toISOString() }, null, 2), 'utf8');
    log.debug({ path: STATE_PATH }, 'Brain state saved');
  } catch (err) {
    log.error({ err }, 'Failed to save brain state');
  }
}

// ── Debounced saver ────────────────────────────────────────────────────────

const DEBOUNCE_MS = 30_000; // max once per 30 seconds

/**
 * Returns a debounced version of saveBrainState.
 * The first call within a 30-second window fires immediately; subsequent calls
 * within the window are dropped. This avoids hammering the disk on every message
 * while still ensuring the state is persisted promptly after changes.
 */
export function createDebouncedSaver(): (state: BrainStateFile) => void {
  let lastSave = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let pendingState: BrainStateFile | null = null;

  return function debouncedSave(state: BrainStateFile): void {
    const now = Date.now();
    pendingState = state;

    if (now - lastSave >= DEBOUNCE_MS) {
      // Enough time has passed — save immediately
      if (pending !== null) {
        clearTimeout(pending);
        pending = null;
      }
      lastSave = now;
      saveBrainState(state);
    } else {
      // Within the debounce window — schedule a trailing save
      if (pending === null) {
        const remaining = DEBOUNCE_MS - (now - lastSave);
        pending = setTimeout(() => {
          pending = null;
          lastSave = Date.now();
          if (pendingState) saveBrainState(pendingState);
        }, remaining);
      }
      // Update pendingState so the trailing save uses the latest data
    }
  };
}
