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
      'Execute a shell command on macOS via /bin/zsh and return stdout+stderr. ' +
      'Use for: checking versions, running scripts, system queries, git commands, ' +
      'package installs, process management, disk usage, docker. ' +
      'Do NOT use for: file creation (use write_file), reading files (use read_file), ' +
      'or listing directories (use list_directory). ' +
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
      'Write content to a file on disk. Creates parent directories automatically. ' +
      'Use for: saving code, scripts, configs, reports, notes, any file output. ' +
      'Always include the COMPLETE file content — never write partial files or placeholders. ' +
      'Always use absolute paths starting with ~ or /. ' +
      'Do NOT use for running commands (use run_terminal_command) or reading files (use read_file).',
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
      'Read the full contents of a file from disk. Returns the file content as text. ' +
      'Use when you need to see what is in a file before modifying it or answering questions about it. ' +
      'Do NOT use for directory listing (use list_directory) or running commands (use run_terminal_command).',
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
      'List files and folders in a directory. Returns file names, sizes, and types. ' +
      'Use to see what exists before creating or reading files. ' +
      'Do NOT use for reading file contents (use read_file) or running shell commands (use run_terminal_command).',
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
      'Capture a screenshot of the Mac screen and save it as a PNG. ' +
      'Only use when explicitly asked for a screenshot — do NOT use speculatively. ' +
      'Requires Screen Recording permission. Returns the path to the saved image.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_system_info',
    description:
      'Get macOS system information including CPU, memory, disk, battery, uptime, network, and installed apps. ' +
      'Use when asked about CPU usage, RAM, disk space, running processes, or battery. ' +
      'Specify category: "overview" for a complete snapshot, or a specific category for targeted data. ' +
      'Do NOT use for running arbitrary commands (use run_terminal_command).',
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
      'Store important information in long-term memory for future recall. ' +
      'Use when the user explicitly asks you to remember something, or when you learn a key fact ' +
      'about the user (name, preferences, ongoing projects). ' +
      'Do NOT store transient conversation details, temporary results, or things already in the current context.',
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
      'Search long-term memory for previously stored facts. ' +
      'Use before answering questions about the user\'s preferences, past projects, or anything they asked you to remember. ' +
      'Use when you need deeper context than what is visible in the current conversation. ' +
      'Do NOT use if the answer is already present in the conversation history.',
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
      'Search the web for current information by opening the default browser. ' +
      'Use when asked about recent events, current prices, latest versions, or anything ' +
      'you are not confident about from training data. ' +
      'Do NOT use for things you already know confidently, or for reading local files.',
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
  {
    name: 'introspect',
    description:
      'Get your own system status: PID, uptime, heap usage, memory DB size, total memories stored, ' +
      'current emotional state, workspace contents, and host machine info. ' +
      'Use when asked about yourself, your state, your PID, your uptime, or how you are doing. ' +
      'Do NOT make up numbers — always call this tool when asked about your runtime status.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'toggle_think_mode',
    description:
      'Enable or disable inner monologue (think mode). When enabled, NEXUS prefixes each response ' +
      'with a 💭 thought bubble showing its reasoning process before answering. ' +
      'Use when the user asks to see your thinking, or wants to turn think mode on/off.',
    parameters: {
      type: 'object',
      properties: {
        enabled: {
          type: 'string',
          description: 'Set to "true" to enable, "false" to disable, or omit to toggle the current state.',
          enum: ['true', 'false'],
        },
      },
      required: [],
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
