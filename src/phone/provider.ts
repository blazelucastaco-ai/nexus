import type { PhoneConfig, TelephonyProvider } from './types.js';

/**
 * Build the telephony provider for the configured vendor.
 *
 * The recommended implementation is **LiveKit**: a SIP trunk (from Twilio/Telnyx)
 * routes the call into a LiveKit room; a LiveKit voice agent joins, streams the
 * caller's audio to STT and NEXUS's ElevenLabs audio back into the room, and uses VAD
 * for barge-in. The agent maps onto the TelephonyProvider interface in `types.ts`
 * — `start/dial/sendAudio/interrupt/hangup` and the lifecycle callbacks — so the
 * PhoneGateway (already built + tested) drives it unchanged.
 *
 * Implementing it needs the `@livekit/agents` SDK + your provisioned account/trunk
 * (see PHONE_SETUP.md). Until that's wired this throws a clear next-step message,
 * which the daemon logs and then keeps running — the phone stays dormant, nothing
 * else is affected.
 */
export async function createTelephonyProvider(config: PhoneConfig): Promise<TelephonyProvider> {
  throw new Error(
    `Telephony provider "${config.provider}" is configured but not built yet. ` +
    `Implement TelephonyProvider (recommended: LiveKit agent) and return it here — see PHONE_SETUP.md.`,
  );
}
