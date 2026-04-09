// Recommended Approval Areas — curated sets of commonly-needed DANGEROUS commands
// grouped by use case. Users can opt into entire areas instead of allowlisting
// individual commands one at a time.

export interface RecommendedArea {
  id: string;
  name: string;
  description: string;
  commands: string[];   // Exact commands or prefix wildcards (ending in *)
  patterns: string[];   // Regex patterns
}

/**
 * Curated recommended areas that cover common developer workflows.
 * Each area groups related DANGEROUS-tier commands that are generally
 * safe in a development context.
 */
export const RECOMMENDED_AREAS: RecommendedArea[] = [
  {
    id: 'dev-cleanup',
    name: 'Development Cleanup',
    description: 'Remove common build artifacts and dependency directories (node_modules, dist, build, caches)',
    commands: [
      'rm -rf node_modules',
      'rm -rf dist',
      'rm -rf build',
      'rm -rf .cache',
      'rm -rf coverage',
      'rm -rf .next',
      'rm -rf .nuxt',
      'rm -rf .turbo',
      'rm -rf __pycache__',
      'rm -rf .pytest_cache',
      'rm -rf .parcel-cache',
      'rm -rf .vite',
      'rm -rf target',
    ],
    patterns: [
      '^rm -rf (node_modules|dist|build|\\.cache|coverage|\\.next|\\.nuxt|\\.turbo|__pycache__|\\.pytest_cache|\\.parcel-cache|\\.vite|target)(/.*)?$',
    ],
  },
  {
    id: 'package-management',
    name: 'Package Management',
    description: 'Install and remove packages via Homebrew, npm, and pip',
    commands: [
      'brew install *',
      'brew uninstall *',
      'brew reinstall *',
      'npm uninstall -g *',
      'pip uninstall *',
    ],
    patterns: [
      '^brew (install|uninstall|reinstall)\\b',
      '^npm uninstall (-g\\s+)?\\S',
      '^pip uninstall\\b',
    ],
  },
  {
    id: 'process-management',
    name: 'Process Management',
    description: 'Kill or signal running processes by PID or name',
    commands: [],
    patterns: [
      '^kill\\s+(-\\d+\\s+)?\\d+',
      '^killall\\s+\\S+$',
      '^pkill\\s+(-\\w+\\s+)?\\S+$',
    ],
  },
  {
    id: 'file-permissions',
    name: 'File Permissions',
    description: 'Recursively change permissions or ownership within project directories',
    commands: [],
    patterns: [
      '^chmod -R \\d{3,4} \\.',
      '^chown -R \\w+[:]\\w* \\.',
    ],
  },
  {
    id: 'service-management',
    name: 'Service Management',
    description: 'Load, unload, start, and stop launchctl services',
    commands: [],
    patterns: [
      '^launchctl (load|unload|start|stop|list|bootstrap|bootout)\\b',
    ],
  },
];

/**
 * Look up a recommended area by its ID.
 */
export function getArea(id: string): RecommendedArea | undefined {
  return RECOMMENDED_AREAS.find((a) => a.id === id);
}

/**
 * Find which recommended areas would cover a given command.
 * Returns matching area IDs.
 */
export function findMatchingAreas(command: string): RecommendedArea[] {
  const cmd = command.trim();
  const matches: RecommendedArea[] = [];

  for (const area of RECOMMENDED_AREAS) {
    // Check exact commands and prefix wildcards
    for (const allowed of area.commands) {
      if (allowed.endsWith('*')) {
        if (cmd.startsWith(allowed.slice(0, -1))) {
          matches.push(area);
          break;
        }
      } else if (cmd === allowed) {
        matches.push(area);
        break;
      }
    }

    // Check regex patterns (skip if area already matched)
    if (!matches.includes(area)) {
      for (const pattern of area.patterns) {
        try {
          if (new RegExp(pattern).test(cmd)) {
            matches.push(area);
            break;
          }
        } catch {
          // Invalid regex — skip
        }
      }
    }
  }

  return matches;
}

/**
 * Get a human-readable summary of all recommended areas.
 */
export function listAreas(): string {
  return RECOMMENDED_AREAS.map(
    (a) => `  ${a.id} — ${a.name}: ${a.description}`,
  ).join('\n');
}
