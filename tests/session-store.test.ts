import { describe, it, expect, afterAll } from 'vitest';
import { appendTurn, loadSession } from '../src/core/session-store.js';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TEST_CHAT_ID = 'test_session_store_vitest_12345';
const SESSION_FILE = join(homedir(), '.nexus', 'sessions', `${TEST_CHAT_ID}.jsonl`);

afterAll(() => {
  // Clean up test session file
  try { if (existsSync(SESSION_FILE)) rmSync(SESSION_FILE); } catch { /* ignore */ }
});

describe('SessionStore', () => {
  describe('appendTurn', () => {
    it('should append a turn without throwing', async () => {
      await expect(appendTurn(TEST_CHAT_ID, [
        { role: 'user', content: 'Hello NEXUS' },
        { role: 'assistant', content: 'Hello! How can I help?' },
      ])).resolves.not.toThrow();
    });

    it('should create the session file', async () => {
      await appendTurn(TEST_CHAT_ID, [
        { role: 'user', content: 'Test message' },
      ]);
      expect(existsSync(SESSION_FILE)).toBe(true);
    });

    it('should handle empty message arrays', async () => {
      await expect(appendTurn(TEST_CHAT_ID, [])).resolves.not.toThrow();
    });

    it('should sanitize special chars in chatId', async () => {
      const specialId = 'test/chat:id@123';
      await expect(appendTurn(specialId, [
        { role: 'user', content: 'Message' },
      ])).resolves.not.toThrow();
      // Clean up
      const sanitized = specialId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const path = join(homedir(), '.nexus', 'sessions', `${sanitized}.jsonl`);
      try { if (existsSync(path)) rmSync(path); } catch { /* ignore */ }
    });
  });

  describe('loadSession', () => {
    it('should return empty array for nonexistent session', () => {
      const messages = loadSession('definitely_nonexistent_chat_id_xyz_9999');
      expect(messages).toEqual([]);
    });

    it('should return the messages that were appended', async () => {
      const chatId = `${TEST_CHAT_ID}_load`;
      const sessionPath = join(homedir(), '.nexus', 'sessions', `${chatId}.jsonl`);

      await appendTurn(chatId, [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
      ]);

      const messages = loadSession(chatId, 20);
      expect(messages.length).toBeGreaterThan(0);
      const userMsg = messages.find((m) => m.content === 'First question');
      expect(userMsg).toBeDefined();

      // Clean up
      try { if (existsSync(sessionPath)) rmSync(sessionPath); } catch { /* ignore */ }
    });

    it('should respect the lastN limit', async () => {
      const chatId = `${TEST_CHAT_ID}_limit`;
      const sessionPath = join(homedir(), '.nexus', 'sessions', `${chatId}.jsonl`);

      // Append 10 turns
      for (let i = 0; i < 10; i++) {
        await appendTurn(chatId, [
          { role: 'user', content: `Message ${i}` },
          { role: 'assistant', content: `Response ${i}` },
        ]);
      }

      const limited = loadSession(chatId, 3);
      // Each turn has 2 messages; limit=3 means last 3 turns = 6 messages max
      // The function limits by turns, so result should be ≤ 3 turns worth
      expect(limited.length).toBeLessThanOrEqual(6);

      // Clean up
      try { if (existsSync(sessionPath)) rmSync(sessionPath); } catch { /* ignore */ }
    });
  });
});
