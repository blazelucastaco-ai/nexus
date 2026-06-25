import { describe, it, expect, vi } from 'vitest';
import { WebGateway, getToolAck } from '../src/web/gateway.js';

// The two ack registers, mirrored from gateway.ts for membership assertions.
const FETCH = ['One moment, Sir — pulling that up.', 'Let me pull that up.', 'Fetching that now, Sir.'];
const CHECK = ['Let me take a look.', 'One moment — let me check.', 'Let me have a look, Sir.'];
const TASK = ['On it.', 'Right away, Sir.', 'Consider it done, Sir.'];
const GENERIC = ['One moment, Sir.', 'Give me a second, Sir.', 'Just a moment, Sir.'];

type Brain = (chatId: string, text: string, onToken?: (c: string) => void, onStatus?: (s: string, t?: string) => void) => Promise<string>;

function harness(handleMessage: Brain) {
  const synthesize = vi.fn().mockResolvedValue(Buffer.from('audio'));
  const server = { broadcast: vi.fn(), putTts: () => 'id', onMessage: vi.fn() } as never;
  const tts = { synthesize, outputMime: 'audio/mpeg', outputExt: 'mp3' } as never;
  const gw = new WebGateway({ handleMessage } as never, server, 'web-chat', tts);
  return { gw, synthesize };
}
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};
// Drive one full voice turn through the (private) handler and let the fire-and-forget
// ack/reply synths settle.
const turn = async (gw: WebGateway, text: string) => {
  await (gw as unknown as { handleUserMessage(t: string): Promise<void> }).handleUserMessage(text);
  await flush();
};

describe('voice-turn ack gating', () => {
  it('simple/conversational turn → ONE reply, no preamble (synthesize once, with the reply)', async () => {
    // brain answers straight away — never reports a tool status
    const { gw, synthesize } = harness(async () => 'Not much, Sir, keeping an eye on things.');
    await turn(gw, "what's up");
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize.mock.calls[0]?.[0]).toBe('Not much, Sir, keeping an eye on things.');
  });

  it('real-work turn → contextual ack + the answer (synthesize twice; ack fits the work)', async () => {
    const { gw, synthesize } = harness(async (_c, _t, _ot, onStatus) => {
      onStatus?.('let me look that up…', 'web_search'); // the brain goes off to fetch
      return "It's 66 and clear out, Sir.";
    });
    await turn(gw, "what's the weather");
    expect(synthesize).toHaveBeenCalledTimes(2);
    const spoken = synthesize.mock.calls.map((c) => c[0]);
    expect(spoken).toContain("It's 66 and clear out, Sir.");
    const ack = spoken.find((s) => s !== "It's 66 and clear out, Sir.");
    expect(FETCH).toContain(ack); // "pulling that up", not a canned "let me see to that"
  });

  it('only the FIRST tool trips the ack (one ack per turn, even with several tools)', async () => {
    const { gw, synthesize } = harness(async (_c, _t, _ot, onStatus) => {
      onStatus?.('reading…', 'read_file');
      onStatus?.('running…', 'run_terminal_command');
      return 'Done, Sir.';
    });
    await turn(gw, 'do the thing');
    expect(synthesize).toHaveBeenCalledTimes(2); // one ack + one reply, not three
    const ack = synthesize.mock.calls.map((c) => c[0]).find((s) => s !== 'Done, Sir.');
    expect(CHECK).toContain(ack); // matched to the first tool (read_file)
  });
});

describe('getToolAck categories', () => {
  it('maps each tool kind to the right register, and stays silent for `speak`', () => {
    expect(FETCH).toContain(getToolAck('web_search'));
    expect(CHECK).toContain(getToolAck('read_file'));
    expect(TASK).toContain(getToolAck('write_file'));
    expect(TASK).toContain(getToolAck('browser_click'));
    expect(getToolAck('speak')).toBe('');
    expect(GENERIC).toContain(getToolAck(undefined));
    expect(GENERIC).toContain(getToolAck('some_unknown_tool'));
  });
});
