# NEXUS Phone — setup, provisioning & compliance

The phone is a third door into the **one** NEXUS — same brain, same memory, same
British voice, same personality — exactly like Telegram and the Jarvis web screen.
You call the number and talk to NEXUS; NEXUS can call you with a reason.

**What's already built (and tested):** the NEXUS side. `src/phone/gateway.ts`
(`PhoneGateway`) routes every call turn through the same `orchestrator.handleMessage`
the other channels use, speaks the reply with the ElevenLabs voice, isolates
memory per caller (each user reaches only their own NEXUS), supports barge-in, and
places outbound calls with a reason. It's wired into the daemon (`src/index.ts`),
**dormant and non-fatal** until configured. Covered by `tests/phone-gateway.test.ts`.

**What needs YOU (can't be automated):** provisioning a real number requires a paid
telephony account, a payment method, and carrier registration — financial/legal
steps only you can take. Then one provider module connects the call audio to the
gateway. That's the only remaining piece, and the steps are below.

---

## 1. Architecture (recommended: LiveKit)

```
caller ──PSTN──▶ SIP trunk (Twilio/Telnyx) ──▶ LiveKit SIP ──▶ LiveKit room
                                                                    │
                                              LiveKit voice agent ──┘
                                              (STT ⇄ NEXUS brain ⇄ ElevenLabs TTS, VAD barge-in)
                                                          │ implements
                                                          ▼
                                              TelephonyProvider  ──▶  PhoneGateway ──▶ orchestrator (one brain)
```

**Why LiveKit:** it's purpose-built for real-time voice agents, treats the phone as
just another channel (fits NEXUS exactly), handles WebRTC/SIP transport, the 8 kHz
phone-codec conversion, and VAD-based barge-in. Twilio (best docs) or Telnyx
(cheaper, multi-country, built for scale) work too — they'd provide the SIP trunk
under LiveKit, or you implement `TelephonyProvider` directly against their Media
Streams / call-control APIs.

## 2. Provision (your accounts)

1. **LiveKit** — create a LiveKit Cloud project (or self-host). Note `LIVEKIT_URL`,
   `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
2. **A number + SIP trunk** — buy a number from Twilio or Telnyx and point a SIP
   trunk at LiveKit's SIP endpoint (LiveKit docs: "SIP inbound/outbound trunk").
3. **Register the number** so calls aren't flagged as spam and show real caller ID:
   **10DLC** brand + campaign (US local numbers) or **toll-free verification**.
   This is mandatory for production and takes carrier review time.

## 3. Configure (env)

```bash
NEXUS_PHONE_PROVIDER=livekit
NEXUS_PHONE_NUMBER=+15551234567        # E.164, your provisioned number
NEXUS_PHONE_MAPPING=shared             # 'shared' (one number, NEXUS IDs the caller) | 'per-user'
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

With these set, the daemon loads the config (`loadPhoneConfig`) and tries to start
the gateway. Until the provider (step 4) is built it logs a clear next-step and keeps
running; nothing else is affected.

## 4. Build the provider (the one remaining module)

Implement `TelephonyProvider` (see `src/phone/types.ts`) and return it from
`createTelephonyProvider` in `src/phone/provider.ts`. With LiveKit's agents SDK
(`@livekit/agents` + a plugin for STT, e.g. Deepgram/Whisper) the mapping is direct:

| `TelephonyProvider` | LiveKit agent |
|---|---|
| `start(handlers)` | join rooms for inbound calls; on participant audio → STT → `handlers.onCallerSpeech`; VAD speech-start while NEXUS speaks → `handlers.onBargeIn` |
| `dial(toNumber)` | create a SIP outbound call → room; return the `PhoneCall` |
| `sendAudio(callId, wav)` | publish the synthesized audio as an audio track (down-sample to 8 kHz) |
| `interrupt(callId)` | stop the published track immediately |
| `hangup(callId)` | end the SIP participant |

The `PhoneGateway` already drives all of this — you only translate these five calls
+ the lifecycle callbacks to LiveKit. Keep latency tight: phone calls have no buffer,
so stream TTS and start playback on the first chunk.

## 5. Multi-user & security

- Memory is isolated per caller by `chatId = base:phone:<E.164>`, so every user
  reaches their own NEXUS and only their own — already enforced in the gateway.
- `shared` mapping: one number, NEXUS identifies the caller by their number.
  `per-user`: each user has their own number. Pick per your distribution model.
- Authenticate the caller before exposing anything sensitive (e.g. a known-number
  allowlist, or a spoken PIN for unknown numbers).

## 6. Compliance (not optional for a real product)

- **Outbound consent** — get clear prior consent before NEXUS ever calls a user;
  record the consent and honour opt-out/STOP.
- **AI disclosure** — disclose that the caller is talking to an AI where required
  (several jurisdictions mandate it). Add it to the greeting.
- **Call-recording consent** — if you record, follow one-/two-party consent rules
  for the caller's jurisdiction; announce recording where required.
- **Number registration** — 10DLC / toll-free verification (step 2.3) so calls
  aren't blocked or spam-labelled.
- **Rate/scale** — provision trunk capacity and concurrency for your expected
  simultaneous calls; the gateway is stateless per-call and scales horizontally.

---

**Status:** NEXUS-side built + tested and wired in (dormant). Provisioning (your
accounts + registration) and the one provider module are the remaining steps to go
live. Once you have a LiveKit account + number, I can implement the provider and we
test it against a real call.
