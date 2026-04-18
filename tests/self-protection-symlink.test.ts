import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, symlinkSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  isNexusSourcePath,
  __setNexusSourceDirForTests,
} from '../src/core/self-protection.js';

/**
 * FIND-TST-03: CRIT-2 (symlink bypass of isNexusSourcePath) was closed
 * yesterday with a realpathSync pass. But the original test suite only
 * exercised the rule table with fake paths — no actual filesystem
 * symlinks. This test creates real symlinks and verifies that the guard
 * dereferences them before applying the source-tree check.
 */
describe('isNexusSourcePath — real symlink dereferencing (FIND-TST-03)', () => {
  let tempRoot: string;
  let fakeSourceDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync('/tmp/nexus-symlink-test-');
    fakeSourceDir = join(tempRoot, 'nexus');
    mkdirSync(join(fakeSourceDir, 'src', 'core'), { recursive: true });
    writeFileSync(join(fakeSourceDir, 'package.json'), '{"name":"fake"}');
    writeFileSync(join(fakeSourceDir, 'src', 'core', 'orchestrator.ts'), '// fake');
    __setNexusSourceDirForTests(fakeSourceDir);
  });

  afterEach(() => {
    __setNexusSourceDirForTests(null);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('dereferences a symlink into the source dir — CANNOT bypass via symlink', () => {
    // Attacker scenario: put a symlink OUTSIDE the source tree that points
    // INSIDE the source tree. Before the fix, resolve() would return the
    // link path unchanged (not inside source → guard missed). After the
    // fix, realpathSync canonicalizes to the target → guard catches it.
    const innocuousLink = join(tempRoot, 'looks-innocent');
    symlinkSync(join(fakeSourceDir, 'src'), innocuousLink);

    // Path THROUGH the symlink to a real source file:
    const pathViaLink = join(innocuousLink, 'core', 'orchestrator.ts');

    expect(isNexusSourcePath(pathViaLink)).toBe(true);
  });

  it('dereferences a nested symlink chain', () => {
    // link1 → link2 → source_dir
    const link2 = join(tempRoot, 'link2');
    const link1 = join(tempRoot, 'link1');
    symlinkSync(fakeSourceDir, link2);
    symlinkSync(link2, link1);

    const pathViaChain = join(link1, 'src', 'core', 'orchestrator.ts');
    expect(isNexusSourcePath(pathViaChain)).toBe(true);
  });

  it('still allows a non-source symlink to pass through', () => {
    // A symlink to somewhere that's NOT the nexus source should not trip.
    const safeLink = join(tempRoot, 'safe-link');
    const safeDir = join(tempRoot, 'some-other-dir');
    mkdirSync(safeDir);
    writeFileSync(join(safeDir, 'file.txt'), 'x');
    symlinkSync(safeDir, safeLink);

    const pathViaSafeLink = join(safeLink, 'file.txt');
    expect(isNexusSourcePath(pathViaSafeLink)).toBe(false);
  });

  it('handles symlinks to files (not just directories)', () => {
    // Directly symlink a source file into an attacker-controlled location.
    const fileLink = join(tempRoot, 'looks-harmless.ts');
    symlinkSync(join(fakeSourceDir, 'src', 'core', 'orchestrator.ts'), fileLink);

    expect(isNexusSourcePath(fileLink)).toBe(true);
  });

  it('handles a path whose target does not exist yet (LLM writing a new file)', () => {
    // When the LLM says "write to ~/link/new-file.ts" and `~/link` points
    // into the source tree, the write target doesn't exist yet — so we can't
    // realpath it directly. canonicalize() walks up to the first existing
    // ancestor (the symlink itself), realpaths THAT, and re-appends the
    // unresolved suffix. Result: still identified as inside the source tree.
    const linkToSrc = join(tempRoot, 'sneaky');
    symlinkSync(join(fakeSourceDir, 'src'), linkToSrc);

    const wouldBeNewFile = join(linkToSrc, 'brain', 'new-evil.ts');
    expect(isNexusSourcePath(wouldBeNewFile)).toBe(true);
  });

  it('does not mistake nexus-workspace sibling as source', () => {
    // `nexus-workspace` is the user's project area, NOT the NEXUS source.
    // It lives right next to the source dir and must not be blocked.
    const workspace = join(tempRoot, 'nexus-workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'my-app.ts'), '// user');

    expect(isNexusSourcePath(join(workspace, 'my-app.ts'))).toBe(false);
  });
});
