// Tests for stepImpliesOutput — the gate that decides whether to run
// verifyStep when filesWritten=0. Without this, a step titled
// "Generate final report and open in Chrome" that only ran `open template.html`
// would auto-pass with no artifact actually rendered.
//
// Regression context: 2026-05-11 LoopNet incident. The model ran
// `open ~/.../template.html` for step 5, wrote zero new files, and the
// verifier early-returned passed=true. The user saw {{COUNT}}/{{TIMESTAMP}}
// placeholders on screen.

import { describe, it, expect } from 'vitest';
import { stepImpliesOutput } from '../src/core/task-runner.js';

describe('stepImpliesOutput', () => {
  describe('returns true for titles that imply file output', () => {
    const outputTitles = [
      'Generate final report and open in Chrome',
      'Build dark-mode HTML report template',
      'Create the listings JSON',
      'Write the final summary to disk',
      'Render the populated report',
      'Produce the consolidated output',
      'Compile the asset bundle',
      'Scaffold the project directory',
      'Extract data from each listing page',
      'Scrape the search results',
      'Fetch the listing details',
      'Download the source assets',
      'Export results as CSV',
      'Publish the rendered report',
      'Assemble the final dataset',
      'Populate the template with data',
      'Fill placeholders in the template',
      'Substitute variables in the report',
    ];

    for (const title of outputTitles) {
      it(`flags "${title}"`, () => {
        expect(stepImpliesOutput(title)).toBe(true);
      });
    }
  });

  describe('returns false for pure-action / non-producing titles', () => {
    const actionTitles = [
      'Open the final report in Chrome',
      'Open template.html',
      'Setup project directory',
      'Research LoopNet search structure',
      'Browse LoopNet and capture listings',
      'Restart the daemon',
      'Install dependencies',
      'Navigate to the listing page',
      'Click the search button',
      'Verify the connection is live',
      'Read the user preferences',
      'Check git status',
      'Log the operator into Telegram',
      'Inspect the page DOM',
      'Examine the listing structure',
      'Review the previous step output',
      'List the available skills',
      'Confirm the user wants to proceed',
    ];

    for (const title of actionTitles) {
      it(`does not flag "${title}"`, () => {
        expect(stepImpliesOutput(title)).toBe(false);
      });
    }
  });
});
