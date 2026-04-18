import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolExecutor } from '../src/tools/executor.js';
import type { AgentManager } from '../src/agents/index.js';
import type { MemoryManager } from '../src/memory/index.js';

/**
 * FIND-CMP-03: the system prompt tells the LLM "file writes default to the
 * active project's directory" — but until this fix the executor had no way
 * to consult the active project. This test verifies the wiring works.
 */

describe('ToolExecutor write_file honors the active project path', () => {
  let tempRoot: string;
  let projectDir: string;
  let executor: ToolExecutor;
  const agents = {} as unknown as AgentManager;
  const memory = {} as unknown as MemoryManager;

  beforeEach(() => {
    // Use /tmp directly (not tmpdir() which returns /var/folders/... on macOS —
    // that's outside validateFilePath's allowed roots).
    tempRoot = mkdtempSync('/tmp/nexus-ap-test-');
    projectDir = join(tempRoot, 'my-project');
    executor = new ToolExecutor(agents, memory);
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('anchors a bare filename under the active project dir', async () => {
    executor.setActiveProjectPath(() => projectDir);
    const result = await executor.execute('write_file', {
      path: 'index.ts',
      content: 'export const x = 1;\n',
    });
    expect(result).toMatch(/written successfully|Wrote/i);
    const expected = join(projectDir, 'index.ts');
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, 'utf-8')).toContain('export const x = 1');
  });

  it('anchors a ./relative path under the active project dir', async () => {
    executor.setActiveProjectPath(() => projectDir);
    const result = await executor.execute('write_file', {
      path: './src/util.ts',
      content: 'export function u() {}\n',
    });
    expect(result).toMatch(/written successfully|Wrote/i);
    expect(existsSync(join(projectDir, 'src/util.ts'))).toBe(true);
  });

  it('leaves absolute paths untouched', async () => {
    executor.setActiveProjectPath(() => projectDir);
    const abs = join(tempRoot, 'elsewhere.txt');
    await executor.execute('write_file', {
      path: abs,
      content: 'hi\n',
    });
    expect(existsSync(abs)).toBe(true);
    // Must NOT have been re-rooted under projectDir
    expect(existsSync(join(projectDir, 'elsewhere.txt'))).toBe(false);
  });

  it('leaves ~-home paths untouched', async () => {
    executor.setActiveProjectPath(() => projectDir);
    // ~/nexus-workspace-test-... is in $HOME, which validateFilePath accepts,
    // and should NOT be re-anchored under projectDir.
    const homeRelative = '~/ap-test-' + Date.now() + '.txt';
    await executor.execute('write_file', { path: homeRelative, content: 'x' });
    // The test just verifies no "anchored" message fired and write proceeded.
    // (Cleanup of $HOME side-effect is handled by OS; file is tiny.)
    const home = process.env.HOME ?? '';
    const p = homeRelative.replace('~', home);
    expect(existsSync(p)).toBe(true);
    try { rmSync(p); } catch { /* ignore */ }
  });

  it('is a no-op when no active project is set', async () => {
    // Default: no resolver injected. A bare path resolve()s under cwd, which
    // during tests is the repo root. That trips either the home-or-tmp check
    // or (when cwd is inside the source tree) the self-protection guard —
    // both are correct refusals; the anchoring did NOT happen.
    const result = await executor.execute('write_file', {
      path: 'would-be-orphan.txt',
      content: 'x',
    });
    expect(result).toMatch(/outside allowed directories|Access denied|No path/i);
  });

  it('is a no-op when the resolver returns null', async () => {
    executor.setActiveProjectPath(() => null);
    const result = await executor.execute('write_file', {
      path: 'would-be-orphan.txt',
      content: 'x',
    });
    expect(result).toMatch(/outside allowed directories|Access denied/i);
  });
});
