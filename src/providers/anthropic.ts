import Anthropic from "@anthropic-ai/sdk";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  tools?: any[];
}

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

export class AnthropicProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = "claude-sonnet-4-20250514") {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(
    systemPrompt: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<ChatResponse> {
    const { maxTokens = 4096, temperature = 0.7, tools } = options;

    const anthropicMessages: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const params: Anthropic.MessageCreateParams = {
      model: this.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: anthropicMessages,
      temperature,
    };

    if (tools && tools.length > 0) {
      params.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema ?? tool.parameters,
      }));
    }

    const response = await this.requestWithRetry(params);

    let content = "";
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  private async requestWithRetry(
    params: Anthropic.MessageCreateParams,
    attempt = 0,
  ): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.create(params) as Anthropic.Message;
    } catch (error: unknown) {
      if (
        attempt < MAX_RETRIES &&
        error instanceof Anthropic.APIError &&
        error.status === 429
      ) {
        const retryAfter = this.parseRetryAfter(error) ?? INITIAL_RETRY_DELAY_MS * 2 ** attempt;
        await this.sleep(retryAfter);
        return this.requestWithRetry(params, attempt + 1);
      }
      throw error;
    }
  }

  private parseRetryAfter(error: InstanceType<typeof Anthropic.APIError>): number | null {
    const header = (error.headers as Record<string, string> | undefined)?.["retry-after"];
    if (!header) return null;
    const seconds = Number.parseFloat(header);
    return Number.isNaN(seconds) ? null : seconds * 1000;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
