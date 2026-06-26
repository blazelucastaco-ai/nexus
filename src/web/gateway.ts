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
import type { WebTransport } from './transport.js';
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
    onStatus?: (status: string, toolName?: string) => void,
    opts?: { voice?: boolean },
  ): Promise<string>;
}

// ── Contextual acknowledgments ───────────────────────────────────────────────
// Spoken ONLY when NEXUS is actually about to go do something, and matched to the
// KIND of work — pulling something up vs. checking something vs. a real task —
// rather than one canned phrase. Dry, composed, in the moment; a little variety so
// repeats don't feel scripted. Categorized by the first tool the brain reaches for.
const FETCH_TOOLS = new Set([
  'web_search', 'web_fetch', 'crawl_url', 'get_weather', 'read_calendar', 'check_email', 'check_updates',
]);
const CHECK_TOOLS = new Set([
  'read_file', 'list_directory', 'recall', 'get_system_info', 'introspect', 'read_pdf',
  'understand_image', 'take_screenshot', 'browser_screenshot', 'transcribe_audio',
]);
const TASK_TOOLS = new Set([
  'write_file', 'run_terminal_command', 'run_background_command', 'remember', 'generate_image', 'export_session',
]);
const FETCH_ACKS = ['One moment, Sir — pulling that up.', 'Let me pull that up.', 'Fetching that now, Sir.'];
const CHECK_ACKS = ['Let me take a look.', 'One moment — let me check.', 'Let me have a look, Sir.'];
const TASK_ACKS = ['On it.', 'Right away, Sir.', 'Consider it done, Sir.'];
const GENERIC_ACKS = ['One moment, Sir.', 'Give me a second, Sir.', 'Just a moment, Sir.'];

function pickAck(list: readonly string[]): string {
  return list[Math.floor(Math.random() * list.length)] ?? list[0]!;
}

/** A brief, in-the-moment Jarvis acknowledgment that fits the kind of work the brain
 * is about to do (identified by the first tool it runs). `undefined` → a neutral
 * "one moment"; the silent `speak` tool → no ack at all. Exported for tests. */
export function getToolAck(toolName?: string): string {
  if (!toolName || toolName === 'speak') return toolName === 'speak' ? '' : pickAck(GENERIC_ACKS);
  if (FETCH_TOOLS.has(toolName)) return pickAck(FETCH_ACKS);
  if (CHECK_TOOLS.has(toolName)) return pickAck(CHECK_ACKS);
  if (TASK_TOOLS.has(toolName)) return pickAck(TASK_ACKS);
  if (toolName.startsWith('browser_')) return pickAck(TASK_ACKS); // a browser action = doing something
  return pickAck(GENERIC_ACKS);
}

export class WebGateway {
  private sub: Subscription | null = null;
  private lastMood = 0; // -1..+1, from heartbeat; tilts the spoken voice style
  /** Set when this turn put a visual on the Stage → synth the reply WITH word
   *  timestamps so the diagram reveals lock to the voice. Reset each turn. */
  private sawVisual = false;

  constructor(
    private readonly brain: WebBrain,
    private readonly server: WebTransport,
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
    this.sawVisual = false; // reset; set if this turn puts a visual on the Stage
    this.server.broadcast({ t: 'orb', state: 'thinking' });
    this.server.broadcast({ t: 'status', text: 'thinking…' });

    const onToken = (chunk: string) => this.server.broadcast({ t: 'token', delta: chunk });
    // Acknowledge OUT LOUD only when the brain actually goes off to DO something. The
    // first tool status is that signal — the brain reports status only while using
    // tools, never for an answer it can give straight away. So simple / conversational
    // turns get ONE clean reply with no preamble and nothing a beat later; only real
    // lookups/tasks get the "one moment…" + answer, and the ack is matched to the work.
    let acked = false;
    const onStatus = (status: string, toolName?: string) => {
      this.server.broadcast({ t: 'status', text: status });
      if (!acked) {
        acked = true;
        void this.speakAck(toolName);
      }
    };

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

  /** Build an audio frame for the active transport: a `/tts/<id>` URL when it serves
   *  loopback HTTP (the desktop browser), or the clip bytes embedded as base64 (the
   *  phone, over the P2P data channel — there is no loopback HTTP there). */
  private audioFrame(
    buffer: Buffer,
    text: string,
    extra: { queue?: boolean; align?: { text: string; times: number[] } } = {},
  ): ServerFrame {
    const mime = this.tts?.outputMime ?? 'audio/mpeg';
    if (this.server.servesHttp) {
      const id = this.server.putTts(buffer, mime);
      return { t: 'audio', url: `/tts/${id}.${this.tts?.outputExt ?? 'mp3'}`, text, ...extra };
    }
    return { t: 'audio', audioB64: buffer.toString('base64'), mime, text, ...extra };
  }

  /** Speak a brief acknowledgment — ONLY when NEXUS is actually about to go do
   * something (a lookup / check / task), and matched to the kind of work via
   * `getToolAck`, never the same canned line. Best-effort. */
  private async speakAck(toolName?: string): Promise<void> {
    if (!this.tts) return;
    const phrase = getToolAck(toolName);
    if (!phrase) return; // e.g. the `speak` tool — don't acknowledge speaking
    try {
      const buffer = await this.tts.synthesize(phrase, 'bright');
      if (buffer) this.server.broadcast(this.audioFrame(buffer, phrase));
    } catch {
      /* the ack is best-effort */
    }
  }

  /** Synthesize the real reply and queue it to play right after the ack. */
  private async speakReply(text: string): Promise<void> {
    if (!this.tts) return;
    try {
      // When this turn put a visual on the Stage, synth WITH per-character timestamps
      // so the diagram reveals lock to the voice. Any failure → plain synth below.
      if (this.sawVisual) {
        const r = await this.tts.synthesizeWithAlignment(text, this.moodStyle());
        if (r?.buffer) {
          this.server.broadcast(this.audioFrame(r.buffer, text, { queue: true, align: r.align ?? undefined }));
          return;
        }
      }
      const buffer = await this.tts.synthesize(text, this.moodStyle());
      if (buffer) {
        this.server.broadcast(this.audioFrame(buffer, text, { queue: true }));
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
        if (e.kind === 'visual') this.sawVisual = true; // → reply synth carries word timestamps
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
