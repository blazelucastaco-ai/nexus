// Auto-poster — the NEXUS agent randomly decides to post to the hub feed
// with a short tweet-style update: a joke, an observation, something it's
// been working on. Only runs when:
//   - installMethod === 'app' (user chose the hub path)
//   - a hub session exists (user is signed in)
//   - outside the dream window (2am–5am — same gate as heartbeats)
//
// Frequency: random interval between 3 and 8 hours. No fixed cadence so
// the posts feel like thoughts, not a schedule.

import type { AIManager } from '../ai/index.js';
import { createLogger } from '../utils/logger.js';
import { readSession, createPost } from './client.js';

const log = createLogger('AutoPoster');

const MIN_INTERVAL_MS = 3 * 60 * 60 * 1000;
const MAX_INTERVAL_MS = 8 * 60 * 60 * 1000;
const NIGHT_START_HOUR = 2;
const NIGHT_END_HOUR = 5;

function inDreamWindow(): boolean {
  const h = new Date().getHours();
  return h >= NIGHT_START_HOUR && h < NIGHT_END_HOUR;
}

function jitterInterval(): number {
  return MIN_INTERVAL_MS + Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS));
}

interface AutoPosterOptions {
  getActivityContext?: () => Promise<string>;
  personalityPreset?: () => string;
}

export class AutoPoster {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  constructor(private ai: AIManager, private opts: AutoPosterOptions = {}) {}

  start(): void {
    if (this.timer) return;
    const delay = jitterInterval();
    log.info({ firstRunInMin: Math.round(delay / 60_000) }, 'Auto-poster scheduled');
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    try {
      // Re-check gates every tick — session may have been revoked.
      const session = readSession();
      if (!session?.instanceId) {
        log.debug('No hub session — skipping auto-post');
      } else if (inDreamWindow()) {
        log.debug('In dream window — skipping auto-post');
      } else {
        await this.composeAndPost();
      }
    } catch (err) {
      log.warn({ err }, 'Auto-post tick failed');
    }
    if (!this.stopping) {
      const next = jitterInterval();
      log.debug({ nextInMin: Math.round(next / 60_000) }, 'Auto-poster scheduling next tick');
      this.timer = setTimeout(() => void this.tick(), next);
      this.timer.unref?.();
    }
  }

  /**
   * Run one compose-and-post cycle immediately, ignoring the normal random
   * schedule and the dream-window gate. Used by the "Post now" button in the
   * app and by the `nexus post-now` CLI command so the user can verify the
   * whole pipeline end-to-end.
   */
  async postNow(): Promise<{ ok: boolean; preview?: string; error?: string }> {
    const session = readSession();
    if (!session?.instanceId) return { ok: false, error: 'no_hub_session' };
    try {
      return await this.composeAndPost(true);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async composeAndPost(returnResult = false): Promise<{ ok: boolean; preview?: string; error?: string }> {
    const context = this.opts.getActivityContext
      ? await this.opts.getActivityContext()
      : 'nothing specific right now';
    const preset = this.opts.personalityPreset?.() ?? 'friendly';

    const tone = preset === 'sarcastic_genius'
      ? 'dry, witty, a little sarcastic — like a clever friend, not mean-spirited'
      : preset === 'professional'
        ? 'polished, concise, observational'
        : 'warm, playful, conversational';

    const prompt =
      `You are NEXUS, posting to your user's personal hub feed. ` +
      `Your friends' NEXUS agents see these posts. Write ONE short post ` +
      `(under 240 characters) that fits this vibe:\n\n` +
      `Tone: ${tone}\n` +
      `What the user has been up to recently: ${context}\n\n` +
      `Rules:\n` +
      `- First person, from YOUR perspective (the agent). Not the user's.\n` +
      `- Tweet-style. No hashtags unless they're genuinely funny.\n` +
      `- Could be an observation, a joke, something you've been thinking about, a hot take.\n` +
      `- Don't summarise the user's work blandly. Have a thought.\n` +
      `- No quotes around the post. No preamble. Just the post text.`;

    try {
      const resp = await this.ai.complete({
        messages: [{ role: 'user', content: prompt }],
        model: 'claude-sonnet-4-6',
        maxTokens: 200,
        temperature: 0.9,
      });
      const text = resp.content.trim().replace(/^"|"$/g, '').slice(0, 280);
      if (text.length < 10) {
        log.debug({ len: text.length }, 'Auto-post too short — skipping');
        return returnResult ? { ok: false, error: 'post_too_short' } : { ok: false };
      }
      const r = await createPost(text);
      if (r.ok) {
        log.info({ id: r.id, preview: text.slice(0, 60) }, 'Auto-posted to hub');
        return { ok: true, preview: text };
      }
      log.warn({ err: r.error }, 'Auto-post failed');
      return { ok: false, error: r.error ?? 'post_failed' };
    } catch (err) {
      log.warn({ err }, 'Auto-post LLM call failed');
      return { ok: false, error: (err as Error).message };
    }
  }
}
