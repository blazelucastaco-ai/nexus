import Anthropic from '@anthropic-ai/sdk';
import type { AICompletionOptions, AIResponse } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { retry } from '../utils/retry.js';

const log = createLogger('ClaudeProvider');

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const MAX_RETRIES = 2;

export class ClaudeProvider {
  private client: Anthropic;
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.client = new Anthropic({ apiKey: this.apiKey });
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async complete(options: AICompletionOptions): Promise<AIResponse> {
    const model = options.model ?? DEFAULT_MODEL;
    const maxTokens = options.maxTokens ?? 8192;
    const temperature = options.temperature ?? 0.7;

    // Separate system prompt from messages — Anthropic API uses a top-level `system` param
    const systemPrompt = options.systemPrompt;

    // Filter out system messages; Anthropic expects only user/assistant in the messages array
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> =
      options.messages
        .filter((m) => m.role !== 'system' && m.role !== 'tool')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content ?? '',
        }));

    // If there were inline system messages, prepend their content to the system prompt
    const inlineSystemMessages = options.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content ?? '');

    const fullSystemPrompt = [
      ...(systemPrompt ? [systemPrompt] : []),
      ...inlineSystemMessages.filter(Boolean),
    ].join('\n\n') || undefined;

    log.info({ model, messageCount: messages.length }, 'Sending completion request to Anthropic');

    const start = performance.now();

    const response = await retry(
      async () => {
        return this.client.messages.create({
          model,
          max_tokens: maxTokens,
          temperature,
          ...(fullSystemPrompt ? { system: fullSystemPrompt } : {}),
          messages,
        });
      },
      {
        maxRetries: MAX_RETRIES,
        baseDelay: 1000,
        onRetry: (error, attempt) => {
          log.warn({ error: error.message, attempt }, 'Retrying Anthropic request');
        },
      },
    );

    const duration = Math.round(performance.now() - start);

    // Extract text content from the response
    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const result: AIResponse = {
      content,
      provider: 'anthropic',
      model: response.model,
      tokensUsed: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
      duration,
    };

    log.info(
      {
        model: result.model,
        inputTokens: result.tokensUsed.input,
        outputTokens: result.tokensUsed.output,
        duration,
      },
      'Anthropic completion finished',
    );

    return result;
  }
}
