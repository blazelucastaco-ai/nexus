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
  {
    name: 'web_fetch',
    description:
      'Fetch the text content of a URL. Strips HTML for readability. ' +
      'Use when you need to read the contents of a webpage, API endpoint, or document online. ' +
      'Do NOT use for searching — use web_search for that.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to fetch (https://...)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'crawl_url',
    description:
      'Deeply crawl a URL: fetch HTML, extract title, main body text, and links using a proper HTML parser. ' +
      'Better than web_fetch for reading articles, news pages, or content-heavy sites. ' +
      'Use when you need to extract structured content from a webpage (e.g. Hacker News, Wikipedia, blog posts).',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to crawl (https://...)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'schedule_task',
    description:
      'Schedule a recurring task using a cron expression. The task command runs on the defined schedule. ' +
      'Use when the user asks to schedule something recurring, like "every hour" or "every day at 9am". ' +
      'Cron format: "minute hour day-of-month month day-of-week" (e.g. "0 * * * *" = every hour). ' +
      'Common expressions: "0 * * * *"=hourly, "0 9 * * *"=daily at 9am, "0 9 * * 1"=weekly Monday 9am.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Unique name for the task (e.g. "daily-backup")',
        },
        cron: {
          type: 'string',
          description: 'Cron expression (5 fields: minute hour dom month dow)',
        },
        command: {
          type: 'string',
          description: 'Shell command to run (e.g. "echo hello world")',
        },
      },
      required: ['name', 'cron', 'command'],
    },
  },
  {
    name: 'list_tasks',
    description:
      'List all scheduled tasks, their cron expressions, commands, and last/next run times. ' +
      'Use when asked about scheduled jobs, cron tasks, or recurring automation.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'cancel_task',
    description:
      'Disable or cancel a scheduled task by name or ID. ' +
      'Use when the user wants to stop a recurring task from running.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Task name (from list_tasks)',
        },
        id: {
          type: 'string',
          description: 'Task ID (from list_tasks)',
        },
      },
      required: [],
    },
  },
  {
    name: 'generate_image',
    description:
      'Generate an image from a text description using DALL-E (if OpenAI key is configured). ' +
      'Saves the image to ~/nexus-workspace/. ' +
      'Use when the user asks you to create, draw, or generate an image.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'speak',
    description:
      'Convert text to speech using the macOS "say" command. ' +
      'Plays audio out loud or saves to ~/nexus-workspace/ as an .aiff file. ' +
      'Use when the user asks you to say something out loud, or to generate a voice message.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to speak',
        },
        voice: {
          type: 'string',
          description: 'macOS voice to use (default: Samantha)',
        },
        save: {
          type: 'string',
          description: 'Set to "true" to save as .aiff instead of playing',
          enum: ['true', 'false'],
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_sessions',
    description:
      'List all saved conversation sessions with sizes and last activity. ' +
      'Use when asked about session history or to see past conversations.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'cleanup_sessions',
    description:
      'Remove old conversation sessions to free up space. ' +
      'Deletes sessions older than the specified number of days (default: 7).',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Delete sessions older than this many days (default 7)',
        },
      },
      required: [],
    },
  },
  {
    name: 'export_session',
    description:
      'Export a conversation session as readable text. ' +
      'Use when the user wants to review or save a specific past conversation.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Session ID or filename (from list_sessions)',
        },
      },
      required: ['id'],
    },
  },

  // ── Media Understanding ───────────────────────────────────────────────────

  {
    name: 'understand_image',
    description:
      'Analyze an image using vision AI. Describe contents, extract text (OCR), or answer questions about the image. ' +
      'Accepts image URLs (https://...) or local file paths. ' +
      'Use when the user shares an image URL or asks about image content.',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Image URL (https://...) or local file path (~/...)',
        },
        question: {
          type: 'string',
          description: 'Optional specific question to answer about the image',
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'read_pdf',
    description:
      'Extract text content from a PDF file or PDF URL. Returns the full text with page count. ' +
      'Use when the user asks to read, summarize, or extract data from a PDF.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Local file path to the PDF (e.g. ~/Documents/report.pdf)',
        },
        url: {
          type: 'string',
          description: 'URL to a PDF file (https://...)',
        },
      },
      required: [],
    },
  },
  {
    name: 'transcribe_audio',
    description:
      'Transcribe an audio file to text using Whisper. ' +
      'Supports mp3, mp4, wav, m4a, ogg, flac formats. ' +
      'Use when the user wants to convert speech or audio to text.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Local file path to the audio file (e.g. ~/Downloads/recording.mp3)',
        },
      },
      required: ['path'],
    },
  },
  // ── Execution Approval ────────────────────────────────────────────────────

  {
    name: 'check_command_risk',
    description:
      'Check the risk tier of a shell command before running it. Returns SAFE / MODERATE / DANGEROUS / BLOCKED. ' +
      'Use this before running an unfamiliar or potentially risky command. ' +
      'Blocked commands will be refused outright. Dangerous commands need approval.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to classify',
        },
      },
      required: ['command'],
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
