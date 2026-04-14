import { describe, it, expect, vi } from 'vitest';
import { planTask } from '../src/core/task-planner.js';
import type { AIManager } from '../src/ai/index.js';

function makeMockAI(responseContent: string): AIManager {
  return {
    complete: vi.fn().mockResolvedValue({ content: responseContent, usage: { inputTokens: 100, outputTokens: 200 } }),
  } as unknown as AIManager;
}

const VALID_PLAN_JSON = JSON.stringify({
  title: 'Build a Login Page',
  projectDir: '~/nexus-workspace/login-page',
  steps: [
    { id: 1, title: 'Create HTML structure', description: 'Build the form skeleton with semantic HTML5' },
    { id: 2, title: 'Add CSS styles', description: 'Style the form using Tailwind CSS classes' },
    { id: 3, title: 'Add form validation', description: 'Validate inputs with JavaScript before submit' },
    { id: 4, title: 'Verify output', description: 'Open the page and confirm it renders correctly' },
  ],
});

const TWO_STEP_PLAN_JSON = JSON.stringify({
  title: 'Simple Task',
  projectDir: '~/nexus-workspace/simple',
  steps: [
    { id: 1, title: 'Step one', description: 'First thing to do' },
    { id: 2, title: 'Step two', description: 'Verify the work' },
  ],
});

describe('planTask', () => {
  it('should return a valid plan for a parseable AI response', async () => {
    const ai = makeMockAI(VALID_PLAN_JSON);
    const plan = await planTask('Build a login page with HTML, CSS, and JavaScript', ai, 'claude-sonnet-4-6');
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe('Build a Login Page');
    expect(plan!.steps.length).toBeGreaterThanOrEqual(2);
  });

  it('should return a plan with the right step structure', async () => {
    const ai = makeMockAI(VALID_PLAN_JSON);
    const plan = await planTask('Build a login page with authentication', ai, 'claude-sonnet-4-6');
    expect(plan).not.toBeNull();
    for (const step of plan!.steps) {
      expect(typeof step.id).toBe('number');
      expect(step.title).toBeTruthy();
      expect(step.description).toBeTruthy();
    }
  });

  it('should return null for a plan with only 1 step', async () => {
    const shortPlan = JSON.stringify({
      title: 'Tiny Task',
      projectDir: '~/nexus-workspace/tiny',
      steps: [
        { id: 1, title: 'Only step', description: 'Do everything in one go' },
      ],
    });
    const ai = makeMockAI(shortPlan);
    const plan = await planTask('do something tiny', ai, 'claude-sonnet-4-6');
    expect(plan).toBeNull();
  });

  it('should return null for a plan with more than 15 steps', async () => {
    const bigPlan = JSON.stringify({
      title: 'Huge Task',
      projectDir: '~/nexus-workspace/huge',
      steps: Array.from({ length: 16 }, (_, i) => ({
        id: i + 1,
        title: `Step ${i + 1}`,
        description: `Description for step ${i + 1}`,
      })),
    });
    const ai = makeMockAI(bigPlan);
    const plan = await planTask('do something huge with many steps involved', ai, 'claude-sonnet-4-6');
    expect(plan).toBeNull();
  });

  it('should return null when AI response is not valid JSON', async () => {
    const ai = makeMockAI('I cannot plan this task, please try again with more details.');
    const plan = await planTask('do something', ai, 'claude-sonnet-4-6');
    expect(plan).toBeNull();
  });

  it('should return null when AI throws', async () => {
    const ai = {
      complete: vi.fn().mockRejectedValue(new Error('API error')),
    } as unknown as AIManager;
    const plan = await planTask('build something', ai, 'claude-sonnet-4-6');
    expect(plan).toBeNull();
  });

  it('should extract JSON from markdown code blocks', async () => {
    const aiResponse = `Here is my plan:\n\`\`\`json\n${VALID_PLAN_JSON}\n\`\`\`\n`;
    const ai = makeMockAI(aiResponse);
    const plan = await planTask('Build a login page with all features', ai, 'claude-sonnet-4-6');
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe('Build a Login Page');
  });

  it('should accept a 2-step plan (minimum valid)', async () => {
    const ai = makeMockAI(TWO_STEP_PLAN_JSON);
    const plan = await planTask('do a simple task', ai, 'claude-sonnet-4-6');
    expect(plan).not.toBeNull();
    expect(plan!.steps.length).toBe(2);
  });

  it('should return null for missing projectDir', async () => {
    const noDirPlan = JSON.stringify({
      title: 'Missing Dir Plan',
      steps: [
        { id: 1, title: 'Step one', description: 'First step' },
        { id: 2, title: 'Step two', description: 'Second step' },
      ],
    });
    const ai = makeMockAI(noDirPlan);
    const plan = await planTask('some task request here please', ai, 'claude-sonnet-4-6');
    expect(plan).toBeNull();
  });

  it('should filter out steps missing required fields', async () => {
    const mixedPlan = JSON.stringify({
      title: 'Mixed Plan',
      projectDir: '~/nexus-workspace/mixed',
      steps: [
        { id: 1, title: 'Valid step', description: 'This is valid' },
        { title: 'Missing id', description: 'No id field' }, // invalid: no id
        { id: 3, description: 'Missing title' }, // invalid: no title
        { id: 4, title: 'Another valid', description: 'Also valid' },
      ],
    });
    const ai = makeMockAI(mixedPlan);
    const plan = await planTask('build something with mixed step quality', ai, 'claude-sonnet-4-6');
    if (plan) {
      // All remaining steps should be valid
      for (const step of plan.steps) {
        expect(typeof step.id).toBe('number');
        expect(typeof step.title).toBe('string');
        expect(typeof step.description).toBe('string');
      }
    }
  });
});
