import OpenAI from 'openai';
import type { AICompletionOptions, AIResponse, AIToolCall } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { retry } from '../utils/retry.js';

const log = createLogger('OpenAIProvider');

const DEFAULT_MODEL = 'gpt-4o';
const MAX_RETRIES = 2;

export class OpenAIProvider {
  private client: OpenAI;
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.OPENAI_API_KEY ?? '';
    const baseURL = process.env.OPENAI_BASE_URL;
    this.client = new OpenAI({ apiKey: this.apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async complete(options: AICompletionOptions): Promise<AIResponse> {
    const model = options.model ?? DEFAULT_MODEL;
    const maxTokens = options.maxTokens ?? 8192;
    const temperature = options.temperature ?? 0.7;

    // Build messages array — system prompt goes as the first system message
    const messages: Array<OpenAI.Chat.ChatCompletionMessageParam> = [];

    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }

    for (const msg of options.messages) {
      if (msg.role === 'tool') {
        // Tool result message
        messages.push({
          role: 'tool',
          content: msg.content ?? '',
          tool_call_id: msg.tool_call_id ?? '',
        });
      } else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant message with tool calls
        messages.push({
          role: 'assistant',
          content: msg.content ?? null,
          tool_calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        });
      } else {
        messages.push({
          role: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content ?? '',
        });
      }
    }

    // Build request params
    const requestParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages,
    };

    // Add tools if provided
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

    log.info({ model, messageCount: messages.length, hasTools: !!options.tools }, 'Sending completion request to OpenAI');

    const start = performance.now();

    const response = await retry(
      async () => {
        return this.client.chat.completions.create(requestParams);
      },
      {
        maxRetries: MAX_RETRIES,
        baseDelay: 1000,
        onRetry: (error, attempt) => {
          log.warn({ error: error.message, attempt }, 'Retrying OpenAI request');
        },
      },
    );

    const duration = Math.round(performance.now() - start);

    const message = response.choices[0]?.message;
    const content = message?.content ?? '';

    // Extract tool calls if present
    let toolCalls: AIToolCall[] | undefined;
    if (message?.tool_calls && message.tool_calls.length > 0) {
      toolCalls = message.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }

    const result: AIResponse = {
      content,
      provider: 'openai',
      model: response.model,
      tokensUsed: {
        input: response.usage?.prompt_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
      },
      duration,
      toolCalls,
    };

    log.info(
      {
        model: result.model,
        inputTokens: result.tokensUsed.input,
        outputTokens: result.tokensUsed.output,
        toolCalls: toolCalls?.length ?? 0,
        duration,
      },
      'OpenAI completion finished',
    );

    return result;
  }
}
