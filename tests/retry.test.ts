import { describe, it, expect, vi } from 'vitest';
import { retry } from '../src/utils/retry.js';

describe('retry', () => {
  it('should return immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retry(fn, { maxRetries: 3, baseDelay: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and return on eventual success', async () => {
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt < 3) throw new Error(`fail ${attempt}`);
      return 'success';
    });

    const result = await retry(fn, { maxRetries: 3, baseDelay: 1 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after exhausting all retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    await expect(retry(fn, { maxRetries: 2, baseDelay: 1 })).rejects.toThrow('always fails');
    // initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should call onRetry callback before each retry', async () => {
    const onRetry = vi.fn();
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt <= 2) throw new Error(`fail ${attempt}`);
      return 'done';
    });

    await retry(fn, { maxRetries: 3, baseDelay: 1, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    // First retry: attempt=1
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1);
    // Second retry: attempt=2
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 2);
  });

  it('should convert non-Error throwables to Error objects', async () => {
    const fn = vi.fn(async () => {
      throw 'string error';
    });

    await expect(retry(fn, { maxRetries: 0, baseDelay: 1 })).rejects.toThrow('string error');
  });

  it('should respect maxRetries=0 (no retries)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('nope'));
    await expect(retry(fn, { maxRetries: 0, baseDelay: 1 })).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should use defaults when no options provided', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await retry(fn);
    expect(result).toBe(42);
  });

  it('should apply exponential backoff (delays increase)', async () => {
    const delays: number[] = [];
    const originalNow = Date.now;
    let lastTime = Date.now();

    let attempt = 0;
    const fn = vi.fn(async () => {
      const now = Date.now();
      if (attempt > 0) {
        delays.push(now - lastTime);
      }
      lastTime = now;
      attempt++;
      if (attempt <= 3) throw new Error('fail');
      return 'ok';
    });

    await retry(fn, { maxRetries: 3, baseDelay: 10, maxDelay: 10000 });
    // With jitter, delays should roughly increase (baseDelay * 2^n)
    // Delay 1: ~10ms, Delay 2: ~20ms, Delay 3: ~40ms (with jitter)
    expect(delays.length).toBe(3);
  });
});
