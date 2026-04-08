// Execution Approval Framework — risk tiering for terminal commands
// Defines SAFE / MODERATE / DANGEROUS / BLOCKED tiers.

export type RiskTier = 'SAFE' | 'MODERATE' | 'DANGEROUS' | 'BLOCKED';

export interface TierResult {
  tier: RiskTier;
  reason: string;
  matchedPattern?: string;
}

// ── BLOCKED — refuse outright, no exceptions ───────────────────────────────
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/, reason: 'rm -rf / (filesystem wipe)' },
  { pattern: /rm\s+-rf\s+~\s*$/, reason: 'rm -rf ~ (home dir wipe)' },
  { pattern: /mkfs\b/, reason: 'filesystem format' },
  { pattern: /dd\s+if=.*of=\/dev\//, reason: 'raw disk write' },
  { pattern: /:\(\)\{.*\|.*&\s*\};\s*:/, reason: 'fork bomb' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'direct disk overwrite' },
  { pattern: /curl.*\|\s*(sudo\s+)?bash/, reason: 'remote code pipe execution' },
  { pattern: /wget.*\|\s*(sudo\s+)?bash/, reason: 'remote code pipe execution' },
  { pattern: /sudo\s+rm\s+-rf\s+\//, reason: 'sudo filesystem wipe' },
  { pattern: /diskutil\s+(eraseDisk|eraseVolume)/, reason: 'disk erase' },
];

// ── DANGEROUS — log and require approval flag ──────────────────────────────
const DANGEROUS_PREFIXES: string[] = [
  'sudo ', 'rm -r', 'rm -f', 'chmod -R', 'chown -R',
  'kill -9', 'killall', 'pkill', 'launchctl',
  'brew uninstall', 'npm uninstall -g', 'pip uninstall',
  'apt remove', 'apt purge', 'yum remove',
];

const DANGEROUS_KEYWORDS: string[] = [
  'shutdown', 'reboot', 'halt', 'poweroff', 'init 0', 'init 6',
];

// ── MODERATE — write/create operations ────────────────────────────────────
const MODERATE_PATTERNS: string[] = [
  'cp ', 'mv ', 'mkdir ', 'touch ', 'ln ',
  'npm install', 'pip install', 'brew install',
  'git push', 'git reset', 'git clean',
];

// ── SAFE — read-only by convention ────────────────────────────────────────
const SAFE_PREFIXES: string[] = [
  'ls', 'cat ', 'echo ', 'pwd', 'date', 'which ', 'whoami', 'uname',
  'grep ', 'find ', 'head ', 'tail ', 'wc ', 'sort ', 'uniq ',
  'curl -s', 'wget -q', 'ping ', 'nslookup', 'dig ',
  'ps ', 'top -', 'df ', 'du ', 'uptime',
  'git log', 'git status', 'git diff', 'git show',
  'node --version', 'npm --version', 'python3 --version',
];

export function classifyCommand(command: string): TierResult {
  const cmd = command.trim();
  const lower = cmd.toLowerCase();

  // Check BLOCKED first
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return { tier: 'BLOCKED', reason, matchedPattern: pattern.source };
    }
  }

  // Check DANGEROUS keywords
  for (const kw of DANGEROUS_KEYWORDS) {
    if (lower.startsWith(kw) || lower.includes(' ' + kw + ' ') || lower.endsWith(kw)) {
      return { tier: 'DANGEROUS', reason: `Dangerous keyword: "${kw}"`, matchedPattern: kw };
    }
  }

  // Check DANGEROUS prefixes
  for (const prefix of DANGEROUS_PREFIXES) {
    if (lower.includes(prefix.toLowerCase())) {
      return { tier: 'DANGEROUS', reason: `Dangerous operation: "${prefix.trim()}"`, matchedPattern: prefix };
    }
  }

  // Check SAFE prefixes
  for (const prefix of SAFE_PREFIXES) {
    if (lower.startsWith(prefix.toLowerCase())) {
      return { tier: 'SAFE', reason: 'Read-only operation' };
    }
  }

  // Check MODERATE
  for (const pattern of MODERATE_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) {
      return { tier: 'MODERATE', reason: `Write/install operation: "${pattern.trim()}"` };
    }
  }

  // Default: treat unknown as MODERATE (run but log)
  return { tier: 'MODERATE', reason: 'Unknown command — treated as moderate risk' };
}
