import { describe, it, expect, vi } from 'vitest';
import { CapabilityKernel, type SubsystemManifest } from '../src/core/capability.js';

describe('CapabilityKernel', () => {
  it('boots subsystems in dependency order', async () => {
    const kernel = new CapabilityKernel();
    const order: string[] = [];

    kernel.register({
      name: 'c',
      provides: ['c'],
      requires: ['b'],
      init: () => { order.push('c'); return { kind: 'c' }; },
    });
    kernel.register({
      name: 'a',
      provides: ['a'],
      init: () => { order.push('a'); return { kind: 'a' }; },
    });
    kernel.register({
      name: 'b',
      provides: ['b'],
      requires: ['a'],
      init: () => { order.push('b'); return { kind: 'b' }; },
    });

    await kernel.boot();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('passes resolved deps to init', async () => {
    const kernel = new CapabilityKernel();

    kernel.register({
      name: 'a',
      provides: ['a'],
      init: () => ({ name: 'A' }),
    });
    const bInit = vi.fn((deps: Record<string, unknown>) => ({ name: 'B', aRef: deps.a }));
    kernel.register({
      name: 'b',
      provides: ['b'],
      requires: ['a'],
      init: bInit,
    });

    await kernel.boot();

    expect(bInit).toHaveBeenCalledOnce();
    const passed = bInit.mock.calls[0]?.[0];
    expect(passed?.a).toEqual({ name: 'A' });
  });

  it('calls start() after all init() complete', async () => {
    const kernel = new CapabilityKernel();
    const order: string[] = [];

    kernel.register({
      name: 'a',
      provides: ['a'],
      init: () => { order.push('init-a'); return {}; },
      start: () => { order.push('start-a'); },
    });
    kernel.register({
      name: 'b',
      provides: ['b'],
      requires: ['a'],
      init: () => { order.push('init-b'); return {}; },
      start: () => { order.push('start-b'); },
    });

    await kernel.boot();
    expect(order).toEqual(['init-a', 'init-b', 'start-a', 'start-b']);
  });

  it('shuts down in reverse order', async () => {
    const kernel = new CapabilityKernel();
    const order: string[] = [];

    kernel.register({ name: 'a', provides: ['a'], init: () => ({}), stop: () => { order.push('stop-a'); } });
    kernel.register({ name: 'b', provides: ['b'], requires: ['a'], init: () => ({}), stop: () => { order.push('stop-b'); } });
    kernel.register({ name: 'c', provides: ['c'], requires: ['b'], init: () => ({}), stop: () => { order.push('stop-c'); } });

    await kernel.boot();
    await kernel.shutdown();

    expect(order).toEqual(['stop-c', 'stop-b', 'stop-a']);
  });

  it('throws on missing dependency', async () => {
    const kernel = new CapabilityKernel();
    kernel.register({
      name: 'needy',
      provides: ['needy'],
      requires: ['missing'],
      init: () => ({}),
    });

    await expect(kernel.boot()).rejects.toThrow(/requires 'missing'/);
  });

  it('throws on dependency cycle', async () => {
    const kernel = new CapabilityKernel();
    kernel.register({ name: 'a', provides: ['a'], requires: ['b'], init: () => ({}) });
    kernel.register({ name: 'b', provides: ['b'], requires: ['a'], init: () => ({}) });

    await expect(kernel.boot()).rejects.toThrow(/cycle/i);
  });

  it('throws on duplicate capability', async () => {
    const kernel = new CapabilityKernel();
    kernel.register({ name: 'x', provides: ['shared'], init: () => ({}) });
    kernel.register({ name: 'y', provides: ['shared'], init: () => ({}) });

    await expect(kernel.boot()).rejects.toThrow(/provided by multiple/);
  });

  it('get() returns the initialized capability', async () => {
    const kernel = new CapabilityKernel();
    kernel.register({ name: 'a', provides: ['a'], init: () => ({ kind: 'A' }) });

    await kernel.boot();
    expect(kernel.get('a')).toEqual({ kind: 'A' });
    expect(kernel.has('a')).toBe(true);
  });

  it('get() throws for missing capability', async () => {
    const kernel = new CapabilityKernel();
    await kernel.boot();
    expect(() => kernel.get('missing')).toThrow();
  });

  it('cannot register after boot starts', async () => {
    const kernel = new CapabilityKernel();
    kernel.register({ name: 'a', provides: ['a'], init: () => ({}) });
    await kernel.boot();
    expect(() => kernel.register({ name: 'b', provides: ['b'], init: () => ({}) })).toThrow();
  });

  it('continues shutdown if one subsystem stop() throws', async () => {
    const kernel = new CapabilityKernel();
    const order: string[] = [];
    kernel.register({
      name: 'a',
      provides: ['a'],
      init: () => ({}),
      stop: () => { order.push('stop-a'); throw new Error('a failed'); },
    });
    kernel.register({
      name: 'b',
      provides: ['b'],
      init: () => ({}),
      stop: () => { order.push('stop-b'); },
    });

    await kernel.boot();
    await kernel.shutdown();

    // Both stops were called even though a threw
    expect(order).toContain('stop-a');
    expect(order).toContain('stop-b');
  });

  it('supports async init and start', async () => {
    const kernel = new CapabilityKernel();
    const order: string[] = [];

    kernel.register({
      name: 'a',
      provides: ['a'],
      init: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('init');
        return {};
      },
      start: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('start');
      },
    });

    await kernel.boot();
    expect(order).toEqual(['init', 'start']);
  });
});
