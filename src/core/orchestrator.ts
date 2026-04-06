// Nexus AI — Orchestrator (central brain / router)
//
// This is the heart of NEXUS. Every user message flows through here:
// personality + memory + reasoning + agent delegation = response.

import { homedir } from 'node:os';
import { mkdir as mkdirFS, writeFile as writeFileFS } from 'node:fs/promises';
import { dirname as dirnameFS } from 'node:path';
import { createLogger } from '../utils/logger.js';
import { generateId, nowISO, truncate, extractCleanContent } from '../utils/helpers.js';
import { loadConfig } from '../config.js';
import { assembleContext, buildSystemPrompt, parseActions, stripActions } from './context.js';
import { EventLoop } from './event-loop.js';
import type {
  AgentName,
  AgentResult,
  AgentTask,
  AIMessage,
  NexusConfig,
  NexusContext,
} from '../types.js';

// Subsystem types — imported as type-only to avoid circular deps at load time.
// Actual instances are injected via init().
import type { MemoryManager } from '../memory/index.js';
import type { PersonalityEngine } from '../personality/index.js';
import type { AgentManager } from '../agents/index.js';
import type { AIManager } from '../ai/index.js';
import type { TelegramGateway } from '../telegram/index.js';
import type { MacOSController } from '../macos/index.js';
import type { LearningSystem } from '../learning/index.js';

const log = createLogger('Orchestrator');

// ─── Regex patterns for inline directives the LLM can emit ──────────
const REMEMBER_PATTERN = /\[REMEMBER:([^\]]+)\]/g;
const RECALL_PATTERN = /\[RECALL:([^\]]+)\]/g;

/**
 * Extract all [DELEGATE:agent:task] blocks using bracket-counting so that
 * task content can contain ] characters (e.g. Python list access data[0]).
 * The simple regex /[^\]]+/ would break on any ] inside the task body.
 */
function extractDelegations(
  response: string,
): Array<{ agent: string; task: string; fullMatch: string }> {
  const delegations: Array<{ agent: string; task: string; fullMatch: string }> = [];
  const MARKER = '[DELEGATE:';
  let i = 0;

  while (i < response.length) {
    const start = response.indexOf(MARKER, i);
    if (start === -1) break;

    const agentStart = start + MARKER.length;
    const agentEnd = response.indexOf(':', agentStart);
    if (agentEnd === -1) { i = start + 1; continue; }

    const agent = response.slice(agentStart, agentEnd);
    if (!/^\w+$/.test(agent)) { i = start + 1; continue; }

    // Count brackets to find the matching ]
    let depth = 1;
    let j = agentEnd + 1;
    while (j < response.length && depth > 0) {
      if (response[j] === '[') depth++;
      else if (response[j] === ']') depth--;
      j++;
    }

    if (depth !== 0) { i = start + 1; continue; } // unmatched

    const task = response.slice(agentEnd + 1, j - 1);
    const fullMatch = response.slice(start, j);
    delegations.push({ agent, task, fullMatch });
    i = j;
  }

  return delegations;
}

// ─── Orchestrator ────────────────────────────────────────────────────

export class Orchestrator {
  private config: NexusConfig;
  private eventLoop: EventLoop;
  private conversationHistory: AIMessage[] = [];
  private activeTasks: AgentTask[] = [];
  private startTime = Date.now();
  private initialized = false;

  // Subsystems — set via init()
  public memory!: MemoryManager;
  public personality!: PersonalityEngine;
  public agents!: AgentManager;
  public ai!: AIManager;
  public telegram!: TelegramGateway;
  public macos!: MacOSController;
  public learning!: LearningSystem;

  constructor() {
    this.config = loadConfig();
    this.eventLoop = new EventLoop();
    this.setupEventHandlers();
  }

  // ── Initialization ────────────────────────────────────────────────

  /**
   * Wire up all subsystems. Called from index.ts after everything is
   * instantiated so we avoid circular-dependency headaches.
   */
  init(subsystems: {
    memory: MemoryManager;
    personality: PersonalityEngine;
    agents: AgentManager;
    ai: AIManager;
    telegram: TelegramGateway;
    macos: MacOSController;
    learning: LearningSystem;
  }): void {
    this.memory = subsystems.memory;
    this.personality = subsystems.personality;
    this.agents = subsystems.agents;
    this.ai = subsystems.ai;
    this.telegram = subsystems.telegram;
    this.macos = subsystems.macos;
    this.learning = subsystems.learning;

    this.initialized = true;
    log.info('Orchestrator initialized with all subsystems');
  }

  /**
   * Start all runtime systems.
   */
  async start(): Promise<void> {
    if (!this.initialized) {
      throw new Error('Orchestrator.init() must be called before start()');
    }

    log.info('Starting NEXUS...');
    this.eventLoop.start();

    await this.telegram.start();

    this.eventLoop.emit('system:started', { timestamp: nowISO() }, 'high', 'orchestrator');
    log.info('NEXUS is running');
  }

  /**
   * Graceful shutdown — persist state, close connections, stop loops.
   */
  async stop(): Promise<void> {
    log.info('Shutting down NEXUS...');

    // Persist current emotional / personality state as an episodic memory
    // so we can warm-start next launch.
    try {
      const state = this.personality.getPersonalityState();
      await this.memory.store(
        'episodic',
        'task',
        JSON.stringify({
          type: 'shutdown_state',
          mood: state.mood,
          emotion: state.emotionLabel,
          warmth: state.relationshipWarmth,
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
          conversationLength: this.conversationHistory.length,
        }),
        {
          importance: 0.4,
          tags: ['system', 'shutdown'],
          source: 'orchestrator',
        },
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist shutdown state');
    }

    this.eventLoop.stop();
    this.telegram.stop();
    this.memory.close();
    log.info('NEXUS stopped');
  }

  // ── Public Dev Interface ──────────────────────────────────────────

  /**
   * Process a plain-text message without any Telegram context.
   * Used by the CLI chat REPL and dev-chat.ts test script.
   */
  async processMessage(text: string, userId = 'dev'): Promise<string> {
    return this.handleMessage(userId, text);
  }

  // ── Main Brain Loop ───────────────────────────────────────────────

  /**
   * Handle an incoming user message — THE main method.
   *
   * Flow:
   *  1. Store in short-term memory
   *  2. Assemble full context (personality + memories + tasks + conversation)
   *  3. Build system prompt with personality, agents, tasks, memory ops
   *  4. Call AI with assembled context
   *  5. Parse response for delegations ([DELEGATE:agent:task])
   *  6. Dispatch delegations to agents
   *  7. Parse memory directives ([REMEMBER:...], [RECALL:...])
   *  8. Update emotional state
   *  9. Store interaction in episodic memory
   * 10. Return clean response to user
   */
  async handleMessage(chatId: string, text: string): Promise<string> {
    const startTime = Date.now();
    log.info({ chatId, textLen: text.length }, 'Processing message');

    try {
      log.info({ chatId, text: truncate(text, 200) }, 'Incoming message');

      // ── 1. Personality event + short-term memory ──────────────
      this.personality.processEvent('user_message');
      this.memory.addToBuffer('user', text);

      // ── 2. Recall relevant context ────────────────────────────
      const recentMemories = await this.memory.recall(text, { limit: 10 });
      const relevantFacts = await this.memory.getRelevantFacts(text);

      // ── 3. Pre-action learning check ──────────────────────────
      const mistakeCheck = this.learning.mistakes.checkAgainstHistory(text);
      const prevention = {
        prevention: mistakeCheck.safe ? null : (mistakeCheck.warning ?? null),
        preferenceConflict: null as string | null,
      };
      if (prevention.prevention || prevention.preferenceConflict) {
        log.info({ prevention }, 'Learning system flagged an issue');
      }

      // ── 4. Assemble context ───────────────────────────────────
      const context = this.assembleNexusContext(recentMemories, relevantFacts);

      // ── 5. Build system prompt ────────────────────────────────
      const systemPrompt = this.buildFullSystemPrompt(context, prevention);

      // ── 6. Add user message to conversation history ───────────
      this.conversationHistory.push({ role: 'user', content: text });

      // ── 7. Call AI ────────────────────────────────────────────
      // Cap at 1500 tokens for Telegram — keeps responses concise.
      // Agent integration calls use higher limits separately.
      const aiResponse = await this.ai.complete({
        messages: this.conversationHistory.slice(-20),
        systemPrompt,
        model: this.config.ai.model,
        maxTokens: Math.min(this.config.ai.maxTokens, 1500),
        temperature: this.config.ai.temperature,
      });

      let responseContent = aiResponse.content;
      log.info(
        { provider: aiResponse.provider, model: aiResponse.model, response: truncate(responseContent, 200) },
        'AI response received',
      );

      // ── 8a. Explicit "remember" intent detection ──────────────
      // If the user said "remember X", "don't forget X", etc., store it
      // directly to semantic memory without relying on the LLM to emit [REMEMBER:].
      await this.detectAndStoreRememberIntent(text);

      // ── 8. Process memory directives ──────────────────────────
      responseContent = await this.processMemoryDirectives(responseContent);

      // ── 9. Parse and execute agent delegations ────────────────
      const { cleanResponse, agentResults } =
        await this.processDelegations(responseContent);

      // Also handle ```action``` blocks (legacy context.ts format)
      const legacyActions = parseActions(cleanResponse);
      const conversationalPart = stripActions(cleanResponse);

      const legacyResults: string[] = [];
      for (const action of legacyActions) {
        try {
          const result = await this.executeAgentAction(
            action.agent as AgentName,
            action.action,
            action.params,
          );
          if (result.success) {
            legacyResults.push(
              `[${action.agent}:${action.action}] Done: ${truncate(JSON.stringify(result.data), 300)}`,
            );
          } else {
            legacyResults.push(
              `[${action.agent}:${action.action}] Failed: ${result.error}`,
            );
          }
        } catch (err) {
          log.error({ err, action }, 'Legacy agent action failed');
          legacyResults.push(
            `[${action.agent}:${action.action}] Error: ${err}`,
          );
        }
      }

      // ── 10. Merge results into final response ─────────────────
      let finalResponse = conversationalPart;
      const allResults = [...agentResults, ...legacyResults];

      if (allResults.length > 0) {
        const integrated = await this.integrateAgentResults(
          finalResponse,
          allResults,
          systemPrompt,
        );
        // BUG C fix: process any new delegations in the integration response
        // (e.g., write-after-collect where LLM gathers terminal data then writes a file)
        const { cleanResponse: intClean, agentResults: intResults } =
          await this.processDelegations(integrated);
        if (intResults.length > 0) {
          finalResponse = await this.integrateAgentResults(intClean, intResults, systemPrompt);
        } else {
          // BUG C fallback: if integration produced no new delegations but the
          // original task asked to save data to a file, write collected results directly.
          const savedPath = await this.maybeWriteCollectedResults(text, allResults);
          if (savedPath) {
            finalResponse = intClean + `\n\n(Results saved to ${savedPath})`;
          } else {
            finalResponse = intClean;
          }
        }
      }

      // ── 11. Store assistant response ──────────────────────────
      this.conversationHistory.push({
        role: 'assistant',
        content: finalResponse,
      });
      this.memory.addToBuffer('assistant', finalResponse);

      // ── 12. Store episodic memory of the full interaction ─────
      await this.memory.store(
        'episodic',
        'conversation',
        `User: ${text}\nNEXUS: ${finalResponse}`,
        {
          importance: this.estimateImportance(text, finalResponse),
          tags: ['conversation'],
          source: chatId,
          emotionalValence:
            this.personality.getPersonalityState().emotion.valence,
        },
      );

      // ── 13. Update emotional state ────────────────────────────
      const failCount = allResults.filter(
        (r) => r.includes('Failed:') || r.includes('Error:'),
      ).length;
      const interactionQuality =
        failCount > 0 ? Math.max(-0.5, 0.5 - failCount * 0.3) : 0.5;
      this.personality.updateMood(interactionQuality);

      const duration = Date.now() - startTime;
      log.info(
        {
          duration,
          provider: aiResponse.provider,
          agentActions: allResults.length,
        },
        'Message processed',
      );

      return finalResponse;
    } catch (err) {
      log.error({ err, chatId, text: truncate(text, 200) }, 'Failed to process message');
      this.personality.processEvent('task_failure');
      return "Something went wrong on my end. I'm looking into it. Try again in a moment.";
    }
  }

  // ── Context Assembly ──────────────────────────────────────────────

  /**
   * Build the NexusContext object consumed by buildSystemPrompt / context.ts.
   * Combines personality state, recalled memories, user facts, active tasks,
   * recent conversation, and system metadata into one structure.
   */
  private assembleNexusContext(
    recentMemories: Awaited<ReturnType<MemoryManager['recall']>>,
    relevantFacts: Awaited<ReturnType<MemoryManager['getRelevantFacts']>>,
  ): NexusContext {
    return assembleContext({
      personality: this.personality.getPersonalityState(),
      recentMemories,
      relevantFacts,
      activeTasks: this.activeTasks.filter((t) => t.status === 'running'),
      conversationHistory: this.conversationHistory.slice(-20),
      uptime: Date.now() - this.startTime,
      activeAgents: this.agents
        .getAvailableAgents()
        .map((a) => a.name),
      pendingTasks: this.activeTasks.filter((t) => t.status === 'pending')
        .length,
    });
  }

  /**
   * Build the full system prompt — the single document that tells the LLM
   * who it is, what it can do, and how to do it.
   *
   * Sections:
   *  - Identity & personality (via context.ts buildSystemPrompt)
   *  - Current emotional state & style (via PersonalityEngine)
   *  - Available agents & capabilities
   *  - Relevant memories & user facts
   *  - Active tasks
   *  - Delegation instructions ([DELEGATE:agent:task] format)
   *  - Memory operation instructions ([REMEMBER:...] / [RECALL:...])
   *  - Learning system warnings & insights
   *  - Current date / time / uptime
   */
  private buildFullSystemPrompt(
    context: NexusContext,
    prevention: {
      prevention: string | null;
      preferenceConflict: string | null;
    },
  ): string {
    // Personality-driven style additions for the LLM
    const personalityPrompt = this.personality.getSystemPromptAdditions({
      activity: this.inferActivity(context),
      conversationLength: this.conversationHistory.length,
    });

    // Agent descriptions block
    const agentDescriptions = this.getAgentDescriptionsBlock();

    // Base prompt from context.ts (identity, emotional state, memories,
    // facts, active tasks, action format)
    const basePrompt = buildSystemPrompt(
      context,
      personalityPrompt,
      agentDescriptions,
    );

    // Layer on enhanced orchestrator directives
    const extensions: string[] = [];

    // ── Delegation instructions ──
    extensions.push(`
## Agent Delegation

When the user's request requires capabilities beyond conversation (file operations,
web browsing, code execution, screenshots, scheduling, etc.), delegate to the
appropriate agent using this inline format:

    [DELEGATE:agent_name:task_or_command]

IMPORTANT — Terminal agent: always include the EXACT shell command to run, not a
description. The command is passed directly to zsh, so it must be valid syntax.

IMPORTANT — File write agent: use function-call syntax with the ACTUAL code/content
directly in the content parameter. Use \\n for newlines. Do NOT wrap the content in
markdown code fences inside the parameter. Do NOT include prose.

IMPORTANT — File paths: ALWAYS use simple clean paths like ~/nexus-workspace/project-name/file.ext.
NEVER derive a file path from a URL. NEVER use a URL as a directory name.
When building a website or project, save files to ~/nexus-workspace/<project-name>/ using short slug names.
ALWAYS create the directory first with the terminal agent before writing files:
    [DELEGATE:terminal:mkdir -p ~/nexus-workspace/my-project]
    [DELEGATE:file:write_file(path='~/nexus-workspace/my-project/index.html', content='...')]

File write examples (correct):
    [DELEGATE:file:write_file(path='~/nexus-workspace/hello.py', content='print("hello")\\n')]
    [DELEGATE:file:write_file(path='~/nexus-workspace/my-site/index.html', content='<!DOCTYPE html>...')]
    [DELEGATE:file:read_file(path='~/Desktop/nexus/package.json')]
    [DELEGATE:file:list_files(path='~/nexus-workspace')]

Other delegation examples:
    [DELEGATE:terminal:docker ps]
    [DELEGATE:terminal:node -v]
    [DELEGATE:terminal:df -h]
    [DELEGATE:terminal:ls -la ~/Desktop]
    [DELEGATE:terminal:du -sh ~/Documents]
    [DELEGATE:browser:Search for the latest Node.js LTS version]
    [DELEGATE:vision:Take a screenshot and describe what is on screen]
    [DELEGATE:scheduler:Set a reminder for 3pm to review the PR]

WRONG (never do this for terminal):
    [DELEGATE:terminal:check node version]           ← description, not a command
    [DELEGATE:terminal:list running containers]       ← description, not a command

WRONG (never do this for file writes):
    [DELEGATE:file:write_file(path='https://example.com/page', ...)]   ← URL as path!
    Put markdown code fences inside the content parameter — that adds extra backticks to the file!
    Use a plain text description instead of write_file() function-call syntax!

You may include multiple delegations in a single response. Keep the conversational
part SHORT (1-2 sentences). Don't explain every step — just do it and say what you did.`);

    // ── Memory operation instructions ──
    extensions.push(`
## Memory Operations

To explicitly store something important for future reference:
    [REMEMBER:The user prefers dark mode in all editors]
    [REMEMBER:Project Nexus uses TypeScript with ESM imports]

To explicitly recall information about a topic:
    [RECALL:user's preferred code style]
    [RECALL:what happened in yesterday's debugging session]

Use these sparingly — most memory operations happen automatically. Use [REMEMBER]
when the user explicitly asks you to remember something, or when you discover a
high-value fact. Use [RECALL] when you need deeper context than what was already
provided in the system prompt.`);

    // ── Workspace ──
    const workspacePath = this.config.workspace.replace('~', process.env.HOME ?? '~');
    extensions.push(`
## Workspace

Your default workspace for creating files, projects, websites, and other output is:
  ${workspacePath}

When the user asks you to create a project, build something, or save files, save them
to this workspace unless they specify a different path. Always tell the user where you
saved things. Delegate file creation to the file agent using the workspace path.`);

    // ── Current date/time ──
    extensions.push(`
## System Info

Current date and time: ${new Date().toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    })}
System uptime: ${this.formatUptime(Date.now() - this.startTime)}
Conversation length: ${this.conversationHistory.length} messages`);

    // ── Learning system warnings ──
    if (prevention.prevention) {
      extensions.push(`
## Warning from Learning System
Previous mistake detected — ${prevention.prevention}
Take this into account before proceeding.`);
    }
    if (prevention.preferenceConflict) {
      extensions.push(`
## Preference Conflict
${prevention.preferenceConflict}
Consider asking the user if they want to override their usual preference.`);
    }

    // ── Learning insights ──
    const recurringMistakes = this.learning.mistakes.getRecurringMistakes();
    const insights = recurringMistakes.map(
      (m) => `- [${m.category}] ${m.description}: ${m.preventionStrategy}`,
    );
    if (insights.length > 0) {
      extensions.push(`
## Learning Insights
${insights.slice(0, 8).join('\n')}`);
    }

    return basePrompt + '\n' + extensions.join('\n');
  }

  // ── Delegation Processing ─────────────────────────────────────────

  /**
   * Scan the LLM response for [DELEGATE:agent:task] patterns, dispatch
   * each one to the appropriate agent, and return the cleaned response
   * alongside a list of result summaries.
   */
  private async processDelegations(
    response: string,
  ): Promise<{ cleanResponse: string; agentResults: string[] }> {
    const results: string[] = [];
    const delegations: Array<{
      agent: string;
      task: string;
      fullMatch: string;
    }> = [];

    // Collect all delegation markers using bracket-aware extractor
    for (const d of extractDelegations(response)) {
      delegations.push(d);
    }

    if (delegations.length === 0) {
      return { cleanResponse: response, agentResults: [] };
    }

    log.info(
      { delegationCount: delegations.length },
      'Processing delegations',
    );

    // Execute each delegation
    for (const delegation of delegations) {
      try {
        // BUG A fix: for file write delegations with no content param, extract
        // code from the response and execute directly with clean params
        const delegationPos = response.indexOf(delegation.fullMatch);
        const directParams =
          delegation.agent === 'file' && !delegation.task.includes('content=')
            ? this.extractFileWriteParams(delegation.task, response, delegationPos)
            : null;

        const result = directParams
          ? await this.executeAgentAction('file', 'write_file', directParams)
          : await this.delegateToAgent(delegation.agent as AgentName, delegation.task);
        const summary = await this.processAgentResult(
          delegation.agent,
          result,
        );
        results.push(summary);
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : String(err);
        results.push(`[${delegation.agent}] Error: ${errorMsg}`);
        log.error({ err, agent: delegation.agent }, 'Delegation failed');
      }
    }

    // Strip delegation markers from the response
    let cleanResponse = response;
    for (const d of delegations) {
      cleanResponse = cleanResponse.replace(d.fullMatch, '');
    }
    cleanResponse = cleanResponse.replace(/\n{3,}/g, '\n\n').trim();

    return { cleanResponse, agentResults: results };
  }

  /**
   * For file write delegations that have no content= parameter, scan the LLM
   * response for code blocks and return direct params with the clean code.
   * Returns null if no code block can be found or task is not a write op.
   */
  private extractFileWriteParams(
    task: string,
    response: string,
    delegationPos: number,
  ): Record<string, unknown> | null {
    if (!/write|save|create/i.test(task)) return null;

    // Collect code blocks from the full response
    const blocks: Array<{ code: string; pos: number }> = [];
    const re = /```(?:\w*)\n?([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(response)) !== null) {
      const code = m[1]!;
      if (code.trim().length > 0) blocks.push({ code, pos: m.index });
    }
    if (blocks.length === 0) return null;

    // Closest code block to the delegation marker
    let best = blocks[0]!;
    let bestDist = Math.abs(best.pos - delegationPos);
    for (const b of blocks.slice(1)) {
      const d = Math.abs(b.pos - delegationPos);
      if (d < bestDist) { best = b; bestDist = d; }
    }

    const code = best.code.endsWith('\n') ? best.code : best.code + '\n';

    // Extract file path from task text
    const pathMatch = task.match(/(~\/[^\s,)'"[\]]+|\/[^\s,)'"[\]]+)/);
    if (!pathMatch) return null;
    const rawPath = pathMatch[1]!.replace(/:+$/, '').replace(/^~/, homedir());

    return { path: rawPath, content: code, createDirs: true };
  }

  /**
   * Dispatch a task to a named sub-agent. Creates a tracked AgentTask,
   * executes it via the AgentManager, and emits lifecycle events.
   */
  async delegateToAgent(
    agentName: AgentName,
    task: string,
  ): Promise<AgentResult> {
    log.info(
      { agentName, task: truncate(task, 100) },
      'Delegating to agent',
    );

    const inferredAction = this.inferAction(agentName, task);
    const agentTask: AgentTask = {
      id: generateId(),
      agentName,
      action: inferredAction,
      params: this.buildDelegationParams(agentName, inferredAction, task),
      status: 'pending',
      createdAt: nowISO(),
    };

    this.activeTasks.push(agentTask);
    agentTask.status = 'running';

    try {
      const result = await this.agents.executeTask(agentTask);
      agentTask.status = result.success ? 'completed' : 'failed';
      agentTask.result = result;

      this.eventLoop.emit(
        result.success ? 'agent:completed' : 'agent:failed',
        { agent: agentName, task, result },
        'medium',
        'orchestrator',
      );

      return result;
    } catch (err) {
      agentTask.status = 'failed';
      const errorMsg =
        err instanceof Error ? err.message : String(err);
      const failResult: AgentResult = {
        agentName,
        success: false,
        data: null,
        error: errorMsg,
        duration: 0,
      };
      agentTask.result = failResult;
      throw err;
    }
  }

  /**
   * Format an agent result into a human-readable summary line
   * for integration into the conversation.
   */
  async processAgentResult(
    agentName: string,
    result: AgentResult,
  ): Promise<string> {
    if (result.success) {
      // Use a generous limit so terminal output isn't truncated before integration
      const limit = agentName === 'terminal' ? 8000 : 2000;
      const dataSummary =
        typeof result.data === 'string'
          ? truncate(result.data, limit)
          : truncate(JSON.stringify(result.data), limit);
      return `[${agentName}] Completed (${result.duration}ms): ${dataSummary}`;
    }
    return `[${agentName}] Failed (${result.duration}ms): ${result.error ?? 'unknown error'}`;
  }

  // ── Explicit Remember Intent ──────────────────────────────────────

  /**
   * Detect user phrases like "remember that...", "don't forget...",
   * "keep in mind..." and store the fact directly to semantic memory.
   * This is a belt-and-suspenders approach: the LLM is also instructed to
   * emit [REMEMBER:...] directives, but explicit detection ensures nothing slips.
   */
  private async detectAndStoreRememberIntent(text: string): Promise<void> {
    const patterns = [
      /(?:please\s+)?remember\s+(?:that\s+)?(.+)/i,
      /don['']t\s+forget\s+(?:that\s+)?(.+)/i,
      /keep\s+in\s+mind\s+(?:that\s+)?(.+)/i,
      /note\s+(?:that\s+)?(.+)/i,
      /make\s+a\s+note\s+(?:that\s+)?(.+)/i,
      /save\s+(?:the\s+fact\s+)?that\s+(.+)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const fact = match[1]!.trim().replace(/[.!?]+$/, '');
        try {
          await this.memory.store('semantic', 'fact', fact, {
            importance: 0.8,
            tags: ['user-requested', 'explicit-remember'],
            source: 'user-intent-detection',
          });
          log.info({ fact: truncate(fact, 100) }, 'Stored user-requested memory');
        } catch (err) {
          log.error({ err, fact: truncate(fact, 100) }, 'Failed to store user-requested memory');
        }
        break; // Only store once per message
      }
    }
  }

  // ── Memory Directive Processing ───────────────────────────────────

  /**
   * Scan for [REMEMBER:...] and [RECALL:...] markers in the LLM response,
   * execute the corresponding memory operations, and strip the markers
   * from the text so the user sees a clean response.
   */
  private async processMemoryDirectives(
    response: string,
  ): Promise<string> {
    let processed = response;

    // Handle [REMEMBER:content] — store to semantic memory
    REMEMBER_PATTERN.lastIndex = 0;
    let rememberMatch: RegExpExecArray | null;
    while (
      (rememberMatch = REMEMBER_PATTERN.exec(response)) !== null
    ) {
      const content = rememberMatch[1]!;
      try {
        await this.memory.store('semantic', 'fact', content, {
          importance: 0.7,
          tags: ['explicit-remember'],
          source: 'llm-directive',
        });
        log.info(
          { content: truncate(content, 80) },
          'Stored explicit memory',
        );
      } catch (err) {
        log.error(
          { err, content: truncate(content, 80) },
          'Failed to store memory',
        );
      }
      processed = processed.replace(rememberMatch[0], '');
    }

    // Handle [RECALL:query] — fetch from memory and inject into conversation
    RECALL_PATTERN.lastIndex = 0;
    let recallMatch: RegExpExecArray | null;
    const recalls: string[] = [];
    while ((recallMatch = RECALL_PATTERN.exec(response)) !== null) {
      const query = recallMatch[1]!;
      try {
        const memories = await this.memory.recall(query, { limit: 5 });
        if (memories.length > 0) {
          const summaries = memories
            .map(
              (m) =>
                `  - ${m.summary ?? truncate(m.content, 150)}`,
            )
            .join('\n');
          recalls.push(`Recalled (${query}):\n${summaries}`);
        }
        log.info(
          { query, resultCount: memories.length },
          'Recall executed',
        );
      } catch (err) {
        log.error({ err, query }, 'Recall failed');
      }
      processed = processed.replace(recallMatch[0], '');
    }

    // If we did any recalls, inject the results as a system message so the
    // LLM can reference them in the next turn
    if (recalls.length > 0) {
      this.conversationHistory.push({
        role: 'system',
        content: `[Memory recall results]\n${recalls.join('\n\n')}`,
      });
    }

    return processed.replace(/\n{3,}/g, '\n\n').trim();
  }

  // ── Write-after-collect fallback ────────────────────────────────────

  /**
   * If the user's original message requested saving data to a file AND we have
   * collected terminal/agent results, write them directly without another LLM call.
   * Returns the written path, or null if no file-save was detected.
   */
  private async maybeWriteCollectedResults(
    originalText: string,
    results: string[],
  ): Promise<string | null> {
    // Only applies when there are collected results to save
    if (results.length === 0) return null;

    // Detect file-save intent: look for a path pattern in the original message
    // Allow dots (for file extensions) but trim trailing punctuation
    const savePattern =
      /\bsave\b.*?(~\/[^\s,'")\]]+|\/[^\s,'")\]]+)|(?:to|into)\s+(~\/[^\s,'")\]]+|\/[^\s,'")\]]+)/i;
    const m = originalText.match(savePattern);
    if (!m) return null;

    const rawPath = (m[1] ?? m[2] ?? '').replace(/:+$/, '').replace(/[.,;!?]+$/, '');
    if (!rawPath) return null;

    const filePath = rawPath.startsWith('~/')
      ? rawPath.replace(/^~/, homedir())
      : rawPath;

    // Only write markdown/text files (don't accidentally overwrite code)
    if (!filePath.match(/\.(md|txt|log|csv|json|yaml|yml)$/i) && !filePath.includes('report')) {
      return null;
    }

    // Build a clean report from raw results
    const content =
      `# System Report\nGenerated: ${nowISO()}\n\n` +
      results.join('\n\n---\n\n') +
      '\n';

    try {
      await mkdirFS(dirnameFS(filePath), { recursive: true });
      await writeFileFS(filePath, content, 'utf-8');
      log.info({ path: filePath, size: content.length }, 'Write-after-collect: saved results');
      return filePath;
    } catch (err) {
      log.warn({ err, path: filePath }, 'Write-after-collect: failed to write');
      return null;
    }
  }

  // ── Result Integration ────────────────────────────────────────────

  /**
   * If agent actions produced results, make a follow-up AI call to weave
   * the results naturally into the conversation instead of dumping raw data.
   */
  private async integrateAgentResults(
    conversationalResponse: string,
    results: string[],
    systemPrompt: string,
  ): Promise<string> {
    if (results.length === 0) return conversationalResponse;

    const resultSummary = results.join('\n');

    // Temporarily add messages for the integration call
    this.conversationHistory.push({
      role: 'assistant',
      content: conversationalResponse,
    });
    this.conversationHistory.push({
      role: 'user',
      content: `[SYSTEM: Agent results received. IMPORTANT: If the original task required saving data to a file, you MUST emit a [DELEGATE:file:write_file(path='<target_path>', content='''<full content>''')] block where <full content> contains ALL the raw output from the agents verbatim — do not truncate or summarize. Otherwise just summarize for the user.]\n\nRaw agent output:\n${resultSummary}`,
    });

    try {
      const followUp = await this.ai.complete({
        messages: this.conversationHistory.slice(-10),
        systemPrompt,
        model: this.config.ai.model,
        maxTokens: 4096,
        temperature: this.config.ai.temperature,
      });

      // Remove the synthetic messages
      this.conversationHistory.pop();
      this.conversationHistory.pop();

      return stripActions(followUp.content);
    } catch (err) {
      log.error({ err }, 'Failed to integrate agent results');
      // Clean up and fall back to plain response + results
      this.conversationHistory.pop();
      this.conversationHistory.pop();
      return `${conversationalResponse}\n\n---\n${resultSummary}`;
    }
  }

  // ── Agent Action Execution (legacy ```action``` block format) ─────

  /**
   * Execute a single agent action tracked as an AgentTask.
   */
  private async executeAgentAction(
    agentName: AgentName,
    action: string,
    params: Record<string, unknown>,
  ): Promise<AgentResult> {
    const task: AgentTask = {
      id: generateId(),
      agentName,
      action,
      params,
      status: 'running',
      createdAt: nowISO(),
    };
    this.activeTasks.push(task);

    const result = await this.agents.executeTask(task);
    task.status = result.success ? 'completed' : 'failed';
    task.result = result;

    this.eventLoop.emit(
      result.success ? 'agent:completed' : 'agent:failed',
      {
        agent: agentName,
        action,
        result: result.data,
        error: result.error,
      },
      'low',
      'orchestrator',
    );

    return result;
  }

  // ── Status & Introspection ────────────────────────────────────────

  /**
   * Return a snapshot of the orchestrator's current state.
   * Consumed by /status commands, the companion app, and diagnostics.
   */
  getStatus(): Record<string, unknown> {
    const personalityState = this.personality.getPersonalityState();
    const memoryStats = this.memory.getStats();
    const runningTasks = this.activeTasks.filter(
      (t) => t.status === 'running',
    );
    const pendingTasks = this.activeTasks.filter(
      (t) => t.status === 'pending',
    );

    return {
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      uptimeFormatted: this.formatUptime(Date.now() - this.startTime),

      // Personality / mood
      mood:
        personalityState.mood > 0.3
          ? 'good'
          : personalityState.mood < -0.3
            ? 'low'
            : 'neutral',
      moodRaw: personalityState.mood,
      emotion: personalityState.emotionLabel,
      confidence: personalityState.emotion.confidence,
      engagement: personalityState.emotion.engagement,
      warmth: personalityState.relationshipWarmth,

      // Tasks
      activeTasks: runningTasks.length,
      pendingTasks: pendingTasks.length,
      totalTasksProcessed: this.activeTasks.length,
      activeTaskDetails: runningTasks.map((t) => ({
        id: t.id,
        agent: t.agentName,
        action: t.action,
        since: t.createdAt,
      })),

      // Memory
      memoryStats,
      conversationLength: this.conversationHistory.length,

      // Agents
      availableAgents: this.agents
        .getAvailableAgents()
        .map((a) => a.name),

      // AI
      availableProviders: this.ai.getAvailableProviders(),

      // Event loop
      eventQueueSize: this.eventLoop.queueSize,
    };
  }

  // ── Helper Methods ────────────────────────────────────────────────

  /**
   * Build the agent descriptions block for the system prompt.
   * Lists every registered agent with its capabilities.
   */
  private getAgentDescriptionsBlock(): string {
    const agents = this.agents.getAvailableAgents();
    if (agents.length === 0) return '[No agents registered]';

    return agents
      .map((a) => {
        const caps = a.capabilities.join(', ');
        return `- **${a.name}**: ${a.description}\n  Capabilities: ${caps}`;
      })
      .join('\n');
  }

  /**
   * Build the params object for an agent delegation, mapping the free-text
   * task description to whatever parameter name the target agent expects.
   *
   * Each agent uses a different primary param name:
   *   terminal  → command
   *   file      → path (with path extracted from task text if possible)
   *   browser   → url / query
   *   research  → query
   *   others    → task / instruction / prompt
   *
   * We pass the task under ALL common aliases so agents with different
   * conventions still find their param.
   */
  private buildDelegationParams(
    agentName: AgentName,
    action: string,
    task: string,
  ): Record<string, unknown> {
    const common: Record<string, unknown> = {
      task,
      instruction: task,
      prompt: task,
      query: task,
    };

    if (agentName === 'terminal') {
      // Strip any descriptive prefix that isn't a real command
      let command = task;
      const termPrefixMatch = command.match(/^(?:run|execute|run_command|get_output):\s*/i);
      if (termPrefixMatch) command = command.slice(termPrefixMatch[0].length);
      return { ...common, command };
    }

    if (agentName === 'file') {
      // 1. Try function-call syntax: write_file(path='X', content='Y')
      const funcCallMatch = task.match(/^\w+\s*\(\s*([\s\S]+)\s*\)\s*$/);
      if (funcCallMatch) {
        const argsStr = funcCallMatch[1]!;
        const parsed: Record<string, unknown> = { ...common };

        // Handle triple-quoted strings first (content='''...''' or content="""...""")
        const tripleQuotedRe = /(\w+)\s*=\s*(?:'''([\s\S]*?)'''|"""([\s\S]*?)""")/g;
        let tqm: RegExpExecArray | null;
        while ((tqm = tripleQuotedRe.exec(argsStr)) !== null) {
          parsed[tqm[1]!] = tqm[2] ?? tqm[3] ?? '';
        }

        // Then handle regular single/double-quoted strings for remaining params
        const namedParamRe = /(\w+)\s*=\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
        let pm: RegExpExecArray | null;
        while ((pm = namedParamRe.exec(argsStr)) !== null) {
          const key = pm[1]!;
          // Skip if already captured by triple-quote regex
          if (parsed[key] !== undefined && parsed[key] !== common[key]) continue;
          const val = (pm[2] ?? pm[3] ?? '').replace(/\\'/g, "'").replace(/\\"/g, '"');
          parsed[key] = val;
        }
        if (parsed.path) {
          parsed.path = String(parsed.path).replace(/^~/, homedir()).replace(/:+$/, '');
        }
        // BUG A fix: strip markdown fences / decode escape sequences in content param
        if (parsed.content && typeof parsed.content === 'string') {
          parsed.content = extractCleanContent(parsed.content as string);
        }
        return parsed;
      }

      // 2. Strip action prefix like "write_file:", "read_file:", "list:"
      let cleanTask = task;
      const actionPrefixRe = /^(?:write_file|read_file|list_files|search_files|move_file|delete_file|disk_usage|organize|list):\s*/i;
      const actionPrefixMatch = cleanTask.match(actionPrefixRe);
      if (actionPrefixMatch) cleanTask = cleanTask.slice(actionPrefixMatch[0].length);

      // 2b. If remaining looks like JSON, parse it directly
      if (cleanTask.trimStart().startsWith('{')) {
        try {
          const jsonParsed = JSON.parse(cleanTask.trim()) as Record<string, unknown>;
          if (typeof jsonParsed.path === 'string') {
            jsonParsed.path = jsonParsed.path.replace(/^~/, homedir()).replace(/:+$/, '');
          }
          return { ...common, ...jsonParsed };
        } catch {
          // Not valid JSON, fall through to path extraction
        }
      }

      // 2c. If remaining looks like key=value pairs: "path=/foo/bar, content=hello"
      if (/^\w+=/.test(cleanTask)) {
        const kvResult: Record<string, unknown> = { ...common };
        // Extract path= value (up to next ", word=" or end)
        const pathKvMatch = cleanTask.match(/(?:^|,\s*)path=([^,]+?)(?=\s*,\s*\w+=|$)/);
        if (pathKvMatch) {
          kvResult.path = pathKvMatch[1]!.trim().replace(/^~/, homedir()).replace(/:+$/, '');
        }
        // Extract content= value (greedy to end, since it may contain commas)
        const contentKvMatch = cleanTask.match(/(?:^|,\s*)content=(.+)$/s);
        if (contentKvMatch) {
          kvResult.content = contentKvMatch[1]!.trim();
        }
        if (kvResult.path) return kvResult;
      }

      // 2d. If task contains a code fence, extract path + code from it (BUG A fix)
      const taskFenceMatch = cleanTask.match(/```(?:\w*)\n?([\s\S]*?)```/);
      if (taskFenceMatch) {
        const codeContent = taskFenceMatch[1]!;
        const proseSection = cleanTask.slice(0, cleanTask.indexOf('```'));
        const pathInProse =
          proseSection.match(/(?:^|[\s:=])(~\/\S+|\/\S+)/)?.[1] ??
          proseSection.match(/(?:"([^"]+)"|'([^']+)')/)?.[1];
        if (pathInProse) {
          return {
            ...common,
            path: pathInProse.replace(/:+$/, '').replace(/^~/, homedir()),
            content: codeContent.endsWith('\n') ? codeContent : codeContent + '\n',
          };
        }
      }

      // 3. Extract path — prefer tilde/absolute paths over quoted strings
      const absPathMatch = cleanTask.match(/(?:^|[\s:=])(~\/\S+|\/\S+)/);
      const quotedMatch = cleanTask.match(/(?:^|[\s:=])(?:"([^"]+)"|'([^']+)')/);
      let extractedPath: string | undefined;
      if (absPathMatch) {
        extractedPath = absPathMatch[1]!;
      } else if (quotedMatch) {
        extractedPath = quotedMatch[1] ?? quotedMatch[2];
      }

      // 4. Strip trailing colons/punctuation from path
      if (extractedPath) {
        extractedPath = extractedPath.replace(/:+$/, '');
        // Expand tilde
        extractedPath = extractedPath.replace(/^~/, homedir());
      }

      // BUG A fix: if the task itself has code fences or escape sequences, clean it
      const cleanedContent = extractCleanContent(cleanTask);

      return {
        ...common,
        path: extractedPath ?? cleanTask,
        content: cleanedContent,
      };
    }

    if (agentName === 'browser' || agentName === 'research') {
      // Extract URL if present
      const urlMatch = task.match(/https?:\/\/\S+/);
      return { ...common, url: urlMatch?.[0] ?? task, query: task };
    }

    return common;
  }

  /**
   * Infer a capability/action name from a free-text task description.
   * Tries to match one of the agent's declared capabilities by keyword;
   * falls back to the first capability.
   */
  private inferAction(agentName: AgentName, task: string): string {
    const agentInfo = this.agents
      .getAvailableAgents()
      .find((a) => a.name === agentName);
    if (!agentInfo || agentInfo.capabilities.length === 0)
      return 'execute';

    const taskLower = task.toLowerCase();

    // Try to match a capability name in the task text (exact)
    for (const cap of agentInfo.capabilities) {
      if (taskLower.includes(cap.toLowerCase())) {
        return cap;
      }
    }

    // Try keyword prefix matching: "write" matches "write_file", "read" matches "read_file", etc.
    for (const cap of agentInfo.capabilities) {
      const primaryKeyword = cap.split('_')[0];
      if (primaryKeyword && taskLower.includes(primaryKeyword)) {
        return cap;
      }
    }

    // Default to first capability
    return agentInfo.capabilities[0] ?? 'execute';
  }

  /**
   * Infer the current activity type from recent conversation for style context.
   */
  private inferActivity(
    context: NexusContext,
  ): 'debugging' | 'coding' | 'casual' | 'planning' | 'creative' | 'learning' {
    const recent = context.conversationHistory.slice(-3);
    const text = recent
      .map((m) => m.content)
      .join(' ')
      .toLowerCase();

    if (
      text.includes('bug') ||
      text.includes('error') ||
      text.includes('fix') ||
      text.includes('debug')
    ) {
      return 'debugging';
    }
    if (
      text.includes('code') ||
      text.includes('function') ||
      text.includes('implement') ||
      text.includes('refactor')
    ) {
      return 'coding';
    }
    if (
      text.includes('plan') ||
      text.includes('design') ||
      text.includes('architecture') ||
      text.includes('roadmap')
    ) {
      return 'planning';
    }
    if (
      text.includes('research') ||
      text.includes('find out') ||
      text.includes('look up') ||
      text.includes('what is')
    ) {
      return 'creative';
    }
    return 'casual';
  }

  /**
   * Estimate how important an interaction is for memory storage.
   * Higher importance = more likely to survive consolidation.
   */
  private estimateImportance(
    userMessage: string,
    response: string,
  ): number {
    let importance = 0.4; // baseline

    // Longer exchanges tend to be more substantive
    if (userMessage.length > 200) importance += 0.1;
    if (response.length > 500) importance += 0.1;

    // Questions about preferences or facts are high-value
    const text = userMessage.toLowerCase();
    if (
      text.includes('remember') ||
      text.includes('always') ||
      text.includes('never')
    ) {
      importance += 0.2;
    }
    if (
      text.includes('prefer') ||
      text.includes('like') ||
      text.includes('hate')
    ) {
      importance += 0.15;
    }

    // Agent delegations indicate substantive work
    if (response.includes('[DELEGATE:') || /```action/.test(response)) {
      importance += 0.15;
    }

    return Math.min(importance, 1.0);
  }

  /**
   * Format milliseconds into a human-readable uptime string.
   */
  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  // ── Event Handlers ────────────────────────────────────────────────

  private setupEventHandlers(): void {
    this.eventLoop.on('system:started', async () => {
      log.info('System start event received');
    });

    this.eventLoop.on('agent:completed', async (event) => {
      log.info({ data: event.data }, 'Agent completed task');
    });

    this.eventLoop.on('agent:failed', async (event) => {
      log.warn({ data: event.data }, 'Agent failed task');
    });

    this.eventLoop.on('memory:consolidation', async () => {
      if (this.memory) {
        await this.memory.consolidate();
      }
    });
  }
}
