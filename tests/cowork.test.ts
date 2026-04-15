// Unit tests for Co Work ("Phone a Friend") agent
// Tests the consultation flow, response parsing, hint formatting, and fallback behavior

import { describe, it, expect, vi } from 'vitest';
import { CoWorkAgent, formatCoWorkHint } from '../src/agents/cowork.js';
import type { CoWorkRequest, CoWorkResponse } from '../src/agents/cowork.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAI(responseContent: string) {
  return {
    complete: vi.fn().mockResolvedValue({ content: responseContent }),
  } as any;
}

function makeRequest(overrides: Partial<CoWorkRequest> = {}): CoWorkRequest {
  return {
    taskTitle: 'Debug the authentication module',
    stepTitle: 'Fix JWT token expiry bug',
    stepGoal: 'Ensure tokens expire after 24 hours',
    originalRequest: 'Fix the auth bug in my project',
    errorContext: 'TypeError: Cannot read property "exp" of undefined at verifyToken (auth.ts:42)',
    filesWritten: ['src/auth.ts'],
    commandsRun: ['npm test'],
    previousSuggestions: [],
    attemptNumber: 1,
    ...overrides,
  };
}

const VALID_COWORK_JSON = JSON.stringify({
  diagnosis: 'The JWT payload is undefined because the token is malformed or the secret is wrong',
  suggestion: 'Add a null-check before accessing payload.exp and log the raw token for inspection',
  specificSteps: [
    'Add console.log(token) before verifyToken call',
    'Check that JWT_SECRET env var is set',
    'Add null-check: if (!payload) throw new Error("Invalid token")',
  ],
  confidence: 0.85,
});

// ─── CoWorkAgent.consult() ────────────────────────────────────────────────────

describe('CoWorkAgent', () => {
  describe('consult()', () => {
    it('parses a valid JSON response from the model', async () => {
      const agent = new CoWorkAgent(makeAI(VALID_COWORK_JSON));
      const result = await agent.consult(makeRequest());

      expect(result.diagnosis).toContain('JWT payload is undefined');
      expect(result.suggestion).toContain('null-check');
      expect(result.specificSteps).toHaveLength(3);
      expect(result.confidence).toBe(0.85);
    });

    it('calls complete() with claude-opus-4-6 model', async () => {
      const ai = makeAI(VALID_COWORK_JSON);
      const agent = new CoWorkAgent(ai);
      await agent.consult(makeRequest());

      expect(ai.complete).toHaveBeenCalledOnce();
      const call = ai.complete.mock.calls[0][0];
      expect(call.model).toBe('claude-opus-4-6');
    });

    it('includes task context in the message', async () => {
      const ai = makeAI(VALID_COWORK_JSON);
      const agent = new CoWorkAgent(ai);
      await agent.consult(makeRequest());

      const call = ai.complete.mock.calls[0][0];
      const msg = call.messages[0].content as string;
      expect(msg).toContain('Debug the authentication module');
      expect(msg).toContain('Fix JWT token expiry bug');
      expect(msg).toContain('TypeError: Cannot read property');
    });

    it('includes previous suggestions in the message', async () => {
      const ai = makeAI(VALID_COWORK_JSON);
      const agent = new CoWorkAgent(ai);
      await agent.consult(makeRequest({
        previousSuggestions: ['Check the env vars', 'Restart the server'],
        attemptNumber: 3,
      }));

      const call = ai.complete.mock.calls[0][0];
      const msg = call.messages[0].content as string;
      expect(msg).toContain('Check the env vars');
      expect(msg).toContain('Restart the server');
      expect(msg).toContain('attempt 3 of 3');
    });

    it('handles JSON wrapped in markdown code fences', async () => {
      const fenced = '```json\n' + VALID_COWORK_JSON + '\n```';
      const agent = new CoWorkAgent(makeAI(fenced));
      const result = await agent.consult(makeRequest());

      expect(result.diagnosis).toContain('JWT payload is undefined');
      expect(result.confidence).toBe(0.85);
    });

    it('returns fallback when model throws', async () => {
      const ai = {
        complete: vi.fn().mockRejectedValue(new Error('Rate limited')),
      } as any;
      const agent = new CoWorkAgent(ai);
      const result = await agent.consult(makeRequest());

      expect(result.diagnosis).toContain('Co Work consultation failed');
      expect(result.confidence).toBe(0.1);
      expect(result.specificSteps.length).toBeGreaterThan(0);
    });

    it('returns fallback when model returns invalid JSON', async () => {
      const agent = new CoWorkAgent(makeAI('sorry I cannot help with that'));
      const result = await agent.consult(makeRequest());

      // Falls back gracefully — uses raw text as suggestion
      expect(result.suggestion).toBeTruthy();
      expect(result.confidence).toBe(0.4);
    });

    it('clamps confidence to 0.0–1.0 range', async () => {
      const outOfRange = JSON.stringify({
        diagnosis: 'test',
        suggestion: 'test',
        specificSteps: [],
        confidence: 9.99,
      });
      const agent = new CoWorkAgent(makeAI(outOfRange));
      const result = await agent.consult(makeRequest());

      expect(result.confidence).toBe(1.0);
    });

    it('handles missing optional fields in JSON response', async () => {
      const minimal = JSON.stringify({
        diagnosis: 'Something went wrong',
        suggestion: 'Try again',
      });
      const agent = new CoWorkAgent(makeAI(minimal));
      const result = await agent.consult(makeRequest());

      expect(result.diagnosis).toBe('Something went wrong');
      expect(result.suggestion).toBe('Try again');
      expect(result.specificSteps).toEqual([]);
      expect(result.confidence).toBe(0.5); // default
    });

    it('never throws — always resolves', async () => {
      const brokenAI = {
        complete: vi.fn().mockRejectedValue(new Error('Server exploded')),
      } as any;
      const agent = new CoWorkAgent(brokenAI);
      await expect(agent.consult(makeRequest())).resolves.toBeDefined();
    });
  });
});

// ─── formatCoWorkHint() ───────────────────────────────────────────────────────

describe('formatCoWorkHint()', () => {
  const response: CoWorkResponse = {
    diagnosis: 'The JWT secret is missing from environment variables',
    suggestion: 'Export JWT_SECRET before running the server',
    specificSteps: ['Check .env file', 'Run: export JWT_SECRET=your_secret', 'Restart the server'],
    confidence: 0.9,
  };

  it('includes attempt number in the header', () => {
    const hint = formatCoWorkHint(response, 2);
    expect(hint).toContain('Attempt 2/3');
  });

  it('includes diagnosis and suggestion', () => {
    const hint = formatCoWorkHint(response, 1);
    expect(hint).toContain('The JWT secret is missing');
    expect(hint).toContain('Export JWT_SECRET');
  });

  it('includes numbered specific steps', () => {
    const hint = formatCoWorkHint(response, 1);
    expect(hint).toContain('1. Check .env file');
    expect(hint).toContain('2. Run: export JWT_SECRET=your_secret');
    expect(hint).toContain('3. Restart the server');
  });

  it('shows "High" confidence label for >= 0.8', () => {
    const hint = formatCoWorkHint(response, 1); // confidence: 0.9
    expect(hint).toContain('High');
    expect(hint).toContain('90%');
  });

  it('shows "Medium" confidence label for 0.5–0.79', () => {
    const hint = formatCoWorkHint({ ...response, confidence: 0.65 }, 1);
    expect(hint).toContain('Medium');
    expect(hint).toContain('65%');
  });

  it('shows "Low" confidence label for < 0.5', () => {
    const hint = formatCoWorkHint({ ...response, confidence: 0.3 }, 1);
    expect(hint).toContain('Low');
    expect(hint).toContain('30%');
  });

  it('omits steps section when specificSteps is empty', () => {
    const hint = formatCoWorkHint({ ...response, specificSteps: [] }, 1);
    expect(hint).not.toContain('Specific steps');
  });
});
