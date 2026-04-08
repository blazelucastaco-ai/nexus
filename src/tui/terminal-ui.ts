// Interactive Terminal UI — rich terminal interface for dev-chat
// Shows spinners, tool progress, mood indicators, and memory recall.

import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { formatCodeBlock, formatNexusResponse } from './formatters.js';

export type MoodIndicator = 'good' | 'neutral' | 'low';

interface ToolEvent {
  name: string;
  startedAt: number;
  spinner: Ora;
}

export class TerminalUI {
  private thinkingSpinner: Ora | null = null;
  private activeToolSpinners = new Map<string, ToolEvent>();
  private mood: MoodIndicator = 'neutral';
  private sessionStart = Date.now();

  /**
   * Print the NEXUS banner at startup.
   */
  printBanner(): void {
    const moodEmoji = this.mood === 'good' ? '😊' : this.mood === 'low' ? '😐' : '🤖';
    console.log(chalk.cyan.bold('\n╔══════════════════════════════╗'));
    console.log(chalk.cyan.bold('║  NEXUS  ') + chalk.white('Personal AI v1.0') + chalk.cyan.bold('  ║'));
    console.log(chalk.cyan.bold('╚══════════════════════════════╝'));
    console.log(chalk.gray(`  Mood: ${moodEmoji}  Session started\n`));
  }

  /**
   * Show spinner while NEXUS is thinking.
   */
  startThinking(): void {
    this.thinkingSpinner = ora({
      text: chalk.gray('Thinking...'),
      spinner: 'dots',
      color: 'cyan',
    }).start();
  }

  /**
   * Stop thinking spinner.
   */
  stopThinking(): void {
    if (this.thinkingSpinner) {
      this.thinkingSpinner.stop();
      this.thinkingSpinner = null;
    }
  }

  /**
   * Show tool execution start.
   */
  startTool(toolName: string, args?: Record<string, unknown>): string {
    const id = `${toolName}_${Date.now()}`;
    const label = this.formatToolLabel(toolName, args);
    const spinner = ora({
      text: chalk.yellow(`⚙ ${label}`),
      spinner: 'line',
      color: 'yellow',
    }).start();
    this.activeToolSpinners.set(id, { name: toolName, startedAt: Date.now(), spinner });
    return id;
  }

  /**
   * Show tool execution completion.
   */
  completeTool(id: string, success = true): void {
    const event = this.activeToolSpinners.get(id);
    if (!event) return;

    const duration = Date.now() - event.startedAt;
    const durationStr = duration > 1000 ? `${(duration / 1000).toFixed(1)}s` : `${duration}ms`;

    if (success) {
      event.spinner.succeed(chalk.green(`✓ ${event.name}`) + chalk.gray(` (${durationStr})`));
    } else {
      event.spinner.fail(chalk.red(`✗ ${event.name}`) + chalk.gray(` (${durationStr})`));
    }

    this.activeToolSpinners.delete(id);
  }

  /**
   * Show memory recall indicator.
   */
  showMemoryRecall(query: string): void {
    console.log(chalk.blue(`  🧠 Recalling: "${query.slice(0, 50)}"`));
  }

  /**
   * Print the final NEXUS response with formatting.
   */
  printResponse(content: string): void {
    this.stopThinking();

    if (!content.trim()) return;

    // Format code blocks
    const formatted = content.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
      return '\n' + formatCodeBlock(code.trim(), lang) + '\n';
    });

    console.log('\n' + formatNexusResponse(formatted, this.mood));
    console.log(chalk.gray('─'.repeat(50)));
  }

  /**
   * Set mood (affects colors and emoji).
   */
  setMood(mood: MoodIndicator): void {
    this.mood = mood;
  }

  /**
   * Print user input echo.
   */
  printUserInput(text: string): void {
    console.log(chalk.white.bold(`\nYou › `) + chalk.white(text));
  }

  /**
   * Print an inline status note (not a spinner).
   */
  printNote(msg: string): void {
    console.log(chalk.gray(`  → ${msg}`));
  }

  /**
   * Print error.
   */
  printError(msg: string): void {
    console.log(chalk.red(`  ✗ ${msg}`));
  }

  /**
   * Stop all active spinners (e.g. on unexpected exit).
   */
  cleanup(): void {
    this.stopThinking();
    for (const [id] of this.activeToolSpinners) {
      this.completeTool(id, false);
    }
  }

  private formatToolLabel(toolName: string, args?: Record<string, unknown>): string {
    const labels: Record<string, (a: Record<string, unknown>) => string> = {
      run_terminal_command: (a) => `run: ${String(a.command ?? '').slice(0, 40)}`,
      write_file: (a) => `write: ${String(a.path ?? '').split('/').pop()}`,
      read_file: (a) => `read: ${String(a.path ?? '').split('/').pop()}`,
      web_search: (a) => `search: "${String(a.query ?? '').slice(0, 30)}"`,
      web_fetch: (a) => `fetch: ${String(a.url ?? '').slice(0, 40)}`,
      crawl_url: (a) => `crawl: ${String(a.url ?? '').slice(0, 40)}`,
      understand_image: (a) => `vision: ${String(a.source ?? '').slice(0, 30)}`,
      read_pdf: (a) => `pdf: ${String(a.path ?? a.url ?? '').split('/').pop()}`,
      remember: (a) => `remember: "${String(a.content ?? '').slice(0, 30)}"`,
      recall: (a) => `recall: "${String(a.query ?? '').slice(0, 30)}"`,
    };
    const fn = labels[toolName];
    return (fn !== undefined && args !== undefined) ? fn(args) : toolName.replace(/_/g, ' ');
  }
}

// Singleton for dev-chat usage
export const tui = new TerminalUI();
