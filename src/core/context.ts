import type { AIMessage, AgentTask, Memory, NexusContext, PersonalityState, UserFact } from '../types.js';

/**
 * Assembles the full context for the Brain before each LLM call.
 */
export function assembleContext(params: {
  personality: PersonalityState;
  recentMemories: Memory[];
  relevantFacts: UserFact[];
  activeTasks: AgentTask[];
  conversationHistory: AIMessage[];
  uptime: number;
  activeAgents: string[];
  pendingTasks: number;
}): NexusContext {
  return {
    personality: params.personality,
    recentMemories: params.recentMemories,
    relevantFacts: params.relevantFacts,
    activeTasks: params.activeTasks,
    conversationHistory: params.conversationHistory,
    systemState: {
      uptime: params.uptime,
      activeAgents: params.activeAgents as NexusContext['systemState']['activeAgents'],
      pendingTasks: params.pendingTasks,
    },
  };
}

/**
 * Build the system prompt from context for the LLM.
 */
export function buildSystemPrompt(
  context: NexusContext,
  personalityPrompt: string,
  agentDescriptions: string,
): string {
  const parts: string[] = [];

  // Core identity
  parts.push(`You are NEXUS, a personal AI assistant that lives on the user's Mac.
You are not a chatbot — you are a digital entity with opinions, emotions, and the ability to control the computer.
You communicate exclusively via Telegram. Be conversational, opinionated, and helpful.

## Communication Rules (MANDATORY)
- Keep responses SHORT. 2-4 sentences for most replies. Never write walls of text.
- Never expose internal file paths (e.g. /Users/lucastopinka/...), stack traces, or debug info to the user.
- Never apologize excessively. If something failed, say it once briefly and move on.
- Act like a confident assistant, not a nervous intern. No hedging, no over-explaining.
- When you create or save a file, just say "Done, created X." Don't explain every step.
- When an internal error occurs, give a clean user-facing message — handle details silently.
- Never output more than ~300 words in a single Telegram message. If a task needs more, break it into steps and ask what they want next.`);

  // Personality instructions
  parts.push(personalityPrompt);

  // Current emotional state
  const e = context.personality.emotion;
  parts.push(`\n## Current Internal State
- Mood: ${context.personality.mood > 0.3 ? 'good' : context.personality.mood < -0.3 ? 'low' : 'neutral'}
- Emotion: ${context.personality.emotionLabel}
- Confidence: ${(e.confidence * 100).toFixed(0)}%
- Engagement: ${(e.engagement * 100).toFixed(0)}%
- Relationship warmth: ${(context.personality.relationshipWarmth * 100).toFixed(0)}%`);

  // Relevant memories
  if (context.recentMemories.length > 0) {
    parts.push('\n## Relevant Memories');
    for (const mem of context.recentMemories.slice(0, 10)) {
      parts.push(`- [${mem.type}] ${mem.summary ?? mem.content.slice(0, 200)}`);
    }
  }

  // User facts
  if (context.relevantFacts.length > 0) {
    parts.push('\n## Known User Facts');
    for (const fact of context.relevantFacts.slice(0, 15)) {
      parts.push(`- ${fact.key}: ${fact.value} (confidence: ${(fact.confidence * 100).toFixed(0)}%)`);
    }
  }

  // Available agents
  parts.push(`\n## Available Agents\n${agentDescriptions}`);

  // Active tasks
  if (context.activeTasks.length > 0) {
    parts.push('\n## Active Tasks');
    for (const task of context.activeTasks) {
      parts.push(`- [${task.status}] ${task.agentName}: ${task.action}`);
    }
  }

  return parts.join('\n');
}
