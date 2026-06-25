// PhoneGateway — the NEXUS side of a phone call.
//
// Provider-agnostic: a TelephonyProvider (LiveKit/Twilio/Telnyx) carries the call
// audio + transcribes the caller; this gateway routes every turn through the SAME
// orchestrator.handleMessage the Telegram and web gateways use (one brain, one
// memory, one personality), speaks the reply with the ElevenLabs voice, and
// handles barge-in. Per-caller chatId isolation means each user reaches their own
// NEXUS and only their own.

import { createLogger } from '../utils/logger.js';
import type { PhoneCall, PhoneConfig, ProviderHandlers, TelephonyProvider } from './types.js';

const log = createLogger('Phone');

/** Minimal shape of the orchestrator we depend on (keeps the gateway decoupled). */
export interface PhoneBrain {
  handleMessage(
    chatId: string,
    text: string,
    onToken?: (chunk: string) => void,
    onStatus?: (status: string) => void,
    opts?: { voice?: boolean },
  ): Promise<string>;
}

/** Minimal shape of the TTS service (the same ElevenLabs service the web uses). */
export interface PhoneTts {
  synthesize(text: string, style?: 'bright' | 'measured' | 'neutral'): Promise<Buffer | null>;
}

interface CallSession {
  call: PhoneCall;
  chatId: string;
  /** Aborts the in-flight reply when the caller barges in. */
  speaking: AbortController | null;
}

export class PhoneGateway {
  private readonly sessions = new Map<string, CallSession>();

  constructor(
    private readonly brain: PhoneBrain,
    private readonly tts: PhoneTts,
    private readonly provider: TelephonyProvider,
    private readonly config: PhoneConfig,
    private readonly baseChatId: string,
  ) {}

  async start(): Promise<void> {
    const handlers: ProviderHandlers = {
      onCall: (call) => this.onCall(call),
      onCallerSpeech: (callId, text) => void this.onCallerTurn(callId, text),
      onBargeIn: (callId) => void this.onBargeIn(callId),
      onHangup: (callId) => { this.sessions.delete(callId); },
      onVoicemail: (callId) => void this.onVoicemail(callId),
    };
    await this.provider.start(handlers);
    log.info({ provider: this.provider.name, number: this.config.number, mapping: this.config.mapping }, 'Phone gateway live');
  }

  async stop(): Promise<void> {
    await this.provider.stop().catch(() => { /* best effort */ });
    this.sessions.clear();
  }

  /** Isolate memory per caller so every user reaches their own NEXUS and only
   * their own — a hard multi-user/security requirement. */
  private chatIdFor(callerId: string): string {
    return `${this.baseChatId}:phone:${callerId}`;
  }

  private onCall(call: PhoneCall): void {
    this.sessions.set(call.id, { call, chatId: this.chatIdFor(call.callerId), speaking: null });
    log.info({ id: call.id, direction: call.direction }, 'call connected');
  }

  /** Caller said something → run it through the one brain → speak the reply. */
  private async onCallerTurn(callId: string, text: string): Promise<void> {
    const s = this.sessions.get(callId);
    if (!s || !text.trim()) return;
    try {
      const reply = await this.brain.handleMessage(s.chatId, text, undefined, undefined, { voice: true });
      if (reply.trim()) await this.speak(callId, reply);
    } catch (err) {
      log.warn({ err, callId }, 'phone turn failed');
    }
  }

  /** Synthesize with the same ElevenLabs British voice and play it into the call.
   * Abortable so a barge-in cuts it off cleanly. */
  private async speak(callId: string, text: string): Promise<void> {
    const s = this.sessions.get(callId);
    if (!s) return;
    const ac = new AbortController();
    s.speaking = ac;
    const wav = await this.tts.synthesize(text);
    if (ac.signal.aborted || !wav) return;
    await this.provider.sendAudio(callId, wav); // provider down-samples to 8 kHz
    if (s.speaking === ac) s.speaking = null;
  }

  /** Caller cut in while NEXUS was talking → stop and listen, like a real person. */
  private async onBargeIn(callId: string): Promise<void> {
    const s = this.sessions.get(callId);
    if (s?.speaking) { s.speaking.abort(); s.speaking = null; }
    await this.provider.interrupt(callId).catch(() => { /* best effort */ });
  }

  /** NEXUS rings a user with a reason ("heads up, the trading bot just hit its
   * stop"), then it's a normal conversation. Hangs up cleanly on voicemail. */
  async callUser(toNumber: string, reason: string): Promise<void> {
    const call = await this.provider.dial(toNumber);
    this.onCall(call);
    await this.speak(call.id, reason);
  }

  private async onVoicemail(callId: string): Promise<void> {
    // The opening line (the reason) has already been spoken; leave it as the
    // voicemail and hang up. A fuller "leave a tailored message" pass can be
    // added once the provider's voicemail-beep detection is wired.
    await this.provider.hangup(callId).catch(() => { /* best effort */ });
    this.sessions.delete(callId);
  }

  /** Test/diagnostic visibility. */
  get activeCalls(): number {
    return this.sessions.size;
  }
}
