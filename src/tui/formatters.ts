// Terminal UI — Formatters for rich terminal output
// Handles code blocks, tables, lists, and highlighted text.

import chalk from 'chalk';

/**
 * Format a code block with syntax highlighting via chalk.
 */
export function formatCodeBlock(code: string, language = ''): string {
  const lines = code.split('\n');
  const border = chalk.gray('─'.repeat(50));
  const header = language ? chalk.gray(`  ${language}`) : '';

  const highlighted = lines.map((line) => {
    // Simple keyword highlighting
    return line
      .replace(/\b(const|let|var|function|class|import|export|return|if|else|for|while|async|await|new|typeof|instanceof)\b/g,
        (m) => chalk.blue(m))
      .replace(/\b(true|false|null|undefined|NaN|Infinity)\b/g,
        (m) => chalk.yellow(m))
      .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g,
        (m) => chalk.green(m))
      .replace(/\b(\d+(?:\.\d+)?)\b/g,
        (m) => chalk.magenta(m))
      .replace(/(\/\/.*$)/gm,
        (m) => chalk.gray(m));
  }).join('\n');

  return `${header}\n${border}\n${highlighted}\n${border}`;
}

/**
 * Format a key-value table.
 */
export function formatTable(rows: Array<[string, string]>, title?: string): string {
  const maxKey = Math.max(...rows.map(([k]) => k.length));
  const lines = rows.map(([k, v]) => {
    return `  ${chalk.cyan(k.padEnd(maxKey + 2))}${chalk.white(v)}`;
  });
  if (title) {
    return `${chalk.bold.underline(title)}\n${lines.join('\n')}`;
  }
  return lines.join('\n');
}

/**
 * Format a bulleted list.
 */
export function formatList(items: string[], bullet = '•'): string {
  return items.map((item) => `  ${chalk.gray(bullet)} ${item}`).join('\n');
}

/**
 * Format a success message.
 */
export function formatSuccess(msg: string): string {
  return `${chalk.green('✓')} ${msg}`;
}

/**
 * Format an error message.
 */
export function formatError(msg: string): string {
  return `${chalk.red('✗')} ${chalk.red(msg)}`;
}

/**
 * Format a warning.
 */
export function formatWarning(msg: string): string {
  return `${chalk.yellow('⚠')} ${chalk.yellow(msg)}`;
}

/**
 * Format an info line.
 */
export function formatInfo(msg: string): string {
  return `${chalk.blue('ℹ')} ${msg}`;
}

/**
 * Strip ANSI codes from a string (for plain-text output contexts).
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/**
 * Wrap a NEXUS response with mood-colored prefix.
 */
export function formatNexusResponse(content: string, mood: 'good' | 'neutral' | 'low' = 'neutral'): string {
  const moodColors: Record<string, (s: string) => string> = {
    good: (s: string) => chalk.green(s),
    neutral: (s: string) => chalk.cyan(s),
    low: (s: string) => chalk.gray(s),
  };
  const colorFn = moodColors[mood] ?? ((s: string) => chalk.cyan(s));
  const prefix = colorFn('NEXUS › ');
  return prefix + content.replace(/\n/g, '\n' + ' '.repeat(8));
}
