import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SelfEvaluator } from '../src/brain/self-evaluator.js';
import type { AIManager } from '../src/ai/index.js';

function makeMockAI(responseContent: string): AIManager {
  return {
    complete: vi.fn().mockResolvedValue({ content: responseContent, usage: { inputTokens: 10, outputTokens: 20 } }),
  } as unknown as AIManager;
}

describe('SelfEvaluator', () => {
  describe('basic gating', () => {
    it('should return null when disabled', async () => {
      const ai = makeMockAI('COMPLETE');
      const evaluator = new SelfEvaluator(ai);
      evaluator.setEnabled(false);

      const result = await evaluator.evaluate(
        'How do I fix this TypeScript error in my project?',
        'You need to add the correct type annotation to the function parameter. Here is an example of how to do this properly with full code showing the fix applied.',
        true,
      );
      expect(result).toBeNull();
    });

    it('should return null when isTaskMessage is false (chat mode)', async () => {
      const ai = makeMockAI('INCOMPLETE: Worth noting: you should also check the config file');
      const evaluator = new SelfEvaluator(ai);

      const result = await evaluator.evaluate(
        'How do I fix this TypeScript error in my project files?',
        'You need to add the correct type annotation to the function parameter here and check all callers.',
        false, // isTaskMessage = false
      );
      expect(result).toBeNull();
      // AI should not have been called
      const mockAI = ai as any;
      expect(mockAI.complete).not.toHaveBeenCalled();
    });

    it('should return null for responses shorter than MIN_RESPONSE_LENGTH (200)', async () => {
      const ai = makeMockAI('INCOMPLETE: Worth noting: you missed something important');
      const evaluator = new SelfEvaluator(ai);

      const result = await evaluator.evaluate(
        'How do I configure the TypeScript project?',
        'Short answer.',  // < 200 chars
        true,
      );
      expect(result).toBeNull();
    });

    it('should return null for trivial conversational queries', async () => {
      const ai = makeMockAI('INCOMPLETE: Worth noting: something');
      const evaluator = new SelfEvaluator(ai);

      const result = await evaluator.evaluate(
        'thanks',
        'A'.repeat(201), // Long enough response
        true,
      );
      expect(result).toBeNull();
    });

    it('should return null for queries with fewer than 4 words', async () => {
      const ai = makeMockAI('INCOMPLETE: Worth noting: something');
      const evaluator = new SelfEvaluator(ai);

      const result = await evaluator.evaluate(
        'hi there',
        'A'.repeat(201),
        true,
      );
      expect(result).toBeNull();
    });

    it('should return null for very long queries (over MAX_QUERY_WORDS)', async () => {
      const ai = makeMockAI('INCOMPLETE: Worth noting: something');
      const evaluator = new SelfEvaluator(ai);

      const longQuery = 'word '.repeat(55).trim(); // 55 words, over limit of 50
      const result = await evaluator.evaluate(
        longQuery,
        'A'.repeat(201),
        true,
      );
      expect(result).toBeNull();
    });
  });

  describe('complete responses', () => {
    it('should return null when AI says COMPLETE', async () => {
      const ai = makeMockAI('COMPLETE');
      const evaluator = new SelfEvaluator(ai);

      const result = await evaluator.evaluate(
        'How do I set up TypeScript in my Node.js project configuration?',
        'To set up TypeScript in your Node.js project, first install typescript as a devDependency using npm. Then create a tsconfig.json file with your target and module settings. Add a build script to your package.json that runs tsc. Finally configure your source root and output directory.',
        true,
      );
      expect(result).toBeNull();
    });
  });

  describe('incomplete responses', () => {
    it('should return note when AI says INCOMPLETE', async () => {
      const ai = makeMockAI('INCOMPLETE: Worth noting: you should also handle the case where the config file is missing from the project directory.');
      const evaluator = new SelfEvaluator(ai);

      const result = await evaluator.evaluate(
        'How do I set up TypeScript in my Node.js project with all configuration options?',
        'To set up TypeScript in your Node.js project, first install typescript. Then create a tsconfig.json file with your target and module settings configured properly. Add a build script to your package.json that runs the tsc compiler. This will create your output directory automatically.',
        true,
      );
      expect(result).not.toBeNull();
      expect(result).toContain('Worth noting');
    });

    it('should return null for very short incomplete notes (under 15 chars)', async () => {
      const ai = makeMockAI('INCOMPLETE: Minor gap.');
      const evaluator = new SelfEvaluator(ai);

      const result = await evaluator.evaluate(
        'How do I set up TypeScript project with all configuration options available?',
        'To set up TypeScript in your Node.js project, first install typescript. Then create a tsconfig.json file with your target and module settings configured. Add a build script and configure source maps. Everything else is handled automatically.',
        true,
      );
      expect(result).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should return null when AI throws', async () => {
      const ai = {
        complete: vi.fn().mockRejectedValue(new Error('AI unavailable')),
      } as unknown as AIManager;
      const evaluator = new SelfEvaluator(ai);

      const result = await evaluator.evaluate(
        'How do I configure TypeScript with all options in my Node project?',
        'To configure TypeScript in your Node.js project you need to install the typescript package and create a tsconfig.json file that specifies your compiler options including target and module settings.',
        true,
      );
      expect(result).toBeNull();
    });
  });

  describe('setEnabled', () => {
    it('should be enabled by default', async () => {
      const ai = makeMockAI('COMPLETE');
      const evaluator = new SelfEvaluator(ai);

      await evaluator.evaluate(
        'How do I fix this TypeScript error in my project configuration?',
        'A'.repeat(201),
        true,
      );
      const mockAI = ai as any;
      expect(mockAI.complete).toHaveBeenCalledTimes(1);
    });

    it('should not call AI after setEnabled(false)', async () => {
      const ai = makeMockAI('COMPLETE');
      const evaluator = new SelfEvaluator(ai);
      evaluator.setEnabled(false);

      await evaluator.evaluate(
        'How do I fix TypeScript errors in my node project files?',
        'A'.repeat(201),
        true,
      );
      const mockAI = ai as any;
      expect(mockAI.complete).not.toHaveBeenCalled();
    });
  });
});
