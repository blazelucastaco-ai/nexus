import OpenAI from "openai";
import type { ChatMessage, ChatOptions, ChatResponse, ToolCall } from "./anthropic.js";

export type { ChatMessage, ChatOptions, ChatResponse, ToolCall };

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

export class OpenAIProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model = "gpt-4o") {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async chat(
    systemPrompt: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<ChatResponse> {
    const { maxTokens = 4096, temperature = 0.7, tools } = options;

    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...messages.map(
        (m) =>
          ({
            role: m.role,
            content: m.content,
          }) as OpenAI.ChatCompletionMessageParam,
      ),
    ];

    const params: OpenAI.ChatCompletionCreateParams = {
      model: this.model,
      messages: openaiMessages,
      max_tokens: maxTokens,
      temperature,
    };

    if (tools && tools.length > 0) {
      params.tools = tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? tool.input_schema,
        },
      }));
    }

    const response = await this.requestWithRetry(params);
    const choice = response.choices[0];

    if (!choice) {
      throw new Error("OpenAI returned no choices");
    }

    const content = choice.message.content ?? "";
    const toolCalls: ToolCall[] = [];

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        if (tc.type === "function") {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = { _raw: tc.function.arguments };
          }
          toolCalls.push({
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  private async requestWithRetry(
    params: OpenAI.ChatCompletionCreateParams,
    attempt = 0,
  ): Promise<OpenAI.ChatCompletion> {
    try {
      return await this.client.chat.completions.create(params) as OpenAI.ChatCompletion;
    } catch (error: unknown) {
      const retryableStatus = new Set([429, 500, 502, 503, 529]);
      if (
        attempt < MAX_RETRIES &&
        error instanceof OpenAI.APIError &&
        retryableStatus.has(error.status ?? 0)
      ) {
        const retryAfter = this.parseRetryAfter(error) ?? INITIAL_RETRY_DELAY_MS * 2 ** attempt;
        await this.sleep(retryAfter);
        return this.requestWithRetry(params, attempt + 1);
      }
      throw error;
    }
  }

  private parseRetryAfter(error: InstanceType<typeof OpenAI.APIError>): number | null {
    const header = (error.headers as Record<string, string> | undefined)?.["retry-after"];
    if (!header) return null;
    const seconds = Number.parseFloat(header);
    return Number.isNaN(seconds) ? null : seconds * 1000;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
