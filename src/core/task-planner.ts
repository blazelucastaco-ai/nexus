// ─── Task Planner ─────────────────────────────────────────────────────────────
// Calls the LLM once to convert a user request into a concrete, numbered plan.
// Returns a structured plan that the TaskRunner executes step-by-step.

import { createLogger } from '../utils/logger.js';
import type { AIManager } from '../ai/index.js';

const log = createLogger('TaskPlanner');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TaskStep {
  id: number;
  title: string;       // Short action label: "Write index.html"
  description: string; // What to do and how: "Create semantic HTML5 with..."
  files?: string[];    // Files this step will create (relative to projectDir)
  dependsOn?: number[]; // Step IDs this step depends on
  agent?: string;      // Coordinator mode: preferred agent type (research|file|terminal|browser|code|vision)
}

export interface TaskPlan {
  title: string;       // Short title for progress display
  projectDir: string;  // Where files should be saved
  steps: TaskStep[];   // Ordered steps to execute
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const PLANNER_SYSTEM_PROMPT = `You are a task decomposer. Given a user request, break it into concrete numbered execution steps.

Respond ONLY with a JSON object — no markdown, no explanation, just the JSON:

{
  "title": "Short descriptive title (max 5 words)",
  "projectDir": "~/nexus-workspace/project-name-in-kebab-case",
  "steps": [
    { "id": 1, "title": "Action-oriented step title", "description": "Specific instructions", "files": ["file1.ext", "file2.ext"], "dependsOn": [] },
    { "id": 2, "title": "...", "description": "...", "files": ["file3.ext"], "dependsOn": [1] }
  ]
}

Rules:
- 2 to 7 steps. Don't over-split simple tasks. A simple website is 2-3 steps, not 7.
- Each step must list the FILES it will create (relative to projectDir).
- Each step must list dependsOn — which prior step IDs it needs output from. Empty array if independent.
- Step descriptions must be SPECIFIC: exact file names, exact structure, exact libraries. Not "add styling" but "create styles.css using Tailwind CDN with custom color palette #1a1a2e/#16213e/#0f3460/#e94560, responsive grid layout for hero/features/CTA sections".
- For web projects, step 1 should create ALL files in one step (HTML + CSS + JS). Only split if genuinely complex (backend + frontend, database + API + UI).
- The final step is ALWAYS verification: run the app if possible, confirm everything works.
- For diagnostic/survey tasks: final step answers the user directly in chat, not a report file.
- projectDir: ~/nexus-workspace/<name> for projects. ~/Desktop for personal files. "~" for survey tasks.
- If the user specified a path, use that path instead.`;

/**
 * Extract the first balanced JSON object from a string.
 * Handles LLM responses that contain prose before/after the JSON.
 * Respects strings (won't count braces inside quoted strings).
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ─── Planner Function ─────────────────────────────────────────────────────────

/**
 * Generates a structured execution plan for a user request.
 * Returns null if planning fails — caller should fall back to standard chat mode.
 */
const COORDINATOR_PLANNER_PROMPT = `You are a task decomposer in Coordinator Mode. The steps you generate will run in PARALLEL across multiple agents simultaneously. Design the plan so independent work can happen concurrently.

Respond ONLY with a JSON object:
{
  "title": "Short descriptive title (max 5 words)",
  "projectDir": "~/nexus-workspace/project-name-in-kebab-case",
  "parallel": true,
  "steps": [
    { "id": 1, "title": "Action-oriented step title", "description": "Specific instructions", "agent": "research|file|terminal|browser|code|vision" },
    { "id": 2, "title": "...", "description": "...", "agent": "..." }
  ]
}

Rules:
- 3 to 8 steps. Each step runs simultaneously — design for parallel execution.
- Assign each step to the most appropriate agent type.
- Steps that depend on another step's output should note that dependency in their description.
- Never assign conflicting writes to the same file across parallel steps.
- Final step: always aggregate/combine results from all parallel steps.`;

export async function planTask(
  request: string,
  ai: AIManager,
  model: string,
  coordinatorMode = false,
): Promise<TaskPlan | null> {
  try {
    const response = await ai.complete({
      messages: [{ role: 'user', content: `Plan this task:\n\n${request}` }],
      systemPrompt: coordinatorMode ? COORDINATOR_PLANNER_PROMPT : PLANNER_SYSTEM_PROMPT,
      model,
      maxTokens: coordinatorMode ? 2000 : 1500,
      temperature: 0.1,
    });

    const raw = response.content?.trim();
    if (!raw) {
      log.warn('Planner returned empty response');
      return null;
    }

    // Extract first balanced JSON object — handles LLMs that emit prose before/after
    const jsonStr = extractFirstJsonObject(raw);
    if (!jsonStr) {
      log.warn({ raw: raw.slice(0, 200) }, 'Planner response contained no JSON');
      return null;
    }

    const plan = JSON.parse(jsonStr) as TaskPlan;

    // Validate structure
    if (
      typeof plan.title !== 'string' ||
      typeof plan.projectDir !== 'string' ||
      !Array.isArray(plan.steps) ||
      plan.steps.length === 0
    ) {
      log.warn({ plan }, 'Planner returned invalid plan structure');
      return null;
    }

    // Validate each step
    plan.steps = plan.steps.filter(
      (s) => typeof s.id === 'number' && typeof s.title === 'string' && typeof s.description === 'string',
    );

    if (plan.steps.length === 0) {
      log.warn('Planner returned plan with no valid steps');
      return null;
    }

    if (plan.steps.length < 2) {
      log.warn({ steps: plan.steps.length }, 'Plan too short (<2 steps) — falling back to chat');
      return null;
    }

    if (plan.steps.length > 15) {
      log.warn({ steps: plan.steps.length }, 'Plan too long (>15 steps) — falling back to chat');
      return null;
    }

    log.info({ title: plan.title, steps: plan.steps.length }, 'Task plan generated');
    return plan;
  } catch (err) {
    log.warn({ err }, 'Task planning failed');
    return null;
  }
}

// ─── Plan Formatter (for Telegram display) ────────────────────────────────────

/**
 * Renders a plan as a Telegram progress message.
 * `completedIds` — steps that are done.
 * `activeId` — step currently executing.
 */
export function formatPlanMessage(
  plan: TaskPlan,
  completedIds: Set<number>,
  activeId: number | null,
  stepTimings: Map<number, number>,
  currentStepDetail?: string,
): string {
  const lines: string[] = [
    `<b>${escHtml(plan.title)}</b>`,
    '',
  ];

  for (const step of plan.steps) {
    let icon: string;
    let timing = '';

    if (completedIds.has(step.id)) {
      icon = '✅';
      const ms = stepTimings.get(step.id);
      if (ms !== undefined) timing = ` <i>(${(ms / 1000).toFixed(1)}s)</i>`;
    } else if (step.id === activeId) {
      icon = '⚙️';
    } else {
      icon = '▫️';
    }

    lines.push(`${icon} <b>${step.id}/${plan.steps.length}</b> ${escHtml(step.title)}${timing}`);
  }

  if (currentStepDetail) {
    lines.push('');
    lines.push(`<i>${escHtml(currentStepDetail)}</i>`);
  }

  return lines.join('\n');
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
