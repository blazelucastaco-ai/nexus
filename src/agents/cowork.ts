// ─── Co Work Agent ("Phone a Friend") ────────────────────────────────────────
//
// When NEXUS gets stuck on a failing step, it consults a parallel agent running
// Opus 4.7 for a second opinion and concrete fix.
//
// Flow:
//   1. NEXUS exhausts standard retries on a step
//   2. CoWorkAgent.consult() is called with full error context
//   3. Opus reviews the problem and returns a structured diagnosis + fix
//   4. NEXUS injects the suggestion into the next step attempt
//   5. If still failing, repeat up to MAX_COWORK_ATTEMPTS (3) total
//
// Code name: Phone a Friend

import { createLogger } from '../utils/logger.js';
import type { AIManager } from '../ai/index.js';

const log = createLogger('CoWork');

// Co Work always uses the strongest available model — that's the whole point
const COWORK_MODEL = 'claude-opus-4-7';
const COWORK_MAX_TOKENS = 4096;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CoWorkRequest {
  /** Title of the overall task being executed */
  taskTitle: string;
  /** Title of the specific step that failed */
  stepTitle: string;
  /** What the step was supposed to accomplish */
  stepGoal: string;
  /** The original user request that triggered the task */
  originalRequest: string;
  /** Error output / failure reason collected from failed attempts */
  errorContext: string;
  /** Files that were written during failed attempts (if any) */
  filesWritten: string[];
  /** Commands that were run during failed attempts (if any) */
  commandsRun: string[];
  /** Previous suggestions Co Work already made (to avoid repetition) */
  previousSuggestions: string[];
  /** Which Co Work attempt this is (1, 2, or 3) */
  attemptNumber: number;
}

export interface CoWorkResponse {
  /** What Co Work thinks the root cause is */
  diagnosis: string;
  /** The concrete fix or approach to try */
  suggestion: string;
  /** Step-by-step actions NEXUS should take */
  specificSteps: string[];
  /** How confident Co Work is (0.0–1.0) */
  confidence: number;
}

export interface CoWorkEvent {
  /** Which step triggered Co Work */
  stepId: number;
  /** Which attempt number (1–3) */
  attemptNumber: number;
  /** The diagnosis Co Work gave */
  diagnosis: string;
  /** The suggestion Co Work gave */
  suggestion: string;
  /** Whether the suggestion resolved the issue */
  outcome: 'resolved' | 'failed' | 'pending';
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const COWORK_SYSTEM_PROMPT = `You are a senior engineer being pulled in by NEXUS — another agent that's stuck on a real task and asking for help. You are not NEXUS's yes-man and not a rubber stamp. NEXUS is good but it gets tunnel vision, and your job is to help it see what it's missing.

Stress-test the framing before you diagnose:
- If NEXUS's description of the failure starts with the wrong premise, name that premise out loud in the diagnosis. The wrong fix to the right problem beats the right fix to the wrong problem.
- If previous suggestions were tried and failed, NEXUS is probably misreading the situation. Surface the meta-error ("you've been treating this as a build problem; it's a permissions problem"), not yet another variation of the same plan.
- Don't sandwich the diagnosis between hedges. State what you actually believe, then back it with the specific evidence in the error context.

You MUST respond with valid JSON only — no markdown, no prose, no code fences. Exactly this shape:
{
  "diagnosis": "One sentence: what's actually wrong, including the premise to reject if NEXUS framed it incorrectly",
  "suggestion": "One sentence: the specific thing to try differently — concrete, not generic",
  "specificSteps": ["step 1", "step 2", "step 3"],
  "confidence": 0.0
}

Rules:
- diagnosis: name the root cause, not the symptom. Not "the build failed" but "node_modules is half-installed because the previous npm install was killed mid-run".
- suggestion: concrete and actionable. Not "fix the issue" but "rm -rf node_modules and reinstall with --no-fund to avoid the prompt".
- specificSteps: 2–5 ordered steps NEXUS can execute directly.
- confidence: 0.0 (guessing) to 1.0 (certain). If you're guessing, say so honestly — NEXUS uses confidence to decide whether to retry or escalate.
- Pick the MOST LIKELY single root cause; don't enumerate possibilities. NEXUS gets noisy when handed lists.`;

// ─── CoWorkAgent ──────────────────────────────────────────────────────────────

export class CoWorkAgent {
  constructor(private ai: AIManager) {}

  /**
   * Consult the Co Work agent with a failing step's context.
   * Returns a structured diagnosis and suggestion.
   * Never throws — returns a fallback response on any error.
   */
  async consult(request: CoWorkRequest): Promise<CoWorkResponse> {
    log.info(
      { stepTitle: request.stepTitle, attempt: request.attemptNumber, errorLen: request.errorContext.length },
      'Co Work consultation started',
    );

    const userMessage = buildConsultMessage(request);

    try {
      const response = await this.ai.complete({
        model: COWORK_MODEL,
        maxTokens: COWORK_MAX_TOKENS,
        temperature: 0.3, // Low temperature — we want focused, precise answers
        messages: [{ role: 'user', content: userMessage }],
        systemPrompt: COWORK_SYSTEM_PROMPT,
      });

      const parsed = parseCoWorkResponse(response.content);

      log.info(
        {
          stepTitle: request.stepTitle,
          attempt: request.attemptNumber,
          diagnosis: parsed.diagnosis.slice(0, 100),
          confidence: parsed.confidence,
        },
        'Co Work suggestion received',
      );

      return parsed;
    } catch (err) {
      log.warn({ err, stepTitle: request.stepTitle }, 'Co Work consultation failed — returning fallback');
      return {
        diagnosis: 'Co Work consultation failed — model unavailable or rate limited',
        suggestion: 'Review the error carefully and try a different approach',
        specificSteps: ['Re-read the error message', 'Check if required dependencies are installed', 'Try a simpler approach'],
        confidence: 0.1,
      };
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildConsultMessage(request: CoWorkRequest): string {
  const lines: string[] = [
    `TASK: ${request.taskTitle}`,
    `STEP TITLE: ${request.stepTitle}`,
    `STEP GOAL: ${request.stepGoal}`,
    `ORIGINAL REQUEST: ${request.originalRequest}`,
    '',
    '── FAILURE CONTEXT ──',
    request.errorContext.trim() || 'No specific error captured — step completed but result was incorrect or incomplete.',
  ];

  if (request.filesWritten.length > 0) {
    lines.push('', `FILES WRITTEN DURING ATTEMPT: ${request.filesWritten.join(', ')}`);
  }

  if (request.commandsRun.length > 0) {
    lines.push(`COMMANDS RUN DURING ATTEMPT:\n${request.commandsRun.map((c) => `  $ ${c}`).join('\n')}`);
  }

  if (request.previousSuggestions.length > 0) {
    lines.push(
      '',
      '── PREVIOUS CO WORK SUGGESTIONS (these did NOT work — suggest something different) ──',
      ...request.previousSuggestions.map((s, i) => `Attempt ${i + 1}: ${s}`),
    );
  }

  if (request.attemptNumber > 1) {
    lines.push(
      '',
      `This is Co Work attempt ${request.attemptNumber} of 3. Previous suggestions failed. Be creative and try a fundamentally different approach.`,
    );
  }

  return lines.join('\n');
}

function parseCoWorkResponse(raw: string): CoWorkResponse {
  // Strip markdown code fences if model ignored instructions
  const cleaned = raw
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as {
      diagnosis?: unknown;
      suggestion?: unknown;
      specificSteps?: unknown;
      confidence?: unknown;
    };

    return {
      diagnosis: typeof parsed.diagnosis === 'string' ? parsed.diagnosis : 'Unknown root cause',
      suggestion: typeof parsed.suggestion === 'string' ? parsed.suggestion : 'Try a different approach',
      specificSteps: Array.isArray(parsed.specificSteps)
        ? parsed.specificSteps.filter((s): s is string => typeof s === 'string')
        : [],
      confidence: typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
    };
  } catch {
    // JSON parse failed — extract what we can from raw text
    log.debug({ rawLen: raw.length }, 'Co Work response was not valid JSON — using raw text as suggestion');
    const firstLine = raw.split('\n').find((l) => l.trim().length > 10) ?? raw.slice(0, 200);
    return {
      diagnosis: 'Unable to parse structured response',
      suggestion: firstLine.trim(),
      specificSteps: [],
      confidence: 0.4,
    };
  }
}

/**
 * Format a Co Work response as a system prompt injection block.
 * This gets appended to the step system prompt so NEXUS knows what to try.
 */
export function formatCoWorkHint(response: CoWorkResponse, attemptNumber: number): string {
  const confidenceLabel = response.confidence >= 0.8 ? 'High' : response.confidence >= 0.5 ? 'Medium' : 'Low';
  const steps = response.specificSteps.length > 0
    ? '\n\nSpecific steps to follow:\n' + response.specificSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '';

  return `
━━━ CO WORK — SENIOR CONSULTANT ADVICE (Attempt ${attemptNumber}/3) ━━━

A senior AI consultant has reviewed this failing step. Their diagnosis is the result of looking at the actual failure and what NEXUS tried — not a hint or a tweak.

THIS IS A STRATEGY CHANGE. Do NOT retry the previous approach with parameter adjustments or a different prompt. If the diagnosis says "stop using X," that means STOP using X — pivot to the suggested tool/approach completely. Repeating the same shape after Co Work flagged it wastes time and burns the remaining attempts.

🔍 Root cause:
${response.diagnosis}

💡 Pivot to:
${response.suggestion}${steps}

Confidence: ${confidenceLabel} (${Math.round(response.confidence * 100)}%)

If this new approach also fails: say so plainly in your final response. Don't claim success on a failed step. The user would rather hear "I tried X and Y, both failed, here's what I learned" than a polished lie.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}
