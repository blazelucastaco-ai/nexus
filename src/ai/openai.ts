import OpenAI from 'openai';
import type { AICompletionOptions, AIResponse } from '../types.js';
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
    this.client = new OpenAI({ apiKey: this.apiKey });
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
      messages.push({ role: msg.role, content: msg.content });
    }

    log.info({ model, messageCount: messages.length }, 'Sending completion request to OpenAI');

    const start = performance.now();

    const response = await retry(
      async () => {
        return this.client.chat.completions.create({
          model,
          max_tokens: maxTokens,
          temperature,
          messages,
        });
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

    const content = response.choices[0]?.message?.content ?? '';

    const result: AIResponse = {
      content,
      provider: 'openai',
      model: response.model,
      tokensUsed: {
        input: response.usage?.prompt_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
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
      'OpenAI completion finished',
    );

    return result;
  }
}
