// Nexus AI — Shared type definitions

/** Emotional state vector representing the AI's current emotional context */
export interface EmotionalState {
  /** Positive/negative sentiment (-1 = very negative, 1 = very positive) */
  valence: number;
  /** Activation level (0 = calm, 1 = highly activated) */
  arousal: number;
  /** How confident the AI is in its current response (0-1) */
  confidence: number;
  /** How engaged the AI is with the conversation (0-1) */
  engagement: number;
  /** How patient the AI is feeling (0-1) */
  patience: number;
}

/** Discrete emotion labels derived from the emotional state vector */
export type DerivedEmotion =
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

/** Memory storage layers, from short-term to long-term */
export type MemoryLayer = 'buffer' | 'working' | 'episodic' | 'semantic' | 'procedural';

/** Categories of memory content */
export type MemoryType = 'conversation' | 'task' | 'fact' | 'preference' | 'workflow' | 'mistake' | 'procedure';

/** Priority levels for internal events */
export enum EventPriority {
  CRITICAL = 0,
  HIGH = 1,
  MEDIUM = 2,
  LOW = 3,
  BACKGROUND = 4,
}

/** An internal event flowing through the Nexus event bus */
export interface NexusEvent {
  id: string;
  type: string;
  priority: EventPriority;
  payload: unknown;
  source: string;
  timestamp: Date;
}

/** Describes a single capability that a sub-agent exposes */
export interface AgentCapability {
  name: string;
  description: string;
  examples: string[];
}

/** The result returned by any agent execution */
export interface AgentResult {
  success: boolean;
  data: unknown;
  error?: string;
  /** Execution duration in milliseconds */
  duration: number;
}

/** Registration info for a sub-agent */
export interface SubAgentInfo {
  id: string;
  name: string;
  description: string;
  capabilities: AgentCapability[];
  enabled: boolean;
}

/** A memory record matching the SQL schema */
export interface Memory {
  id: string;
  layer: MemoryLayer;
  type: MemoryType;
  content: string;
  summary?: string;
  importance: number;
  confidence: number;
  emotionalValence?: number;
  createdAt: Date;
  lastAccessed: Date;
  accessCount: number;
  tags: string[];
  relatedMemories: string[];
  source: string;
  metadata: Record<string, unknown>;
}

/** An extracted fact about the user */
export interface UserFact {
  id: string;
  category: string;
  key: string;
  value: string;
  confidence: number;
  sourceMemoryId: string;
  lastConfirmed: Date;
  contradictionCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A recorded mistake for learning and prevention */
export interface Mistake {
  id: string;
  description: string;
  category: string;
  whatHappened: string;
  whatShouldHaveHappened: string;
  rootCause: string;
  preventionStrategy: string;
  severity: 'minor' | 'moderate' | 'major' | 'critical';
  resolved: boolean;
  recurrenceCount: number;
  createdAt: Date;
}

/** Tunable personality traits (each 0-1) */
export interface PersonalityConfig {
  humor: number;
  sarcasm: number;
  formality: number;
  assertiveness: number;
  verbosity: number;
  empathy: number;
}

/** Top-level Nexus configuration */
export interface NexusConfig {
  personality: PersonalityConfig;

  memory: {
    maxBufferSize: number;
    consolidationInterval: number;
    importanceThreshold: number;
    dbPath: string;
  };

  ai: {
    provider: string;
    model: string;
    fallbackModel: string;
    maxTokens: number;
    temperature: number;
  };

  telegram: {
    botToken: string;
    chatId: string;
  };

  macos: {
    enableNotifications: boolean;
    enableShortcuts: boolean;
    screenshotPath: string;
  };

  agents: {
    enabled: string[];
    maxConcurrent: number;
    timeoutMs: number;
  };
}

/** A single message in a conversation */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

/** Tracks the lifecycle of a dispatched task */
export interface TaskState {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  agentId?: string;
  /** Progress percentage, 0-100 */
  progress: number;
  result?: AgentResult;
  createdAt: Date;
  updatedAt: Date;
}
