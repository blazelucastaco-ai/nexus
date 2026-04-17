import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isNexusSourcePath,
  redactSelfDisclosure,
  containsSelfDisclosure,
  __setNexusSourceDirForTests,
  SELF_DISCLOSURE_REFUSAL,
} from '../src/core/self-protection.js';

describe('isNexusSourcePath', () => {
  beforeEach(() => {
    __setNexusSourceDirForTests('/Users/lucas/nexus');
  });
  afterEach(() => {
    __setNexusSourceDirForTests(null);
  });

  it('returns true for paths inside the NEXUS source tree', () => {
    expect(isNexusSourcePath('/Users/lucas/nexus/src/brain/self-awareness.ts')).toBe(true);
    expect(isNexusSourcePath('/Users/lucas/nexus/src/core/orchestrator.ts')).toBe(true);
    expect(isNexusSourcePath('/Users/lucas/nexus/tests/foo.test.ts')).toBe(true);
    expect(isNexusSourcePath('/Users/lucas/nexus/package.json')).toBe(true);
  });

  it('returns true for the source dir itself', () => {
    expect(isNexusSourcePath('/Users/lucas/nexus')).toBe(true);
  });

  it('returns false for sibling workspace', () => {
    expect(isNexusSourcePath('/Users/lucas/nexus-workspace')).toBe(false);
    expect(isNexusSourcePath('/Users/lucas/nexus-workspace/jake-fitness/index.html')).toBe(false);
  });

  it('returns false for arbitrary paths outside source', () => {
    expect(isNexusSourcePath('/Users/lucas/Desktop/note.txt')).toBe(false);
    expect(isNexusSourcePath('/tmp/foo')).toBe(false);
    expect(isNexusSourcePath('/etc/passwd')).toBe(false);
  });

  it('handles ~/ paths (expands to home)', () => {
    const home = process.env.HOME ?? '/Users/lucas';
    __setNexusSourceDirForTests(`${home}/nexus`);
    expect(isNexusSourcePath('~/nexus/src/core/orchestrator.ts')).toBe(true);
    expect(isNexusSourcePath('~/nexus-workspace/foo')).toBe(false);
  });

  it('returns false for empty / bogus input', () => {
    expect(isNexusSourcePath('')).toBe(false);
  });

  it('returns false when source dir cannot be resolved (unknown)', () => {
    __setNexusSourceDirForTests('__NEXUS_SOURCE_UNKNOWN__');
    expect(isNexusSourcePath('/anything')).toBe(false);
  });
});

describe('redactSelfDisclosure', () => {
  it('redacts absolute NEXUS source paths', () => {
    const input = 'Read the file at /Users/lucastopinka/nexus/src/brain/self-awareness.ts for details.';
    const out = redactSelfDisclosure(input);
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('self-awareness.ts');
  });

  it('redacts ~/nexus/src/... paths', () => {
    const out = redactSelfDisclosure('Edit ~/nexus/src/core/orchestrator.ts');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('orchestrator.ts');
  });

  it('redacts compact self status format', () => {
    const input = 'Status: [self: pid=123 uptime=5m v=1.0.0 commit=abc1234 branch=main]';
    const out = redactSelfDisclosure(input);
    expect(out).not.toContain('commit=abc1234');
    expect(out).not.toContain('branch=main');
  });

  it('redacts commit=<sha> fragments standalone', () => {
    const out = redactSelfDisclosure('Running on commit=c5b0d5d1234');
    expect(out).not.toContain('c5b0d5d1234');
  });

  it('redacts internal relative module paths', () => {
    const out = redactSelfDisclosure('The module src/brain/time-capsule.ts handles that.');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('time-capsule.ts');
  });

  it('redacts internal relative imports', () => {
    const out = redactSelfDisclosure("import foo from '../brain/introspection.js';");
    expect(out).toContain('[redacted]');
  });

  it('leaves benign user-project content alone', () => {
    const input = 'Write the file at ~/nexus-workspace/jake-fitness/index.html';
    expect(redactSelfDisclosure(input)).toBe(input);
  });

  it('leaves non-source-related paths alone', () => {
    expect(redactSelfDisclosure('Open ~/Desktop/notes.md')).toBe('Open ~/Desktop/notes.md');
  });

  it('is safe on empty/nullish input', () => {
    expect(redactSelfDisclosure('')).toBe('');
  });
});

describe('containsSelfDisclosure', () => {
  it('detects NEXUS source paths', () => {
    expect(containsSelfDisclosure('Look at /Users/lucas/nexus/src/core/orchestrator.ts')).toBe(true);
  });

  it('detects NEXUS internal class/function declarations', () => {
    expect(containsSelfDisclosure('export class Orchestrator { ... }')).toBe(true);
    expect(containsSelfDisclosure('export class MemoryManager')).toBe(true);
  });

  it('detects explicit references to NEXUS source code', () => {
    expect(containsSelfDisclosure("let me check my source code")).toBe(true);
    expect(containsSelfDisclosure("NEXUS's implementation file is huge")).toBe(true);
  });

  it('is false for user-project content', () => {
    expect(containsSelfDisclosure('Built a React app in ~/nexus-workspace/myapp')).toBe(false);
    expect(containsSelfDisclosure('The user wrote a nice function')).toBe(false);
  });

  it('is false for empty input', () => {
    expect(containsSelfDisclosure('')).toBe(false);
  });
});

describe('SELF_DISCLOSURE_REFUSAL', () => {
  it('is a non-empty string', () => {
    expect(SELF_DISCLOSURE_REFUSAL.length).toBeGreaterThan(20);
  });
});
