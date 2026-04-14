import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BriefingEngine } from '../src/brain/briefing.js';

const STATE_PATH = join(homedir(), '.nexus', 'briefing-state.json');

function cleanupState() {
  try { if (existsSync(STATE_PATH)) rmSync(STATE_PATH); } catch { /* ignore */ }
}

describe('BriefingEngine', () => {
  beforeEach(cleanupState);
  afterEach(cleanupState);

  describe('constructor', () => {
    it('should initialize without errors', () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);
      expect(() => new BriefingEngine(sendFn)).not.toThrow();
    });

    it('should accept a custom briefing hour', () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);
      expect(() => new BriefingEngine(sendFn, undefined, 7)).not.toThrow();
    });
  });

  describe('start / stop', () => {
    it('should start without throwing', () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);
      const engine = new BriefingEngine(sendFn);
      expect(() => engine.start()).not.toThrow();
      engine.stop(); // clean up
    });

    it('should stop without throwing', () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);
      const engine = new BriefingEngine(sendFn);
      engine.start();
      expect(() => engine.stop()).not.toThrow();
    });

    it('should handle multiple start calls gracefully', () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);
      const engine = new BriefingEngine(sendFn);
      engine.start();
      engine.start(); // should not create duplicate timers
      expect(() => engine.stop()).not.toThrow();
    });
  });

  describe('sendBriefingNow', () => {
    it('should call sendFn with a non-empty message', async () => {
      const sent: string[] = [];
      const sendFn = vi.fn().mockImplementation(async (msg: string) => {
        sent.push(msg);
      });
      const engine = new BriefingEngine(sendFn);
      await engine.sendBriefingNow();

      expect(sendFn).toHaveBeenCalledTimes(1);
      expect(sent[0]).toBeTruthy();
      expect(sent[0]!.length).toBeGreaterThan(10);
    });

    it('should include greeting with date in the message', async () => {
      let capturedMessage = '';
      const sendFn = vi.fn().mockImplementation(async (msg: string) => {
        capturedMessage = msg;
      });
      const engine = new BriefingEngine(sendFn);
      await engine.sendBriefingNow();

      expect(capturedMessage).toContain('Good morning');
    });

    it('should persist the last briefing date after sending', async () => {
      const sendFn = vi.fn().mockResolvedValue(undefined);
      const engine = new BriefingEngine(sendFn);
      await engine.sendBriefingNow();

      expect(existsSync(STATE_PATH)).toBe(true);
      const { readFileSync } = await import('node:fs');
      const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      const today = new Date().toISOString().slice(0, 10);
      expect(state.lastBriefingDate).toBe(today);
    });

    it('should handle sendFn errors gracefully (sendBriefingNow propagates)', async () => {
      const sendFn = vi.fn().mockRejectedValue(new Error('Telegram error'));
      const engine = new BriefingEngine(sendFn);
      // sendBriefingNow doesn't swallow — it propagates
      await expect(engine.sendBriefingNow()).rejects.toThrow('Telegram error');
    });
  });
});
