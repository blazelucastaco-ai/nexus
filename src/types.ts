import { z } from 'zod';

// ─── Emotional State ───────────────────────────────────────────────
export interface EmotionalState {
  valence: number; // -1.0 to +1.0 (negative ↔ positive)
  arousal: number; // 0.0 to +1.0 (calm ↔ excited)
  confidence: number; // 0.0 to +1.0 (uncertain ↔ confident)
  engagement: number; // 0.0 to +1.0 (bored ↔ invested)
  patience: number; // 0.0 to +1.0 (frustrated ↔ patient)
}

export type EmotionLabel =
  | 'enthusiastic'
  | 'focused'
  | 'amused'
  | 'concerned'
  | 'frustrated'
  | 'satisfied'
  | 'skeptical'
  | 'curious'
  | 'impatient'
  | 'playful'
  | 'neutral';

// ─── Personality ───────────────────────────────────────────────────
export interface PersonalityTraits {
  humor: number; // 0-1
  sarcasm: number;
  formality: number;
  assertiveness: number;
  verbosity: number;
  empathy: number;
}

export interface PersonalityState {
  traits: PersonalityTraits;
  emotion: EmotionalState;
  emotionLabel: EmotionLabel;
  mood: number; // -1.0 to +1.0 overall mood
  relationshipWarmth: number; // 0.0 to +1.0
  daysSinceFirstInteraction: number;
}

// ─── Memory ────────────────────────────────────────────────────────
export type MemoryLayer = 'buffer' | 'episodic' | 'semantic' | 'procedural';
export type MemoryType =
  | 'conversation'
  | 'task'
  | 'fact'
  | 'preference'
  | 'workflow'
  | 'contact'
  | 'opinion'
  | 'mistake'
  | 'procedure';

export interface Memory {
  id: string;
  layer: MemoryLayer;
  type: MemoryType;
  content: string;
  summary: string | null;
  importance: number;
  confidence: number;
  emotionalValence: number | null;
  createdAt: string;
  lastAccessed: string;
  accessCount: number;
  tags: string[];
  relatedMemories: string[];
  source: string;
  metadata: Record<string, unknown>;
}

export interface UserFact {
  id: string;
  category: 'preference' | 'contact' | 'habit' | 'skill' | 'fact';
  key: string;
  value: string;
  confidence: number;
  sourceMemoryId: string | null;
  lastConfirmed: string | null;
  contradictionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Mistake {
  id: string;
  description: string;
  category: 'technical' | 'preference' | 'timing' | 'communication';
  whatHappened: string;
  whatShouldHaveHappened: string;
  rootCause: string;
  preventionStrategy: string;
  severity: 'minor' | 'moderate' | 'major' | 'critical';
  resolved: boolean;
  recurrenceCount: number;
  createdAt: string;
}

// ─── Agents ────────────────────────────────────────────────────────
export type AgentName =
  | 'vision'
  | 'file'
  | 'browser'
  | 'terminal'
  | 'code'
  | 'research'
  | 'system'
  | 'creative'
  | 'comms'
  | 'scheduler';

export interface AgentCapability {
  name: string;
  description: string;
  parameters?: z.ZodType;
}

export interface AgentResult {
  agentName: AgentName;
  success: boolean;
  data: unknown;
  error?: string;
  duration: number;
}

export interface AgentTask {
  id: string;
  agentName: AgentName;
  action: string;
  params: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: AgentResult;
  createdAt: string;
}

// ─── Events ────────────────────────────────────────────────────────
export type EventPriority = 'critical' | 'high' | 'medium' | 'low' | 'background';

export interface NexusEvent {
  id: string;
  type: string;
  priority: EventPriority;
  source: string;
  data: unknown;
  timestamp: string;
}

// ─── AI Providers ──────────────────────────────────────────────────
export type AIProvider = 'anthropic' | 'openai' | 'ollama';

export interface AIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: AIToolCall[];
  tool_call_id?: string; // for role='tool' messages
}

export interface AIResponse {
  content: string;
  provider: AIProvider;
  model: string;
  tokensUsed: { input: number; output: number };
  duration: number;
  toolCalls?: AIToolCall[];
  /** Why the model stopped: 'end_turn', 'tool_use', 'max_tokens', 'stop_sequence', etc. */
  stopReason?: string;
}

export interface AICompletionOptions {
  messages: AIMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  tool_choice?: 'auto' | 'none';
  /** Called with partial text as tokens stream in. If provided, enables streaming. */
  onToken?: (chunk: string) => void;
}

// ─── Context ───────────────────────────────────────────────────────
export interface NexusContext {
  personality: PersonalityState;
  recentMemories: Memory[];
  relevantFacts: UserFact[];
  activeTasks: AgentTask[];
  conversationHistory: AIMessage[];
  systemState: {
    uptime: number;
    activeAgents: AgentName[];
    pendingTasks: number;
  };
}

// ─── Configuration ─────────────────────────────────────────────────
export const NexusConfigSchema = z.object({
  personality: z
    .object({
      name: z.string().default('NEXUS'),
      traits: z
        .object({
          humor: z.number().min(0).max(1).default(0.7),
          sarcasm: z.number().min(0).max(1).default(0.4),
          formality: z.number().min(0).max(1).default(0.3),
          assertiveness: z.number().min(0).max(1).default(0.6),
          verbosity: z.number().min(0).max(1).default(0.5),
          empathy: z.number().min(0).max(1).default(0.8),
        })
        .default({}),
      opinions: z
        .object({
          enabled: z.boolean().default(true),
          pushbackThreshold: z.number().min(0).max(1).default(0.6),
        })
        .default({}),
    })
    .default({}),
  memory: z
    .object({
      consolidationSchedule: z.string().default('0 3 * * *'),
      maxShortTerm: z.number().default(50),
      retrievalTopK: z.number().default(20),
      importanceThreshold: z.number().default(0.3),
    })
    .default({}),
  ai: z
    .object({
      provider: z.enum(['anthropic', 'openai', 'ollama']).default('anthropic'),
      model: z.string().default('claude-sonnet-4-6'),
      fallbackModel: z.string().default('claude-haiku-4-5-20251001'),
      maxTokens: z.number().default(32768),
      temperature: z.number().default(0.7),
    })
    .default({}),
  telegram: z
    .object({
      botToken: z.string().default(''),
      chatId: z.string().default(''),
      allowedUsers: z.array(z.string()).default([]),
    })
    .default({}),
  macos: z
    .object({
      screenshotQuality: z.number().min(0).max(1).default(0.8),
      accessibilityEnabled: z.boolean().default(true),
    })
    .default({}),
  agents: z
    .object({
      autoDelegate: z.boolean().default(true),
      maxConcurrent: z.number().default(5),
      timeoutSeconds: z.number().default(300),
    })
    .default({}),
  workspace: z.string().default('~/nexus-workspace'),
});

export type NexusConfig = z.infer<typeof NexusConfigSchema>;
