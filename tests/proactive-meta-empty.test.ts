import { describe, it, expect } from 'vitest';
import { isMetaEmptyResponse } from '../src/brain/proactive.js';

// Defense-in-depth detector for the failure mode the user saw on 2026-05-05:
// the proactive idle-thoughts engine fired three times across one day, each
// time broadcasting the model's "I don't have any context — drop in some
// details" template verbatim. The cooperative path (the prompt now asks the
// model to output `(skip)` when context is sparse) is the primary fix; this
// pure helper is the backstop for when the model emits the boilerplate
// anyway. False-positive risk is mitigated by anchoring on phrases that
// only appear in the meta-empty failure mode, not in legitimate ideas.

describe('isMetaEmptyResponse', () => {
  it('catches the exact template the user saw broadcast 3x in one day', () => {
    expect(isMetaEmptyResponse(
      "I don't have any context to work with — it looks like the context section was empty. Drop in some details (recent projects, files, habits, conversations, anything) and I'll give you something actually worth thinking about.",
    )).toBe(true);
  });

  it('catches the cooperative (skip) sentinel', () => {
    expect(isMetaEmptyResponse('(skip)')).toBe(true);
    expect(isMetaEmptyResponse('  ( skip )  ')).toBe(true);
  });

  it('catches paraphrased "context is empty" responses', () => {
    expect(isMetaEmptyResponse('The context section was empty.')).toBe(true);
    expect(isMetaEmptyResponse('Context appears blank — give me more.')).toBe(true);
    expect(isMetaEmptyResponse('I dont have enough context here.')).toBe(true);
  });

  it('catches "drop in some details" / "give me something to work with"', () => {
    expect(isMetaEmptyResponse('Drop in some details and I can think.')).toBe(true);
    expect(isMetaEmptyResponse('Give me something to work with first.')).toBe(true);
    expect(isMetaEmptyResponse('Give me more context, then we talk.')).toBe(true);
  });

  it('catches "nothing specific to think about"', () => {
    expect(isMetaEmptyResponse('Honestly, nothing specific to think about right now.')).toBe(true);
  });

  it('treats empty/whitespace as meta-empty (caller should skip)', () => {
    expect(isMetaEmptyResponse('')).toBe(true);
  });

  it('does NOT catch legitimate ideas that mention "context" in normal prose', () => {
    expect(isMetaEmptyResponse(
      'You\'ve been refactoring auth for three days — worth pausing to write down the context for future-you before pivoting.',
    )).toBe(false);
    expect(isMetaEmptyResponse(
      'The Stripe integration has accumulated 3 TODOs about webhook signing. Resolving them is a contained morning of work.',
    )).toBe(false);
    expect(isMetaEmptyResponse(
      'Consider exporting the bridge config to a shared module — context-stitcher and time-capsule both reach into it directly.',
    )).toBe(false);
  });

  it('does NOT catch ideas that mention "details" in normal prose', () => {
    expect(isMetaEmptyResponse(
      'The session-summary prompt could use specific details about which files changed, not just topic-level summaries.',
    )).toBe(false);
  });
});
