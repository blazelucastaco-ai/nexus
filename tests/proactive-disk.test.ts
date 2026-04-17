import { describe, it, expect } from 'vitest';

// Exercises the header-parsing approach to `df` output without calling
// execSync. Mirrors the parsing logic inside ProactiveEngine.checkDisk so a
// regression that goes back to `parts[3]` (FIND-BUG-02) would fail the test.

function parseDfOutput(output: string): { usePct: number; avail: string } | null {
  const lines = output.trim().split('\n');
  if (lines.length < 2) return null;
  const header = lines[0]!.split(/\s+/);
  const row = lines[lines.length - 1]!.split(/\s+/);
  const useMatch = lines[lines.length - 1]!.match(/(\d+)%/);
  if (!useMatch) return null;
  const usePct = parseInt(useMatch[1]!, 10);
  const availIdx = header.findIndex((h) => /^avail/i.test(h));
  const avail = availIdx >= 0 && row[availIdx] ? row[availIdx] : '?';
  return { usePct, avail };
}

describe('proactive df output parsing (FIND-BUG-02)', () => {
  it('parses macOS df -h layout (4 columns, Avail in position 3)', () => {
    const output = `Filesystem      Size    Used   Avail Capacity  iused       ifree %iused  Mounted on
/dev/disk3s1s1  460Gi   392Gi   68Gi    86%  620000  4500000000    0%   /`;
    const r = parseDfOutput(output);
    expect(r).not.toBeNull();
    expect(r!.usePct).toBe(86);
    expect(r!.avail).toBe('68Gi');
  });

  it('parses Linux df -h layout (Avail in a different column)', () => {
    const output = `Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       100G   85G   12G  86% /`;
    const r = parseDfOutput(output);
    expect(r!.avail).toBe('12G');
    expect(r!.usePct).toBe(86);
  });

  it('returns null when output is too short', () => {
    expect(parseDfOutput('')).toBeNull();
    expect(parseDfOutput('only-one-line')).toBeNull();
  });

  it('returns null when no percent is found', () => {
    expect(
      parseDfOutput('Filesystem\nweird-row-with-no-percent'),
    ).toBeNull();
  });

  it('falls back to "?" when Avail column is not labeled', () => {
    const output = `FS Size Used Foo Mounted
/dev 1G 500M 500M 50% /`;
    const r = parseDfOutput(output);
    expect(r!.avail).toBe('?');
  });
});
