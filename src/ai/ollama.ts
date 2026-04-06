import type { AICompletionOptions, AIResponse } from '../types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('OllamaProvider');

const DEFAULT_MODEL = 'llama3.2';
const DEFAULT_BASE_URL = 'http://localhost:11434';

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl?: string, model?: string) {
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
    this.model = model ?? DEFAULT_MODEL;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(this.baseUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async complete(options: AICompletionOptions): Promise<AIResponse> {
    const model = options.model ?? this.model;
    const temperature = options.temperature ?? 0.7;

    // Build messages array
    const messages: OllamaChatMessage[] = [];

    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }

    for (const msg of options.messages) {
      if (msg.role === 'tool') continue; // Ollama doesn't support tool messages
      messages.push({ role: msg.role as 'system' | 'user' | 'assistant', content: msg.content ?? '' });
    }

    log.info({ model, messageCount: messages.length }, 'Sending completion request to Ollama');

    const start = performance.now();

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          temperature,
          ...(options.maxTokens ? { num_predict: options.maxTokens } : {}),
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    const duration = Math.round(performance.now() - start);

    const result: AIResponse = {
      content: data.message.content,
      provider: 'ollama',
      model: data.model,
      tokensUsed: {
        input: data.prompt_eval_count ?? 0,
        output: data.eval_count ?? 0,
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
      'Ollama completion finished',
    );

    return result;
  }
}
