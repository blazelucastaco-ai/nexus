// Tool manifests — declarative metadata for every built-in tool.
//
// Paired with the definitions in src/tools/definitions.ts (which describe
// the input schema for LLM function-calling). Manifests add the capability
// + risk model.
//
// Registered once at module load. Approval gate and audit read from the
// registry; legacy tools without manifests fall back to the old risk map.

import { toolManifests, type ToolManifest } from './contract.js';

const MANIFESTS: ToolManifest[] = [
  // ── Terminal / shell ────────────────────────────────────────────────────
  {
    name: 'run_terminal_command',
    description: 'Execute a shell command and return stdout+stderr.',
    effects: ['process.spawn', 'fs.read', 'fs.write', 'net.outbound'],
    risk: 'logged',
    category: 'terminal',
    keywords: ['shell', 'bash', 'zsh', 'command'],
  },
  {
    name: 'run_background_command',
    description: 'Start a long-running process in the background (dev server, watcher).',
    effects: ['process.detach'],
    risk: 'confirm',
    category: 'terminal',
    keywords: ['dev', 'watch', 'daemon'],
  },

  // ── Files ──────────────────────────────────────────────────────────────
  {
    name: 'read_file',
    description: 'Read a file from disk.',
    effects: ['fs.read'],
    risk: 'auto',
    idempotent: true,
    category: 'files',
  },
  {
    name: 'write_file',
    description: 'Write content to a file (atomic via tmp+rename).',
    effects: ['fs.write'],
    risk: 'logged',
    category: 'files',
  },
  {
    name: 'list_directory',
    description: 'List the contents of a directory.',
    effects: ['fs.read'],
    risk: 'auto',
    idempotent: true,
    category: 'files',
  },
  {
    name: 'search_files',
    description: 'Search files by name or content.',
    effects: ['fs.read'],
    risk: 'auto',
    idempotent: true,
    category: 'files',
  },

  // ── Memory ─────────────────────────────────────────────────────────────
  {
    name: 'recall',
    description: 'Semantic search over stored memories.',
    effects: ['mem.read'],
    risk: 'auto',
    idempotent: true,
    category: 'memory',
  },
  {
    name: 'remember',
    description: 'Store a fact or event in memory.',
    effects: ['mem.write'],
    risk: 'auto',
    noRetry: true, // never dedupe by retrying
    category: 'memory',
  },
  {
    name: 'introspect',
    description: 'Self-awareness snapshot (version, uptime, memory stats).',
    effects: ['mem.read'],
    risk: 'auto',
    idempotent: true,
    category: 'meta',
  },

  // ── System / macOS ─────────────────────────────────────────────────────
  {
    name: 'get_system_info',
    description: 'Query system state (CPU, memory, disk, etc).',
    effects: ['process.spawn'],
    risk: 'auto',
    idempotent: true,
    category: 'system',
  },
  {
    name: 'take_screenshot',
    description: 'Capture the screen as a PNG.',
    effects: ['os.screenshot'],
    risk: 'confirm',
    category: 'system',
  },

  // ── Web / research ─────────────────────────────────────────────────────
  {
    name: 'web_search',
    description: 'Open a web search in the default browser.',
    effects: ['net.outbound', 'process.spawn'],
    risk: 'auto',
    idempotent: true,
    category: 'web',
  },
  {
    name: 'web_fetch',
    description: 'Fetch and summarize a URL via HTTP.',
    effects: ['net.outbound'],
    risk: 'auto',
    idempotent: true,
    category: 'web',
  },
  {
    name: 'crawl_url',
    description: 'Recursively fetch linked pages from a URL.',
    effects: ['net.outbound'],
    risk: 'auto',
    idempotent: true,
    category: 'web',
  },

  // ── Browser (Chrome bridge) ────────────────────────────────────────────
  {
    name: 'browser_navigate',
    description: 'Navigate the active Chrome tab.',
    effects: ['browser.write'],
    risk: 'logged',
    category: 'browser',
  },
  {
    name: 'browser_click',
    description: 'Click an element by CSS selector.',
    effects: ['browser.write'],
    risk: 'logged',
    category: 'browser',
  },
  {
    name: 'browser_type',
    description: 'Type into a focused/selected input.',
    effects: ['browser.write'],
    risk: 'logged',
    category: 'browser',
  },
  {
    name: 'browser_extract',
    description: 'Extract DOM content from the active page.',
    effects: ['browser.read'],
    risk: 'auto',
    idempotent: true,
    category: 'browser',
  },
  {
    name: 'browser_screenshot',
    description: 'Capture the current browser viewport.',
    effects: ['browser.read', 'os.screenshot'],
    risk: 'auto',
    idempotent: true,
    category: 'browser',
  },

  // ── Media ──────────────────────────────────────────────────────────────
  {
    name: 'understand_image',
    description: 'Analyze an image using Claude vision.',
    effects: ['llm.call', 'fs.read'],
    risk: 'auto',
    idempotent: true,
    category: 'media',
  },
  {
    name: 'read_pdf',
    description: 'Extract text from a PDF file.',
    effects: ['fs.read'],
    risk: 'auto',
    idempotent: true,
    category: 'media',
  },
  {
    name: 'transcribe_audio',
    description: 'Transcribe an audio file to text.',
    effects: ['fs.read', 'net.outbound'],
    risk: 'auto',
    idempotent: true,
    category: 'media',
  },

  // ── Tasks / scheduling ─────────────────────────────────────────────────
  {
    name: 'schedule_task',
    description: 'Create a recurring scheduled task.',
    effects: ['mem.write'],
    risk: 'logged',
    category: 'tasks',
  },
  {
    name: 'list_tasks',
    description: 'List all scheduled tasks.',
    effects: ['mem.read'],
    risk: 'auto',
    idempotent: true,
    category: 'tasks',
  },
  {
    name: 'cancel_task',
    description: 'Disable a scheduled task.',
    effects: ['mem.write'],
    risk: 'logged',
    category: 'tasks',
  },

  // ── Meta ────────────────────────────────────────────────────────────────
  {
    name: 'check_command_risk',
    description: 'Classify a shell command by risk tier.',
    effects: [],
    risk: 'auto',
    idempotent: true,
    category: 'meta',
  },
];

/** Register every built-in manifest on module load. */
export function registerBuiltinManifests(): void {
  for (const m of MANIFESTS) toolManifests.register(m);
}

// Auto-register on import — callers just `import './manifests.js'` to ensure
// the registry is populated.
registerBuiltinManifests();
