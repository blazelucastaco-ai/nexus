import { describe, it, expect, vi } from 'vitest';
import { PhoneGateway } from '../src/phone/gateway.js';
import { loadPhoneConfig } from '../src/phone/types.js';
import type { TelephonyProvider, ProviderHandlers, PhoneCall, PhoneConfig } from '../src/phone/types.js';

function makeMockProvider() {
  let handlers: ProviderHandlers | undefined;
  const sent: Array<{ callId: string; bytes: number }> = [];
  const interrupted: string[] = [];
  const provider: TelephonyProvider = {
    name: 'mock',
    async start(h) { handlers = h; },
    async stop() { /* noop */ },
    async dial(to) { return { id: 'out1', callerId: to, direction: 'outbound', startedAt: 0 }; },
    async sendAudio(callId, wav) { sent.push({ callId, bytes: wav.length }); },
    async interrupt(callId) { interrupted.push(callId); },
    async hangup() { /* noop */ },
  };
  return { provider, get handlers() { return handlers!; }, sent, interrupted };
}

const CONFIG: PhoneConfig = { provider: 'livekit', number: '+15550000000', credentials: {}, mapping: 'shared' };
const ttsOk = () => ({ synthesize: vi.fn(async () => Buffer.alloc(1000)) });

describe('PhoneGateway', () => {
  it('routes an inbound caller turn through the one brain (voice) and speaks the reply', async () => {
    const m = makeMockProvider();
    const brain = { handleMessage: vi.fn(async () => 'alright, it is 66 and clear out.') };
    const tts = ttsOk();
    const gw = new PhoneGateway(brain, tts, m.provider, CONFIG, 'base');
    await gw.start();
    m.handlers.onCall({ id: 'c1', callerId: '+15551112222', direction: 'inbound', startedAt: 0 });
    m.handlers.onCallerSpeech('c1', "what's the weather");
    await vi.waitFor(() => expect(m.sent.length).toBe(1));
    expect(brain.handleMessage).toHaveBeenCalledWith('base:phone:+15551112222', "what's the weather", undefined, undefined, { voice: true });
    expect(tts.synthesize).toHaveBeenCalled();
    expect(m.sent[0]).toMatchObject({ callId: 'c1', bytes: 1000 });
  });

  it('isolates memory per caller (each user reaches only their own NEXUS)', async () => {
    const m = makeMockProvider();
    const seen: string[] = [];
    const brain = { handleMessage: vi.fn(async (chatId: string) => { seen.push(chatId); return 'ok'; }) };
    const gw = new PhoneGateway(brain, ttsOk(), m.provider, CONFIG, 'base');
    await gw.start();
    m.handlers.onCall({ id: 'a', callerId: '+1111', direction: 'inbound', startedAt: 0 });
    m.handlers.onCall({ id: 'b', callerId: '+2222', direction: 'inbound', startedAt: 0 });
    m.handlers.onCallerSpeech('a', 'hi');
    m.handlers.onCallerSpeech('b', 'hi');
    await vi.waitFor(() => expect(seen.length).toBe(2));
    expect(seen).toContain('base:phone:+1111');
    expect(seen).toContain('base:phone:+2222');
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('barge-in interrupts the provider', async () => {
    const m = makeMockProvider();
    const brain = { handleMessage: vi.fn(async () => 'a long reply') };
    const gw = new PhoneGateway(brain, ttsOk(), m.provider, CONFIG, 'base');
    await gw.start();
    m.handlers.onCall({ id: 'c1', callerId: '+1', direction: 'inbound', startedAt: 0 });
    m.handlers.onBargeIn('c1');
    await vi.waitFor(() => expect(m.interrupted).toContain('c1'));
  });

  it('places an outbound call and opens with the reason', async () => {
    const m = makeMockProvider();
    const brain = { handleMessage: vi.fn(async () => '') };
    const tts = ttsOk();
    const gw = new PhoneGateway(brain, tts, m.provider, CONFIG, 'base');
    await gw.start();
    await gw.callUser('+15559998888', 'heads up, the trading bot just hit its stop for the day.');
    expect(tts.synthesize).toHaveBeenCalledWith('heads up, the trading bot just hit its stop for the day.');
    expect(m.sent.length).toBe(1);
  });
});

describe('loadPhoneConfig', () => {
  it('returns null when not configured (dormant — daemon runs without phone)', () => {
    expect(loadPhoneConfig({})).toBeNull();
  });
  it('parses livekit config from env', () => {
    const c = loadPhoneConfig({
      NEXUS_PHONE_PROVIDER: 'livekit', NEXUS_PHONE_NUMBER: '+15551234567',
      LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's',
    });
    expect(c).toMatchObject({ provider: 'livekit', number: '+15551234567', mapping: 'shared' });
  });
  it('returns null when livekit creds are incomplete', () => {
    expect(loadPhoneConfig({ NEXUS_PHONE_PROVIDER: 'livekit', NEXUS_PHONE_NUMBER: '+1' })).toBeNull();
  });
});
