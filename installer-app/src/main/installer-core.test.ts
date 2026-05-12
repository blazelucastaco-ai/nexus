// Pure-function tests for the prereq installer helpers. Uses Node's
// built-in `node:test` so we don't pull vitest into installer-app just
// for these. Run with: `npm run test:main` (from installer-app/).
//
// What's covered:
//   - parsePhaseLine — log line parsing, accepts colons inside labels,
//     ignores stray noise, maps known phases to percentages.
//   - isOsascriptCancel — user-cancel detection across English wording,
//     localized "cancelled", errAuthorizationCanceled code, stderr field.
//
// What's NOT covered here (intentionally):
//   - The full installPrereqs flow — it spawns osascript and writes to
//     /tmp; needs a real Mac to assert anything meaningful, doesn't
//     belong in unit tests.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parsePhaseLine, isOsascriptCancel } from './installer-core';

describe('parsePhaseLine', () => {
  it('returns null for blank / non-PHASE lines', () => {
    assert.equal(parsePhaseLine(''), null);
    assert.equal(parsePhaseLine('curl: (6) Could not resolve host'), null);
    assert.equal(parsePhaseLine('installer: Package name is Node.js'), null);
    assert.equal(parsePhaseLine('PHASE'), null);              // no separator
    assert.equal(parsePhaseLine('PHASE:'), null);             // empty phase
  });

  it('maps known phases to their expected percentages', () => {
    assert.equal(parsePhaseLine('PHASE:starting:x')?.pct, 8);
    assert.equal(parsePhaseLine('PHASE:downloading-node:x')?.pct, 20);
    assert.equal(parsePhaseLine('PHASE:installing-node:x')?.pct, 65);
    assert.equal(parsePhaseLine('PHASE:installing-pnpm:x')?.pct, 88);
    assert.equal(parsePhaseLine('PHASE:done:x')?.pct, 100);
  });

  it('preserves the full label even with colons inside (regression: split(":", 3) chopped them)', () => {
    const parsed = parsePhaseLine('PHASE:installing-node:Downloading Node.js v22.11.0: 1.2 MB / 30 MB');
    assert.ok(parsed);
    assert.equal(parsed!.label, 'Downloading Node.js v22.11.0: 1.2 MB / 30 MB');
  });

  it('falls back to pct=50 for unknown phases (forward-compat for new markers)', () => {
    const parsed = parsePhaseLine('PHASE:unfamiliar-step:Doing something new');
    assert.ok(parsed);
    assert.equal(parsed!.pct, 50);
  });

  it('substitutes a default label when the script emits PHASE:foo: with no text', () => {
    const parsed = parsePhaseLine('PHASE:installing-node:');
    assert.ok(parsed);
    assert.equal(parsed!.label, 'Working…');
  });
});

describe('isOsascriptCancel', () => {
  it('detects English "User canceled"', () => {
    assert.equal(isOsascriptCancel(new Error('User canceled.')), true);
  });

  it('detects double-l "User cancelled"', () => {
    assert.equal(isOsascriptCancel(new Error('User cancelled.')), true);
  });

  it('detects the phrase "operation was canceled by the user"', () => {
    assert.equal(isOsascriptCancel(new Error('The operation was canceled by the user.')), true);
  });

  it('detects errAuthorizationCanceled by code', () => {
    assert.equal(isOsascriptCancel(new Error('execvp failed: errAuthorizationCanceled')), true);
  });

  it('detects -60006 numeric code', () => {
    assert.equal(isOsascriptCancel(new Error('osascript: AppleEvent error -60006')), true);
  });

  it('reads the stderr field on the error too (execFileAsync surface)', () => {
    const e = Object.assign(new Error('Command failed'), { stderr: 'User cancelled.' });
    assert.equal(isOsascriptCancel(e), true);
  });

  it('returns false for non-cancel errors', () => {
    assert.equal(isOsascriptCancel(new Error('curl: (6) Could not resolve host')), false);
    assert.equal(isOsascriptCancel(new Error('installer: Permission denied')), false);
    assert.equal(isOsascriptCancel(null), false);
    assert.equal(isOsascriptCancel(undefined), false);
  });
});
