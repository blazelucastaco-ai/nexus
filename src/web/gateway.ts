// Jarvis web gateway — the second "door" into the one NEXUS brain.
//
// This is the web peer of TelegramGateway. It does NOT fork any state: it calls
// the same orchestrator.handleMessage() on the same chatId, so memory, the live
// conversation thread, and history are shared with Telegram by construction. It
// also subscribes to the typed event bus and translates the brain's live
// activity (tools, tasks, dreams, proactive nudges, heartbeat, model-driven UI
// directives) into frames the orb UI renders in real time.
//
// What must NOT break (from the integration review):
//   - Empty-string return from handleMessage means "already sent directly" — we
//     never render an empty assistant bubble.
//   - redactSelfDisclosure() is the per-channel security boundary (self-
//     protection L5). Telegram applies it inside sendMessage; the web channel
//     applies it here, on every assistant/notice string it emits.

import { createLogger } from '../utils/logger.js';
import { events, type NexusEvent, type Subscription } from '../core/events.js';
import { redactSelfDisclosure } from '../core/self-protection.js';
import type { TtsService, TtsStyle } from './tts.js';
import type { WebServer } from './server.js';
import type { OrbState, ServerFrame } from './protocol.js';

const log = createLogger('WebGateway');

/**
 * The slice of the orchestrator the web channel needs. Kept structural so this
 * module doesn't pull the whole orchestrator graph into its type closure.
 */
export interface WebBrain {
  handleMessage(
    chatId: string,
    text: string,
    onToken?: (chunk: string) => void,
    onStatus?: (status: string) => void,
    opts?: { voice?: boolean },
  ): Promise<string>;
}

export class WebGateway {
  private sub: Subscription | null = null;
  private lastMood = 0; // -1..+1, from heartbeat; tilts the spoken voice style

  constructor(
    private readonly brain: WebBrain,
    private readonly server: WebServer,
    private readonly chatId: string,
    private readonly tts?: TtsService,
  ) {}

  start(): void {
    this.server.onMessage((frame) => {
      if (frame.t === 'listening') {
        // Reflect mic state on the orb immediately (local + any other clients).
        this.server.broadcast({ t: 'orb', state: frame.on ? 'listening' : 'idle', ttlMs: frame.on ? 0 : 0 });
        return;
      }
      if (frame.t === 'user_message') {
        void this.handleUserMessage(frame.text.trim());
      }
    });

    this.sub = events.onAny((e) => this.onBusEvent(e));
    log.info({ chatId: this.chatId }, 'Web gateway attached to the brain');
  }

  stop(): void {
    this.sub?.unsubscribe();
    this.sub = null;
  }

  // ── Inbound: browser → brain ─────────────────────────────────────────────────

  /**
   * Run a transcribed voice command (native on-device STT, delivered by the
   * wake helper) through the same brain as a typed message, and broadcast it.
   */
  submitUserText(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.server.broadcast({ t: 'user_echo', text: t });
    void this.handleUserMessage(t);
  }

  private async handleUserMessage(text: string): Promise<void> {
    if (!text) return;
    this.server.broadcast({ t: 'orb', state: 'thinking' });
    this.server.broadcast({ t: 'status', text: 'thinking…' });
    // Speak an instant "on it" the moment the request lands — never dead air
    // while the brain (and any tools) do the real work. The answer queues behind it.
    void this.speakAck();

    const onToken = (chunk: string) => this.server.broadcast({ t: 'token', delta: chunk });
    const onStatus = (status: string) => this.server.broadcast({ t: 'status', text: status });

    try {
      const raw = await this.brain.handleMessage(this.chatId, text, onToken, onStatus, { voice: true });
      // Empty return = the brain already replied out-of-band (e.g. a task that
      // streams progress). Don't render an empty bubble — the activity feed and
      // orb already reflect what happened.
      const out = redactSelfDisclosure(raw ?? '').trim();
      if (out) {
        this.server.broadcast({ t: 'assistant', text: out, final: true });
        void this.speakReply(out);
      }
    } catch (err) {
      log.warn({ err }, 'web handleMessage failed');
      this.server.broadcast({ t: 'assistant', text: 'Something went wrong handling that — check the daemon logs.', final: true });
    } finally {
      this.server.broadcast({ t: 'status', text: '' });
      this.server.broadcast({ t: 'orb', state: 'idle' });
    }
  }

  /** Map the current mood (-1..+1) to an overall voice character. */
  private moodStyle(): TtsStyle {
    if (this.lastMood > 0.25) return 'bright';
    if (this.lastMood < -0.2) return 'measured';
    return 'neutral';
  }

  // Jarvis-register instant acknowledgments (web channel only) — the immediate
  // "I heard you, Sir" before the brain has the answer. Refined, composed, brief.
  private static readonly ACK_PHRASES = [
    'Right away, Sir.',
    'Of course, Sir.',
    'One moment, Sir.',
    'At once, Sir.',
    'Certainly, Sir.',
    'Consider it done, Sir.',
    'Let me see to that, Sir.',
  ];

  /** Speak an immediate, varied acknowledgment so the user always knows they were
   * heard the instant they ask — before the brain has even started working. */
  private async speakAck(): Promise<void> {
    if (!this.tts) return;
    const phrase =
      WebGateway.ACK_PHRASES[Math.floor(Math.random() * WebGateway.ACK_PHRASES.length)] ?? 'one sec.';
    try {
      const buffer = await this.tts.synthesize(phrase, 'bright');
      if (buffer) {
        const id = this.server.putTts(buffer, this.tts.outputMime);
        this.server.broadcast({ t: 'audio', url: `/tts/${id}.${this.tts.outputExt}`, text: phrase });
      }
    } catch {
      /* the ack is best-effort */
    }
  }

  /** Synthesize the real reply and queue it to play right after the ack. */
  private async speakReply(text: string): Promise<void> {
    if (!this.tts) return;
    try {
      const buffer = await this.tts.synthesize(text, this.moodStyle());
      if (buffer) {
        const id = this.server.putTts(buffer, this.tts.outputMime);
        this.server.broadcast({ t: 'audio', url: `/tts/${id}.${this.tts.outputExt}`, text, queue: true });
      } else {
        log.warn({ len: text.length, style: this.moodStyle() }, 'tts produced no audio for reply');
      }
    } catch (err) {
      log.warn({ err }, 'tts synth failed');
    }
  }

  // ── Outbound: brain activity → orb ──────────────────────────────────────────

  private orb(state: OrbState, ttlMs?: number, intensity?: number): void {
    this.server.broadcast({ t: 'orb', state, ttlMs, intensity });
  }

  private onBusEvent(e: NexusEvent & { traceId?: string; emittedAt: number }): void {
    // Cheap exit when no browser is attached (server.broadcast also guards).
    if (!this.server.hasClients) return;

    switch (e.type) {
      case 'ui.directive':
        this.server.broadcast({ t: 'ui', kind: e.kind, payload: e.payload });
        return;

      case 'message.received':
        this.orb('thinking');
        return;
      case 'message.completed':
        this.orb('idle');
        this.server.broadcast({ t: 'status', text: '' });
        return;

      case 'tool.executed':
        if (e.toolName.startsWith('ui_')) return; // UI tools surface via their directive, not the feed
        this.server.broadcast({ t: 'activity', kind: 'tool', label: humanTool(e.toolName), ok: e.success });
        this.orb('tool', 1400);
        return;
      case 'tool.error':
        this.server.broadcast({ t: 'activity', kind: 'tool', label: humanTool(e.toolName), detail: e.error, ok: false });
        this.orb('tool', 1400);
        return;

      case 'task.planned':
        this.server.broadcast({ t: 'activity', kind: 'task', label: `Planning: ${e.title}`, detail: `${e.stepCount} steps` });
        this.orb('task');
        return;
      case 'task.started':
        this.server.broadcast({ t: 'activity', kind: 'task', label: `Started: ${e.title}` });
        this.orb('task');
        return;
      case 'task.step.started':
        this.server.broadcast({ t: 'activity', kind: 'task', label: `→ ${e.stepTitle}` });
        this.orb('task', 4000);
        return;
      case 'task.step.completed':
        this.server.broadcast({ t: 'activity', kind: 'task', label: `Step ${e.stepId} ${e.success ? 'done' : 'failed'}`, ok: e.success });
        return;
      case 'task.step.failed':
        this.server.broadcast({ t: 'activity', kind: 'task', label: `Step ${e.stepId} failed (try ${e.attempt})`, detail: e.error, ok: false });
        return;
      case 'task.completed':
        this.server.broadcast({ t: 'activity', kind: 'task', label: `${e.success ? 'Completed' : 'Gave up on'}: ${e.title}`, ok: e.success });
        this.orb('idle');
        return;
      case 'task.cowork.consulted':
        this.server.broadcast({ t: 'activity', kind: 'task', label: 'Phoned a friend', detail: e.suggestion });
        return;

      case 'dream.started':
        this.server.broadcast({ t: 'activity', kind: 'dream', label: 'Dreaming…' });
        this.orb('dreaming');
        return;
      case 'dream.completed':
        this.server.broadcast({ t: 'activity', kind: 'dream', label: 'Dream complete', detail: `${e.reflections} reflections, ${e.ideas} ideas` });
        this.orb('idle');
        return;
      case 'dream.reflection':
        this.notice('dream', e.text);
        return;

      case 'proactive.alert':
        this.notice('warn', e.message);
        this.orb('alert', 2600);
        return;
      case 'proactive.idle-idea':
        this.notice('idea', e.ideaPreview);
        return;

      case 'heartbeat':
        this.lastMood = e.mood;
        this.server.broadcast({ t: 'heartbeat', mood: e.mood, uptimeSec: e.uptimeSec, memoryCount: e.memoryCount });
        return;

      default:
        return;
    }
  }

  private notice(level: 'info' | 'warn' | 'idea' | 'dream', text: string): void {
    const safe = redactSelfDisclosure(text ?? '').trim();
    if (safe) this.server.broadcast({ t: 'notice', level, text: safe });
  }
}

/** Human-friendly label for a tool name in the activity feed. */
function humanTool(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
