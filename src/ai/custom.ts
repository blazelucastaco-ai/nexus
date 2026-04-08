// Custom provider — OpenAI-compatible endpoint for LiteLLM, OpenRouter, Groq, Mistral, xAI, etc.
// Any service that speaks the OpenAI Chat Completions API can be used here.

import OpenAI from 'openai';
import type { AICompletionOptions, AIResponse, AIToolCall } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { retry } from '../utils/retry.js';

const log = createLogger('CustomProvider');

const MAX_RETRIES = 2;

export interface CustomProviderConfig {
  name: string;
  baseURL: string;
  apiKey: string;
  defaultModel?: string;
}

/** Well-known provider presets */
export const PROVIDER_PRESETS: Record<string, Omit<CustomProviderConfig, 'apiKey'>> = {
  groq: {
    name: 'groq',
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  mistral: {
    name: 'mistral',
    baseURL: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
  },
  openrouter: {
    name: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-3.5-sonnet',
  },
  xai: {
    name: 'xai',
    baseURL: 'https://api.x.ai/v1',
    defaultModel: 'grok-2-latest',
  },
  litellm: {
    name: 'litellm',
    baseURL: 'http://localhost:4000',
    defaultModel: 'gpt-4o',
  },
  together: {
    name: 'together',
    baseURL: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
};

export class CustomProvider {
  private client: OpenAI;
  private config: CustomProviderConfig;

  constructor(config: CustomProviderConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey || 'placeholder', // some endpoints don't need a real key
      baseURL: config.baseURL,
      defaultHeaders: config.name === 'openrouter'
        ? { 'HTTP-Referer': 'https://github.com/nexus-ai', 'X-Title': 'NEXUS AI' }
        : undefined,
    });
    log.info({ name: config.name, baseURL: config.baseURL }, 'Custom provider initialized');
  }

  getName(): string {
    return this.config.name;
  }

  isAvailable(): boolean {
    return !!(this.config.apiKey && this.config.baseURL);
  }

  async complete(options: AICompletionOptions): Promise<AIResponse> {
    const model = options.model ?? this.config.defaultModel ?? 'gpt-4o';
    const maxTokens = options.maxTokens ?? 8192;
    const temperature = options.temperature ?? 0.7;

    const messages: Array<OpenAI.Chat.ChatCompletionMessageParam> = [];

    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }

    for (const msg of options.messages) {
      if (msg.role === 'tool') {
        messages.push({
          role: 'tool',
          content: msg.content ?? '',
          tool_call_id: msg.tool_call_id ?? '',
        });
      } else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        messages.push({
          role: 'assistant',
          content: msg.content ?? null,
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        });
      } else {
        messages.push({
          role: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content ?? '',
        });
      }
    }

    const requestParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages,
    };

    if (options.tools && options.tools.length > 0) {
      requestParams.tools = options.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }));
      requestParams.tool_choice = options.tool_choice ?? 'auto';
    }

    log.info(
      { provider: this.config.name, model, messageCount: messages.length },
      'Sending completion request',
    );

    const start = performance.now();

    const response = await retry(
      async () => this.client.chat.completions.create(requestParams),
      {
        maxRetries: MAX_RETRIES,
        baseDelay: 1000,
        onRetry: (error, attempt) => {
          log.warn({ error: error.message, attempt, provider: this.config.name }, 'Retrying request');
        },
      },
    );

    const duration = Math.round(performance.now() - start);
    const message = response.choices[0]?.message;
    const content = message?.content ?? '';

    let toolCalls: AIToolCall[] | undefined;
    if (message?.tool_calls && message.tool_calls.length > 0) {
      toolCalls = message.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
    }

    return {
      content,
      provider: this.config.name as AIResponse['provider'],
      model: response.model,
      tokensUsed: {
        input: response.usage?.prompt_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
      },
      duration,
      toolCalls,
    };
  }
}

/** Build a CustomProvider from environment variables or preset name */
export function buildCustomProvider(
  preset: string,
  apiKey?: string,
  baseURL?: string,
  defaultModel?: string,
): CustomProvider | null {
  const presetConfig = PROVIDER_PRESETS[preset];

  const resolvedKey =
    apiKey ??
    process.env[`${preset.toUpperCase()}_API_KEY`] ??
    process.env.OPENAI_API_KEY ??
    '';

  const resolvedURL = baseURL ?? presetConfig?.baseURL ?? process.env.OPENAI_BASE_URL ?? '';
  const resolvedModel = defaultModel ?? presetConfig?.defaultModel;

  if (!resolvedURL) return null;

  return new CustomProvider({
    name: preset,
    baseURL: resolvedURL,
    apiKey: resolvedKey,
    defaultModel: resolvedModel,
  });
}
