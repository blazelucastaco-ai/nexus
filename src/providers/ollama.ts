import type { ChatMessage, ChatOptions, ChatResponse, ToolCall } from "./anthropic.js";

export type { ChatMessage, ChatOptions, ChatResponse, ToolCall };

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: Record<string, unknown>;
      };
    }>;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagsResponse {
  models: Array<{
    name: string;
    modified_at: string;
    size: number;
  }>;
}

export class OllamaProvider {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl = "http://localhost:11434", model = "llama3.2") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
  }

  async chat(
    systemPrompt: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<ChatResponse> {
    const { temperature = 0.7, tools } = options;

    const ollamaMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const body: Record<string, unknown> = {
      model: this.model,
      messages: ollamaMessages,
      stream: false,
      options: {
        temperature,
      },
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? tool.input_schema,
        },
      }));
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`Ollama API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    const content = data.message.content ?? "";
    const toolCalls: ToolCall[] = [];

    if (data.message.tool_calls) {
      for (let i = 0; i < data.message.tool_calls.length; i++) {
        const tc = data.message.tool_calls[i];
        toolCalls.push({
          id: `ollama-tc-${Date.now()}-${i}`,
          name: tc.function.name,
          input: tc.function.arguments,
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`, {
      method: "GET",
    });

    if (!response.ok) {
      throw new Error(`Ollama API error (${response.status}): failed to list models`);
    }

    const data = (await response.json()) as OllamaTagsResponse;
    return data.models.map((m) => m.name);
  }
}
