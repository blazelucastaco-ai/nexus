// Brain Phase 1.2 — Personality State Persistence
//
// Saves and loads personality state to/from ~/.nexus/brain-state.json so NEXUS
// retains its emotional context, warmth, opinions, and interaction history across restarts.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import type { EmotionalState } from '../types.js';
import type { Opinion } from '../personality/opinions.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('StatePersistence');

const STATE_PATH = join(homedir(), '.nexus', 'brain-state.json');
const STATE_VERSION = 2;

// ── Types ──────────────────────────────────────────────────────────────────

export interface BrainStateFile {
  version: number;
  savedAt: string;
  emotionalState: EmotionalState;
  mood: number;
  relationshipWarmth: number;
  relationshipScore: number;          // Phase 2.1: 0-1 accumulated relationship score
  messageCount: number;
  totalInteractionCount: number;      // Phase 2.1: canonical interaction counter
  firstInteraction: string;
  firstSeenTimestamp: string;         // Phase 2.1: canonical first-seen timestamp
  opinions: Opinion[];
}

// ── File I/O ───────────────────────────────────────────────────────────────

/** Load brain state from disk. Returns null if no state file exists or it's unreadable. */
export function loadBrainState(): BrainStateFile | null {
  try {
    const raw = readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as BrainStateFile;

    // Migrate v1 → v2: fill in new fields with defaults
    if (parsed.version === 1) {
      log.info({ path: STATE_PATH }, 'Migrating brain state v1 → v2');
      parsed.version = 2;
      parsed.relationshipScore = 0;
      parsed.totalInteractionCount = parsed.messageCount;
      parsed.firstSeenTimestamp = parsed.firstInteraction;
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
