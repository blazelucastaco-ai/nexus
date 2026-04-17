import { describe, it, expect, beforeEach, vi } from 'vitest';
import { events } from '../src/core/events.js';
import { traced, currentTraceId, setTraceAttrs, currentTrace } from '../src/core/trace.js';

describe('EventBus', () => {
  beforeEach(() => {
    events.clear();
  });

  it('delivers specific-type events to subscribers', () => {
    const handler = vi.fn();
    events.on('message.received', handler);

    events.emit({ type: 'message.received', chatId: '42', text: 'hi', textLen: 2 });

    expect(handler).toHaveBeenCalledOnce();
    const call = handler.mock.calls[0]?.[0];
    expect(call.type).toBe('message.received');
    expect(call.chatId).toBe('42');
    expect(call.emittedAt).toBeTypeOf('number');
  });

  it('does not deliver events to mismatched subscribers', () => {
    const handler = vi.fn();
    events.on('message.received', handler);

    events.emit({ type: 'tool.executed', toolName: 'read_file', success: true, durationMs: 10, resultLen: 100 });

    expect(handler).not.toHaveBeenCalled();
  });

  it('delivers to wildcard subscribers', () => {
    const all = vi.fn();
    events.onAny(all);

    events.emit({ type: 'message.received', chatId: '42', text: 'hi', textLen: 2 });
    events.emit({ type: 'tool.executed', toolName: 'read_file', success: true, durationMs: 10, resultLen: 100 });

    expect(all).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe stops delivery', () => {
    const handler = vi.fn();
    const sub = events.on('message.received', handler);

    sub.unsubscribe();
    events.emit({ type: 'message.received', chatId: '42', text: 'hi', textLen: 2 });

    expect(handler).not.toHaveBeenCalled();
  });

  it('handler throw does not break other subscribers', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    events.on('message.received', bad);
    events.on('message.received', good);

    events.emit({ type: 'message.received', chatId: '1', text: 'x', textLen: 1 });

    expect(bad).toHaveBeenCalledOnce();
    expect(good).toHaveBeenCalledOnce();
  });

  it('async handler rejection does not propagate', async () => {
    const rejecting = vi.fn(async () => { throw new Error('async boom'); });
    events.on('message.received', rejecting);

    // This must not throw:
    expect(() => {
      events.emit({ type: 'message.received', chatId: '1', text: 'x', textLen: 1 });
    }).not.toThrow();

    // Give async handlers a tick
    await new Promise((r) => setImmediate(r));
    expect(rejecting).toHaveBeenCalledOnce();
  });

  it('enriches events with current traceId', () => {
    const handler = vi.fn();
    events.on('message.received', handler);

    traced({ traceId: 'abc12345', chatId: '99' }, () => {
      events.emit({ type: 'message.received', chatId: '99', text: 'x', textLen: 1 });
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0].traceId).toBe('abc12345');
  });

  it('emits without traceId when no trace is active', () => {
    const handler = vi.fn();
    events.on('message.received', handler);

    events.emit({ type: 'message.received', chatId: '1', text: 'x', textLen: 1 });

    expect(handler.mock.calls[0]?.[0].traceId).toBeUndefined();
  });

  it('stats reports handler counts', () => {
    events.on('message.received', () => {});
    events.on('message.received', () => {});
    events.on('tool.executed', () => {});
    events.onAny(() => {});

    const stats = events.stats();
    const msg = stats.find((s) => s.type === 'message.received');
    const tool = stats.find((s) => s.type === 'tool.executed');
    const wild = stats.find((s) => s.type === '*');

    expect(msg?.handlerCount).toBe(2);
    expect(tool?.handlerCount).toBe(1);
    expect(wild?.handlerCount).toBe(1);
  });
});

describe('Trace context', () => {
  it('propagates through nested awaits', async () => {
    await traced({ traceId: 'outer-1', chatId: 'c1' }, async () => {
      expect(currentTraceId()).toBe('outer-1');

      await new Promise((r) => setTimeout(r, 1));
      expect(currentTraceId()).toBe('outer-1');

      await Promise.resolve().then(() => {
        expect(currentTraceId()).toBe('outer-1');
      });
    });
  });

  it('isolates concurrent traces', async () => {
    const results = await Promise.all([
      traced({ traceId: 't1' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentTraceId();
      }),
      traced({ traceId: 't2' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentTraceId();
      }),
    ]);

    expect(results).toEqual(['t1', 't2']);
  });

  it('setTraceAttrs merges attrs into current trace', async () => {
    await traced({ traceId: 'x' }, async () => {
      setTraceAttrs({ messageType: 'task', stepCount: 3 });
      const ctx = currentTrace();
      expect(ctx?.attrs.messageType).toBe('task');
      expect(ctx?.attrs.stepCount).toBe(3);
    });
  });

  it('returns undefined outside a trace', () => {
    expect(currentTraceId()).toBeUndefined();
    expect(currentTrace()).toBeUndefined();
  });
});
