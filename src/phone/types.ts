// Telephony integration types.
//
// NEXUS treats the phone as another door into the ONE brain — same orchestrator,
// same memory, same British voice — exactly like the Telegram and web gateways.
// The PROVIDER (LiveKit / Twilio / Telnyx) carries the call audio + STT/VAD; the
// PhoneGateway owns the NEXUS side: who's on the line, routing each turn through
// the brain, speaking the reply with the local voice, and barge-in. See
// PHONE_SETUP.md for provisioning + the LiveKit provider implementation.

/** Provider-agnostic phone config, read from the environment. */
export interface PhoneConfig {
  provider: 'livekit' | 'twilio' | 'telnyx';
  /** The provisioned number shown as caller ID (E.164, e.g. +15551234567). */
  number: string;
  /** Provider credentials (provider-specific; read from env). */
  credentials: Record<string, string>;
  /** 'shared' = one number, NEXUS identifies who's on the line by caller ID;
   * 'per-user' = each user has their own number. Either way, memory is isolated
   * per caller so every user reaches their own NEXUS and only their own. */
  mapping: 'shared' | 'per-user';
}

/** A live call, inbound or outbound. */
export interface PhoneCall {
  id: string;
  callerId: string; // the human's E.164 number
  direction: 'inbound' | 'outbound';
  startedAt: number;
}

/** Callbacks the gateway gives the provider to drive a call's lifecycle. */
export interface ProviderHandlers {
  onCall: (call: PhoneCall) => void;
  /** A final chunk of transcribed caller speech. */
  onCallerSpeech: (callId: string, text: string) => void;
  /** Caller started talking while NEXUS was speaking → barge-in. */
  onBargeIn: (callId: string) => void;
  onHangup: (callId: string) => void;
  onVoicemail: (callId: string) => void;
}

/** What a provider must implement to carry NEXUS calls. Implemented per-vendor —
 * the LiveKit implementation (recommended) is documented in PHONE_SETUP.md. */
export interface TelephonyProvider {
  readonly name: string;
  /** Begin accepting inbound calls; wires the lifecycle callbacks. */
  start(handlers: ProviderHandlers): Promise<void>;
  stop(): Promise<void>;
  /** Place an outbound call; resolves once it rings/connects. */
  dial(toNumber: string): Promise<PhoneCall>;
  /** Speak audio into a live call (the provider down-samples to the 8 kHz phone
   * band on the way out). */
  sendAudio(callId: string, wav: Buffer): Promise<void>;
  /** Stop any audio currently playing on the call (barge-in). */
  interrupt(callId: string): Promise<void>;
  hangup(callId: string): Promise<void>;
}

/** Read phone config from the environment. Returns null when not configured — the
 * daemon then runs WITHOUT the phone (dormant), exactly like the web gateway when
 * its port is busy. Nothing else is affected. */
export function loadPhoneConfig(env: NodeJS.ProcessEnv = process.env): PhoneConfig | null {
  const provider = env.NEXUS_PHONE_PROVIDER as PhoneConfig['provider'] | undefined;
  const number = env.NEXUS_PHONE_NUMBER;
  if (!provider || !number) return null;
  const credentials: Record<string, string> = {};
  if (provider === 'livekit') {
    const url = env.LIVEKIT_URL;
    const key = env.LIVEKIT_API_KEY;
    const secret = env.LIVEKIT_API_SECRET;
    if (!url || !key || !secret) return null;
    Object.assign(credentials, { url, key, secret });
  } else {
    const key = env.PHONE_API_KEY;
    if (!key) return null;
    Object.assign(credentials, { key, secret: env.PHONE_API_SECRET ?? '' });
  }
  const mapping = (env.NEXUS_PHONE_MAPPING as PhoneConfig['mapping']) === 'per-user' ? 'per-user' : 'shared';
  return { provider, number, credentials, mapping };
}
