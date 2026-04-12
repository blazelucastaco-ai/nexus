import Anthropic from '@anthropic-ai/sdk';
import type { AICompletionOptions, AIMessage, AIResponse, AIToolCall } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { retry } from '../utils/retry.js';

const log = createLogger('ClaudeProvider');

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_RETRIES = 2;

// ─── Format Converters ────────────────────────────────────────────────────────

/**
 * Convert OpenAI-style tool definitions to Anthropic format.
 * OpenAI:   { type: 'function', function: { name, description, parameters } }
 * Anthropic: { name, description, input_schema }
 */
function toAnthropicTools(tools: AICompletionOptions['tools']): Anthropic.Tool[] {
  if (!tools?.length) return [];
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Anthropic.Tool['input_schema'],
  }));
}

/**
 * Convert our internal message history to Anthropic format.
 *
 * Key differences from OpenAI format:
 * - Anthropic uses top-level `system` param, not system messages in the array
 * - Tool calls in assistant messages use `tool_use` content blocks (not `tool_calls`)
 * - Tool results go as `user` role with `tool_result` content blocks (not `tool` role)
 * - Messages must strictly alternate user/assistant
 */
function toAnthropicMessages(
  messages: AIMessage[],
): Array<Anthropic.MessageParam> {
  const result: Anthropic.MessageParam[] = [];

  // Group tool results so they can be batched into a single user message
  // alongside their preceding assistant message.
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;

    // Skip system messages (handled separately as system prompt)
    if (msg.role === 'system') {
      i++;
      continue;
    }

    if (msg.role === 'user') {
      result.push({ role: 'user', content: String(msg.content ?? '') });
      i++;
      continue;
    }

    if (msg.role === 'tool') {
      // Tool results must be batched into a user message with tool_result blocks.
      // Collect all consecutive tool messages.
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      while (i < messages.length && messages[i]!.role === 'tool') {
        const tm = messages[i]!;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tm.tool_call_id ?? '',
          content: String(tm.content ?? ''),
        });
        i++;
      }
      result.push({ role: 'user', content: toolResults });
      continue;
    }

    if (msg.role === 'assistant') {
      // Build content blocks — text + tool_use blocks
      const contentBlocks: Anthropic.ContentBlock[] = [];

      if (msg.content) {
        contentBlocks.push({ type: 'text', text: String(msg.content) });
      }

      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments);
          } catch { /* ignore parse errors */ }

          contentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }

      if (contentBlocks.length === 0) {
        contentBlocks.push({ type: 'text', text: '' });
      }

      result.push({ role: 'assistant', content: contentBlocks });
      i++;
      continue;
    }

    i++;
  }

  // Anthropic requires messages to start with a user message.
  // If the first message is assistant, prepend a stub user message.
  if (result.length > 0 && result[0]!.role !== 'user') {
    result.unshift({ role: 'user', content: '[context]' });
  }

  // Merge consecutive same-role messages (Anthropic rejects them).
  const merged: Anthropic.MessageParam[] = [];
  for (const m of result) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      // Merge content
      const prevContent = Array.isArray(prev.content)
        ? prev.content
        : [{ type: 'text' as const, text: String(prev.content) }];
      const newContent = Array.isArray(m.content)
        ? m.content
        : [{ type: 'text' as const, text: String(m.content) }];
      prev.content = [...prevContent, ...newContent] as typeof prev.content;
    } else {
      merged.push(m);
    }
  }

  return merged;
}

/**
 * Convert Anthropic response content blocks into our internal AIToolCall format.
 */
function extractToolCalls(content: Anthropic.ContentBlock[]): AIToolCall[] {
  return content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    .map((b) => ({
      id: b.id,
      type: 'function' as const,
      function: {
        name: b.name,
        arguments: JSON.stringify(b.input),
      },
    }));
}

// ─── ClaudeProvider ───────────────────────────────────────────────────────────

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
    const maxTokens = options.maxTokens ?? 16384;
    const temperature = options.temperature ?? 0.7;

    // Build system prompt (top-level Anthropic param)
    const inlineSystem = options.messages
      .filter((m) => m.role === 'system')
      .map((m) => String(m.content ?? ''))
      .filter(Boolean);

    const fullSystem = [
      ...(options.systemPrompt ? [options.systemPrompt] : []),
      ...inlineSystem,
    ].join('\n\n') || undefined;

    // Convert messages and tools
    const anthropicMessages = toAnthropicMessages(options.messages);
    const anthropicTools = toAnthropicTools(options.tools);

    // tool_choice: Anthropic uses { type: 'auto' | 'any' | 'none' }
    // We map 'auto' → { type: 'auto' } and pass 'any' when we want to force tool use
    let toolChoice: Anthropic.ToolChoiceAuto | Anthropic.ToolChoiceAny | undefined;
    if (anthropicTools.length > 0) {
      if (options.tool_choice === 'none') {
        toolChoice = undefined; // Just don't pass tool_choice to prevent tool use
      } else {
        // Default to 'auto'; internally we pass 'any' when step runner forces tool use
        toolChoice = { type: (options.tool_choice as 'any') === 'any' ? 'any' : 'auto' };
      }
    }

    log.info(
      { model, messageCount: anthropicMessages.length, hasTools: anthropicTools.length > 0, toolChoice: toolChoice?.type },
      'Sending completion request to Anthropic',
    );

    const start = performance.now();

    // Use streaming API to avoid the non-streaming 10-minute timeout imposed by Anthropic
    // when max_tokens is high. stream().finalMessage() gives us the same result as
    // messages.create() but keeps the HTTP connection alive for the full duration.
    const response = await retry(
      async () => {
        const params: Anthropic.MessageStreamParams = {
          model,
          max_tokens: maxTokens,
          temperature,
          messages: anthropicMessages,
          ...(fullSystem ? { system: fullSystem } : {}),
          ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
          ...(toolChoice ? { tool_choice: toolChoice } : {}),
        };
        const stream = this.client.messages.stream(params);
        return stream.finalMessage();
      },
      {
        maxRetries: MAX_RETRIES,
        baseDelay: 1000,
        onRetry: (error, attempt) => {
          log.warn({ error: error instanceof Error ? error.message : String(error), attempt }, 'Retrying Anthropic request');
        },
      },
    );

    const duration = Math.round(performance.now() - start);

    // Extract text content
    const content = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    // Extract tool calls
    const toolCalls = extractToolCalls(response.content);

    const result: AIResponse = {
      content,
      provider: 'anthropic',
      model: response.model,
      tokensUsed: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
      duration,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      stopReason: response.stop_reason ?? undefined,
    };

    log.info(
      {
        model: result.model,
        inputTokens: result.tokensUsed?.input,
        outputTokens: result.tokensUsed?.output,
        toolCalls: toolCalls.length,
        stopReason: result.stopReason,
        duration,
      },
      'Anthropic completion finished',
    );

    return result;
  }
}
