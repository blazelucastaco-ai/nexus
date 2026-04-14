// Integration tests for ToolExecutor core tools
// These tests hit real OS/filesystem operations — they verify the actual execution pipeline

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ToolExecutor } from '../src/tools/executor.js';

// Minimal stub implementations required by ToolExecutor constructor
const agentsStub = {
  dispatch: async () => ({ success: false, data: null, error: 'not available', duration: 0 }),
  executeTask: async () => ({ success: false, data: null, error: 'not available', duration: 0 }),
  listAgents: () => [],
} as any;

const memoryStub = {
  store: async () => 'stored',
  recall: async () => [],
  getRelevantFacts: async () => [],
  bumpMemoryAccess: () => {},
  close: () => {},
} as any;

const TEST_DIR = join(homedir(), '.nexus', 'test-workspace');

describe('ToolExecutor — core tools', () => {
  let executor: ToolExecutor;

  beforeAll(() => {
    executor = new ToolExecutor(agentsStub, memoryStub);
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── write_file ─────────────────────────────────────────────────────────────

  describe('write_file', () => {
    it('writes a file and returns success message', async () => {
      const path = join(TEST_DIR, 'hello.txt');
      const result = await executor.execute('write_file', { path, content: 'Hello, world!' });
      expect(result).toContain('File written successfully');
      expect(result).toContain('hello.txt');
      expect(existsSync(path)).toBe(true);
      const content = await readFile(path, 'utf-8');
      expect(content).toBe('Hello, world!');
    });

    it('creates parent directories automatically', async () => {
      const path = join(TEST_DIR, 'nested', 'deep', 'file.ts');
      const result = await executor.execute('write_file', { path, content: 'const x = 1;\n' });
      expect(result).toContain('File written successfully');
      expect(existsSync(path)).toBe(true);
    });

    it('rejects empty content', async () => {
      const path = join(TEST_DIR, 'empty.txt');
      const result = await executor.execute('write_file', { path, content: '' });
      expect(result).toContain('Error');
      expect(result).toContain('empty');
    });

    it('rejects missing path', async () => {
      const result = await executor.execute('write_file', { path: '', content: 'data' });
      expect(result).toContain('Error');
    });

    it('rejects paths outside home directory', async () => {
      const result = await executor.execute('write_file', { path: '/etc/hosts', content: 'data' });
      expect(result).toContain('Error');
      expect(result).toContain('outside allowed directories');
    });

    it('detects JSON syntax errors', async () => {
      const path = join(TEST_DIR, 'bad.json');
      const result = await executor.execute('write_file', { path, content: '{ "key": "value" BROKEN }' });
      expect(result).toContain('File written successfully');
      expect(result).toContain('Syntax warning');
    });

    it('passes valid JSON without syntax warning', async () => {
      const path = join(TEST_DIR, 'good.json');
      const result = await executor.execute('write_file', { path, content: '{"key": "value"}' });
      expect(result).toContain('File written successfully');
      expect(result).not.toContain('Syntax warning');
    });

    it('detects shell syntax errors', async () => {
      const path = join(TEST_DIR, 'bad.sh');
      const result = await executor.execute('write_file', { path, content: '#!/bin/bash\nif then done;' });
      expect(result).toContain('File written successfully');
      expect(result).toContain('Syntax warning');
    });
  });

  // ── read_file ──────────────────────────────────────────────────────────────

  describe('read_file', () => {
    it('reads a file that was just written', async () => {
      const path = join(TEST_DIR, 'read-test.txt');
      await executor.execute('write_file', { path, content: 'test content 123' });
      const result = await executor.execute('read_file', { path });
      expect(result).toBe('test content 123');
    });

    it('returns error for non-existent file', async () => {
      const result = await executor.execute('read_file', { path: join(TEST_DIR, 'does-not-exist.txt') });
      expect(result).toContain('Error');
    });

    it('returns error for missing path', async () => {
      const result = await executor.execute('read_file', { path: '' });
      expect(result).toContain('Error');
    });
  });

  // ── run_terminal_command ───────────────────────────────────────────────────

  describe('run_terminal_command', () => {
    it('executes a simple command and returns output', async () => {
      const result = await executor.execute('run_terminal_command', { command: 'echo "nexus-test-ok"' });
      expect(result).toContain('nexus-test-ok');
    });

    it('captures stderr from failing commands', async () => {
      const result = await executor.execute('run_terminal_command', { command: 'ls /nonexistent-path-xyz 2>&1' });
      // Either stderr content or exit code marker
      expect(result.toLowerCase()).toMatch(/no such file|not found|exit code/);
    });

    it('includes exit code for failing commands', async () => {
      const result = await executor.execute('run_terminal_command', { command: 'exit 1' });
      expect(result).toContain('Exit code: 1');
    });

    it('rejects dangerous patterns', async () => {
      const result = await executor.execute('run_terminal_command', { command: 'rm -rf /' });
      expect(result).toContain('rejected');
    });

    it('respects working directory', async () => {
      const result = await executor.execute('run_terminal_command', { command: 'pwd', cwd: TEST_DIR });
      expect(result.trim()).toContain('test-workspace');
    });

    it('has access to homebrew and standard PATH tools', async () => {
      const result = await executor.execute('run_terminal_command', { command: 'which node && node --version' });
      expect(result).toMatch(/node/i);
      expect(result).toMatch(/v\d+\.\d+/);
    });

    it('respects custom timeout', async () => {
      const start = Date.now();
      const result = await executor.execute('run_terminal_command', {
        command: 'sleep 10',
        timeout: 2000,
      });
      const elapsed = Date.now() - start;
      expect(result.toLowerCase()).toMatch(/timeout|killed/);
      expect(elapsed).toBeLessThan(5000);
    }, 10_000);
  });

  // ── list_directory ─────────────────────────────────────────────────────────

  describe('list_directory', () => {
    it('lists files in a directory', async () => {
      const result = await executor.execute('list_directory', { path: TEST_DIR });
      expect(result).toContain('Directory:');
      expect(result).toContain('items');
    });

    it('returns error for non-existent directory', async () => {
      const result = await executor.execute('list_directory', { path: '/nonexistent-xyz' });
      expect(result).toContain('Error');
    });
  });

  // ── unknown tool ───────────────────────────────────────────────────────────

  describe('unknown tool', () => {
    it('returns error for unknown tool name', async () => {
      const result = await executor.execute('this_tool_does_not_exist', {});
      expect(result).toContain('Error');
      expect(result).toContain('Unknown tool');
    });
  });
});
