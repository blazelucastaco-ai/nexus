// Tool definitions for OpenAI-compatible function calling.
// Each tool maps to a concrete agent/subsystem action in executor.ts.

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'run_terminal_command',
    description:
      'Run a shell command on macOS via /bin/zsh and return stdout+stderr. ' +
      'Use for: checking versions, listing files, installing packages, running scripts, ' +
      'disk usage, process management, git, docker, etc. ' +
      'Always provide the EXACT shell command, not a description.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The exact shell command to execute (passed to /bin/zsh -c)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default 30000)',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command (optional)',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write content to a file on disk. Automatically creates parent directories. ' +
      'Use for: creating scripts, config files, HTML pages, code files, notes, etc. ' +
      'Always use absolute paths starting with ~ or /.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute file path (e.g. ~/nexus-workspace/project/index.html)',
        },
        content: {
          type: 'string',
          description: 'The full file content to write',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read the contents of a file from disk. Returns the file content as text.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute file path to read (e.g. ~/Documents/notes.txt)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description:
      'List files and directories at a given path. Returns names, sizes, and types.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list (e.g. ~/Desktop)',
        },
        showHidden: {
          type: 'string',
          description: 'Set to "true" to include hidden files (default false)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'take_screenshot',
    description:
      'Capture a screenshot of the entire screen. Returns the file path to the saved PNG image.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_system_info',
    description:
      'Get comprehensive macOS system information including CPU, memory, disk, ' +
      'battery, uptime, network interfaces, and installed apps.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Specific category to query',
          enum: ['overview', 'cpu', 'memory', 'disk', 'network', 'battery', 'processes', 'apps'],
        },
      },
      required: [],
    },
  },
  {
    name: 'remember',
    description:
      'Store an important fact or piece of information in long-term memory for future recall. ' +
      'Use when the user explicitly asks you to remember something, or when you discover a high-value fact.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The fact or information to remember',
        },
        importance: {
          type: 'number',
          description: 'How important this is (0.0 to 1.0, default 0.7)',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'recall',
    description:
      'Search long-term memory for information related to a query. ' +
      'Use when you need deeper context than what was already provided in the conversation.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for in memory',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_search',
    description:
      'Open a web search in the default browser for the given query. ' +
      'Use when the user asks to look something up online.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        engine: {
          type: 'string',
          description: 'Search engine to use',
          enum: ['google', 'duckduckgo', 'bing'],
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'check_injection',
    description:
      'Scan a piece of text for prompt injection attempts. Returns detection result, ' +
      'confidence score, and matched pattern names. Use when you receive suspicious ' +
      'text from external sources or when the user asks you to analyze text for manipulation.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to scan for prompt injection patterns',
        },
      },
      required: ['text'],
    },
  },
];

/**
 * Convert our tool definitions to the OpenAI SDK tools format.
 */
export function toOpenAITools(): Array<{
  type: 'function';
  function: ToolDefinition;
}> {
  return toolDefinitions.map((t) => ({ type: 'function' as const, function: t }));
}
