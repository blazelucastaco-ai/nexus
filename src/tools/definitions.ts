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
    name: 'run_background_command',
    description:
      'Start a long-running command in the background (e.g. dev servers, file watchers, builds). ' +
      'Returns immediately with the PID and initial output. The process keeps running after this call returns. ' +
      'Use for: npm run dev, python -m http.server, vite dev, next dev, cargo watch, etc. ' +
      'Do NOT use for short commands that should finish — use run_terminal_command instead.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to run in the background',
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
      'Do NOT use for running commands (use run_terminal_command) or reading files (use read_file). ' +
      'For HTML/CSS files: ALWAYS use modern styling (Tailwind CSS via CDN, or Bootstrap 5). ' +
      'Never write plain unstyled HTML — include responsive design, proper typography, color palette, ' +
      'spacing, hover states, and visual hierarchy. Every website must look professional and polished.',
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
      'Get your own system status: version, git commit, branch, PID, uptime, heap usage, memory DB size, ' +
      'total memories stored, current emotional state, workspace contents, and host machine info. ' +
      'Use when asked about yourself, your state, your PID, your uptime, your version, or how you are doing. ' +
      'Do NOT make up numbers — always call this tool when asked about your runtime status. ' +
      'For update checks, use check_updates instead (it fetches from the remote).',
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
    name: 'check_updates',
    description:
      'Check if NEXUS has updates available by comparing local git state to the remote. ' +
      'Returns current version, commit hash, branch, how many commits behind/ahead, ' +
      'and whether an update is available. ' +
      'Use when the user asks: "are you up to date?", "what version are you?", ' +
      '"any updates?", "can you update yourself?", "what was your last update?", ' +
      'or anything about your version or update status.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
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

  // ── Chrome Browser Control (requires NEXUS Bridge extension) ─────────────

  {
    name: 'browser_navigate',
    description:
      'Navigate the active Chrome tab to a URL and wait for it to load. ' +
      'Waits an extra 800ms after load for SPA frameworks to render. ' +
      'Returns the final URL and page title. ' +
      'Use when asked to visit a website, open a URL, or go to a page. ' +
      'Requires the NEXUS Bridge Chrome extension to be connected.',
    parameters: {
      type: 'object',
      properties: {
        url:             { type: 'string', description: 'The full URL to navigate to (https://...)' },
        waitForSelector: { type: 'string', description: 'Optional CSS selector to wait for after page loads (useful for SPAs that render content asynchronously)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_extract',
    description:
      'Extract content from the current Chrome tab. Without a selector, returns full page text, title, URL, links, and headings. ' +
      'With a CSS selector, returns the text of the matched element. ' +
      'With attribute param, returns the attribute value. ' +
      'With mode="form", discovers all fillable form fields and returns their selectors, labels, and current values. ' +
      'Use when you need to read or scrape content from an open browser page.',
    parameters: {
      type: 'object',
      properties: {
        selector:  { type: 'string', description: 'CSS selector to target a specific element (optional — omit for full page)' },
        attribute: { type: 'string', description: 'HTML attribute to read (e.g. "href", "value", "src") — optional' },
        all:       { type: 'string', description: 'Set to "true" to return all matches, not just the first', enum: ['true', 'false'] },
        mode:      { type: 'string', description: 'Set to "form" to discover all form fields with their selectors and labels', enum: ['form'] },
      },
      required: [],
    },
  },
  {
    name: 'browser_click',
    description:
      'Click an element in the current Chrome tab by CSS selector or visible text. ' +
      'Use for clicking buttons, links, checkboxes, menu items, etc.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click' },
        text:     { type: 'string', description: 'Visible text of the element to click (alternative to selector)' },
        index:    { type: 'number', description: 'Index (0-based) if multiple elements match the selector' },
      },
      required: [],
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into a specific input field in the current Chrome tab. ' +
      'ALWAYS provide a selector — never call this without one. ' +
      'Without a selector it types into whatever element happens to be focused, which is almost always wrong. ' +
      'For multi-field forms (To/Subject/Body, login forms, etc.) use browser_fill_form instead.',
    parameters: {
      type: 'object',
      properties: {
        text:     { type: 'string', description: 'Text to type into the element' },
        selector: { type: 'string', description: 'CSS selector of the input to type into — REQUIRED. Extract the page first to find the correct selector.' },
        clear:    { type: 'string', description: 'Set to "true" to clear the field before typing', enum: ['true', 'false'] },
      },
      required: ['text', 'selector'],
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture a screenshot of the current Chrome tab as a PNG image. ' +
      'Returns a base64-encoded image. ' +
      'Use when you need to see what\'s on screen, verify results, or share the current browser state.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the current Chrome tab. Use to reveal more content or navigate long pages.',
    parameters: {
      type: 'object',
      properties: {
        y:        { type: 'number', description: 'Pixels to scroll vertically (positive = down, negative = up). Default 500.' },
        x:        { type: 'number', description: 'Pixels to scroll horizontally (optional)' },
        selector: { type: 'string', description: 'Scroll a specific element instead of the window (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'browser_evaluate',
    description:
      'Execute arbitrary JavaScript in the current Chrome tab and return the result. ' +
      'The code runs in the page\'s main context. ' +
      'Use for reading page state, triggering actions, or extracting dynamic data.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute. Can use return statements.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'browser_hover',
    description:
      'Hover over an element in the current Chrome tab. ' +
      'Fires mouseenter/mouseover/mousemove events — essential for dropdown menus and tooltips. ' +
      'Use before clicking items that only appear after hovering.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to hover over' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_press_key',
    description:
      'Press a keyboard key on the focused element or a specific element. ' +
      'Use for: Enter (submit forms), Tab (move focus), Escape (close modals/dropdowns), Arrow keys (navigate lists), etc. ' +
      'Call after browser_type to submit a form, or to navigate autocomplete dropdowns.',
    parameters: {
      type: 'object',
      properties: {
        key:      { type: 'string', description: 'Key to press: Enter, Tab, Escape, Space, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, F5, or any single character' },
        selector: { type: 'string', description: 'CSS selector of element to press key on (optional — defaults to focused element)' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_wait_for',
    description:
      'Wait for a condition on a CSS selector in the current Chrome tab. ' +
      'Use before interacting with elements that load asynchronously or animate in.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        timeout:  { type: 'number', description: 'Max milliseconds to wait (default 10000)' },
        mode:     { type: 'string', description: 'Condition to wait for: "present" (default, in DOM), "visible" (visible + sized), "text" (contains expected text), "gone" (removed from DOM)', enum: ['present', 'visible', 'text', 'gone'] },
        text:     { type: 'string', description: 'Expected text content (only used when mode is "text")' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_wait_for_url',
    description:
      'Wait for the active tab URL to contain a specific string. ' +
      'Use after clicking links or buttons that trigger navigation or SPA route changes. ' +
      'More reliable than browser_wait_for for detecting page transitions.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'String that must appear somewhere in the new URL' },
        timeout: { type: 'number', description: 'Max milliseconds to wait (default 10000)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'browser_suppress_dialogs',
    description:
      'Suppress native browser dialogs (alert, confirm, prompt) that would block automation. ' +
      'Call this BEFORE clicking buttons that trigger JavaScript alerts or confirmation dialogs. ' +
      'confirm() is replaced with true (accepted), prompt() returns empty string, alert() is silenced. ' +
      'Use on pages with "Click for JS Alert", "Delete" confirmations, "Are you sure?" popups, etc.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_dismiss_cookies',
    description:
      'Dismiss cookie consent banners on the current page. ' +
      'Tries common selectors (#onetrust, CookieBot, cc-banner, etc.) then falls back to button text matching. ' +
      'Call this after navigating to a site that shows a cookie banner before you can interact with the page. ' +
      'Returns dismissed: true if a banner was found and clicked, dismissed: false if none found.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_get_info',
    description: 'Get the URL, title, and tab ID of the currently active Chrome tab.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_get_tabs',
    description: 'List all open Chrome tabs with their IDs, URLs, and titles.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_new_tab',
    description: 'Open a new Chrome tab, optionally navigating to a URL.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open in the new tab (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'browser_close_tab',
    description: 'Close a Chrome tab. Closes the active tab if no tabId is given.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID to close (optional — defaults to active tab)' },
      },
      required: [],
    },
  },
  {
    name: 'browser_fill_form',
    description:
      'Fill multiple form fields in the current Chrome tab at once. ' +
      'More efficient than multiple browser_type calls for forms with many fields.',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'string',
          description: 'JSON array of {selector, value} pairs, e.g. [{"selector":"#email","value":"user@example.com"}]',
        },
      },
      required: ['fields'],
    },
  },
  {
    name: 'browser_back',
    description: 'Navigate the active Chrome tab back in history.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_forward',
    description: 'Navigate the active Chrome tab forward in history.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_reload',
    description: 'Reload the current Chrome tab and wait for it to finish loading.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

/**
 * Convert our tool definitions to the OpenAI SDK tools format.
 * Cached at module load — toolDefinitions is immutable, so the result
 * never needs recomputation. Called on every tool-loop iteration, so
 * caching avoids ~180KB JSON rebuild per iteration.
 */
const OPENAI_TOOLS_CACHE: ReadonlyArray<{
  type: 'function';
  function: ToolDefinition;
}> = Object.freeze(toolDefinitions.map((t) => ({ type: 'function' as const, function: t })));

export function toOpenAITools(): Array<{
  type: 'function';
  function: ToolDefinition;
}> {
  // Return a shallow copy so callers can't mutate the cached array.
  return OPENAI_TOOLS_CACHE.slice();
}
