import { describe, it, expect } from 'vitest';
import { ToolExecutor } from '../src/tools/executor.js';
import type { AgentManager } from '../src/agents/index.js';
import type { MemoryManager } from '../src/memory/index.js';

/**
 * FIND-TST-04: CRIT-3 removed the LLM-settable `confirmed=true` bypass for
 * DANGEROUS-tier commands — only the on-disk allowlist can unlock them.
 * These tests exercise the real approval-policy + approval-gate + executor
 * integration (no mocks on the gate) to prove the chain actually refuses
 * DANGEROUS commands and honors confirmed=true ONLY for the tiers where
 * it's appropriate.
 *
 * Safety: every DANGEROUS command used here is either a syntax-only match
 * (never actually reaches exec) or a no-op that would fail anyway.
 */

describe('approval-gate × run_terminal_command (FIND-TST-04)', () => {
  const agents = {} as unknown as AgentManager;
  const memory = {} as unknown as MemoryManager;

  it('BLOCKED tier: `rm -rf /` is refused regardless of confirmed', async () => {
    const executor = new ToolExecutor(agents, memory);
    const result = await executor.execute('run_terminal_command', {
      command: 'rm -rf /',
      confirmed: true,
    });
    expect(result).toMatch(/blocked|rejected|not allowed|dangerous/i);
    // Critically, it must NOT contain output from an actual `rm` call.
    expect(result).not.toMatch(/No such file|removed/i);
  });

  it('DANGEROUS tier: confirmed=true does NOT bypass (CRIT-3 fix)', async () => {
    const executor = new ToolExecutor(agents, memory);
    // A DANGEROUS pattern that's not in the blocklist — must still be refused.
    const result = await executor.execute('run_terminal_command', {
      command: 'sudo rm /tmp/nexus-test-should-not-run',
      confirmed: true, // LLM-settable flag — was the bypass vector
    });
    expect(result).toMatch(/dangerous|not allowed|refused|blocked/i);
    // The message should explain the proper escape (allowlist), not "re-run with confirmed=true".
    expect(result).not.toMatch(/re-run with confirmed=true|Reply with: run_terminal_command with confirmed=true/);
  });

  it('DANGEROUS tier: message NEVER instructs the LLM to re-run with confirmed=true', async () => {
    const executor = new ToolExecutor(agents, memory);
    // The message the LLM sees on a refused command must not train it to
    // self-confirm. This is the core property of the CRIT-3 fix.
    for (const cmd of [
      'chmod -R 777 /',
      'sudo rm -rf /tmp/nexus-should-not-run',
      'dd if=/dev/zero of=/dev/sda',
    ]) {
      const result = await executor.execute('run_terminal_command', { command: cmd });
      expect(result).toMatch(/dangerous|blocklist|high-risk|cannot be run|refused|blocked|rejected/i);
      expect(result).not.toMatch(/re-run with confirmed=true/i);
      expect(result).not.toMatch(/Reply with: run_terminal_command with confirmed=true/i);
    }
  });

  it('Argv blocklist: `shutdown` is refused even when chained behind a safe command', async () => {
    const executor = new ToolExecutor(agents, memory);
    // CRIT-1 fix: extractCommandHeads must catch `shutdown` on the right-hand
    // side of `;`, not just argv[0].
    const result = await executor.execute('run_terminal_command', {
      command: 'echo ok; shutdown -h now',
    });
    expect(result).toMatch(/dangerous|blocklist|high-risk|cannot be run|refused|blocked/i);
  });

  it('Argv blocklist: detects shutdown behind &&', async () => {
    const executor = new ToolExecutor(agents, memory);
    const result = await executor.execute('run_terminal_command', {
      command: 'true && shutdown -h now',
    });
    expect(result).toMatch(/dangerous|blocklist|high-risk|cannot be run|refused|blocked/i);
  });

  it('Argv blocklist: detects shutdown inside $()', async () => {
    const executor = new ToolExecutor(agents, memory);
    const result = await executor.execute('run_terminal_command', {
      command: 'echo $(shutdown -h now)',
    });
    expect(result).toMatch(/dangerous|blocklist|high-risk|cannot be run|refused|blocked/i);
  });

  it('SAFE tier: `echo hello` proceeds and returns actual output', async () => {
    const executor = new ToolExecutor(agents, memory);
    const result = await executor.execute('run_terminal_command', {
      command: 'echo nexus-approval-gate-test-ok',
    });
    // Real shell invocation — output should contain our marker.
    expect(result).toContain('nexus-approval-gate-test-ok');
  });

  it('Natural-language destructive-scope: `delete everything in ~` is blocked', async () => {
    const executor = new ToolExecutor(agents, memory);
    const result = await executor.execute('run_terminal_command', {
      command: 'delete everything in my home directory',
    });
    expect(result).toMatch(/data loss|won't execute|destructive/i);
  });
});
