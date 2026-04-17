import { describe, it, expect } from 'vitest';
import { extractCommandHeads, anyHeadBlocked } from '../src/security/shell-parser.js';

describe('extractCommandHeads', () => {
  it('returns the single head for a simple command', () => {
    expect(extractCommandHeads('ls -la')).toEqual(['ls']);
  });

  it('returns heads from a ; chain', () => {
    expect(extractCommandHeads('echo hi; rm -rf /tmp/x')).toEqual(['echo', 'rm']);
  });

  it('returns heads from && chain', () => {
    expect(extractCommandHeads('npm install && npm test')).toEqual(['npm']);
  });

  it('returns heads from || chain', () => {
    expect(extractCommandHeads('cmd1 || cmd2')).toEqual(['cmd1', 'cmd2']);
  });

  it('returns heads from single-pipe (not split as two pipes)', () => {
    expect(extractCommandHeads('cat file | grep x')).toEqual(['cat', 'grep']);
  });

  it('handles mixed operators', () => {
    expect(extractCommandHeads('a && b; c | d || e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('extracts heads from $() substitutions', () => {
    const heads = extractCommandHeads('echo $(hostname)');
    expect(heads).toContain('echo');
    expect(heads).toContain('hostname');
  });

  it('extracts heads from backtick substitutions', () => {
    const heads = extractCommandHeads('echo `whoami`');
    expect(heads).toContain('echo');
    expect(heads).toContain('whoami');
  });

  it('ignores env-var assignments', () => {
    expect(extractCommandHeads('DEBUG=1 FOO=bar myapp --flag')).toEqual(['myapp']);
  });

  it('is empty for empty / whitespace input', () => {
    expect(extractCommandHeads('')).toEqual([]);
    expect(extractCommandHeads('   ')).toEqual([]);
  });

  it('strips surrounding quotes on heads', () => {
    expect(extractCommandHeads("'ls' -la")).toEqual(['ls']);
  });

  it('handles |& (stderr pipe)', () => {
    expect(extractCommandHeads('build |& tee log')).toEqual(['build', 'tee']);
  });

  it('handles background & ', () => {
    expect(extractCommandHeads('server & tail -f log')).toEqual(['server', 'tail']);
  });

  it('deduplicates repeated heads', () => {
    expect(extractCommandHeads('cat a; cat b; cat c')).toEqual(['cat']);
  });

  it('is safe against nested substitutions (best-effort, no infinite loop)', () => {
    // Nested substitutions — our non-nesting regex only catches the inner one,
    // but the function should NOT hang.
    const heads = extractCommandHeads('echo $(echo $(whoami))');
    expect(heads).toContain('echo');
  });
});

describe('anyHeadBlocked', () => {
  const blocklist = new Set(['shutdown', 'reboot', 'mkfs']);

  it('catches blocklisted head as first token', () => {
    const result = anyHeadBlocked('shutdown -h now', blocklist);
    expect(result.blocked).toBe(true);
    expect(result.head).toBe('shutdown');
  });

  it('catches blocklisted head hidden by ; chain (the critical bug)', () => {
    const result = anyHeadBlocked('echo ok; shutdown -h now', blocklist);
    expect(result.blocked).toBe(true);
    expect(result.head).toBe('shutdown');
  });

  it('catches blocklisted head hidden in $()', () => {
    const result = anyHeadBlocked('echo $(reboot)', blocklist);
    expect(result.blocked).toBe(true);
    expect(result.head).toBe('reboot');
  });

  it('catches blocklisted head after &&', () => {
    const result = anyHeadBlocked('npm install && mkfs /dev/sda1', blocklist);
    expect(result.blocked).toBe(true);
    expect(result.head).toBe('mkfs');
  });

  it('allows benign chains', () => {
    expect(anyHeadBlocked('ls -la; echo done', blocklist).blocked).toBe(false);
    expect(anyHeadBlocked('npm install && npm test', blocklist).blocked).toBe(false);
  });
});
