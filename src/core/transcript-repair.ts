// Transcript Repair — fixes malformed tool results before injecting into context
// Handles truncated JSON, mismatched brackets, and broken structures.

import { createLogger } from '../utils/logger.js';

const log = createLogger('TranscriptRepair');

/**
 * Attempt to repair truncated or malformed JSON.
 * Returns the original string if it can't be repaired.
 */
export function repairJson(input: string): string {
  // Already valid
  try {
    JSON.parse(input);
    return input;
  } catch {
    // Fall through to repair
  }

  let s = input.trim();

  // Count unmatched brackets/braces
  const openBraces = (s.match(/{/g) ?? []).length;
  const closeBraces = (s.match(/}/g) ?? []).length;
  const openBrackets = (s.match(/\[/g) ?? []).length;
  const closeBrackets = (s.match(/\]/g) ?? []).length;

  // Remove trailing comma before closing (common truncation artifact)
  s = s.replace(/,\s*$/, '');

  // Close unclosed strings
  const quoteCount = (s.match(/(?<!\\)"/g) ?? []).length;
  if (quoteCount % 2 !== 0) {
    s = s + '"';
  }

  // Close open brackets/braces in reverse order
  const missingBrackets = openBrackets - closeBrackets;
  const missingBraces = openBraces - closeBraces;

  if (missingBrackets > 0) s = s + ']'.repeat(missingBrackets);
  if (missingBraces > 0) s = s + '}'.repeat(missingBraces);

  try {
    JSON.parse(s);
    log.debug({ originalLen: input.length, repairedLen: s.length }, 'JSON repaired');
    return s;
  } catch {
    // Repair failed — return original
    return input;
  }
}

/**
 * Validate and repair a tool result before it's added to the context.
 * Returns the (possibly repaired) string.
 */
export function repairToolResult(toolResult: string): string {
  if (!toolResult || typeof toolResult !== 'string') {
    return '(empty tool result)';
  }

  // Check if it looks like JSON that needs repair
  const trimmed = toolResult.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && !isValidJson(trimmed)) {
    const repaired = repairJson(trimmed);
    if (repaired !== trimmed) {
      log.info({ originalLen: trimmed.length }, 'Tool result JSON repaired');
      return repaired;
    }
  }

  return toolResult;
}

function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}
