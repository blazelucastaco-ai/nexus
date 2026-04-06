import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import type { AgentResult } from '../types.js';
import { BaseAgent } from './base-agent.js';
import { generateId, nowISO } from '../utils/helpers.js';

const execFileAsync = promisify(execFile);

const SCREENSHOT_DIR = join(homedir(), '.nexus', 'screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

export class VisionAgent extends BaseAgent {
  constructor() {
    super('vision', 'Captures and analyzes screen content using macOS screencapture', [
      { name: 'screenshot', description: 'Take a screenshot of the entire screen or a specific window' },
      { name: 'analyze_screen', description: 'Take a screenshot and return its path for AI analysis' },
      { name: 'ocr_region', description: 'Capture a screen region for text extraction' },
    ]);
  }

  async execute(action: string, params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();
    this.log.info({ action, params }, 'VisionAgent executing');

    try {
      switch (action) {
        case 'screenshot':
          return await this.screenshot(params);
        case 'analyze_screen':
          return await this.analyzeScreen(params);
        case 'ocr_region':
          return await this.ocrRegion(params);
        default:
          return this.createResult(false, null, `Unknown action: ${action}`, start);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ action, error: msg }, 'VisionAgent failed');
      return this.createResult(false, null, msg, start);
    }
  }

  private async screenshot(params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();
    const filename = `screenshot_${generateId()}.png`;
    const filepath = join(SCREENSHOT_DIR, filename);
    const args: string[] = [];

    // -x suppresses the shutter sound
    args.push('-x');

    if (params.window) {
      // Capture the frontmost window
      args.push('-w');
    }

    if (params.interactive) {
      // Interactive selection mode
      args.push('-i');
    }

    args.push(filepath);

    await execFileAsync('screencapture', args, { timeout: 10_000 });

    this.log.info({ filepath }, 'Screenshot captured');
    return this.createResult(true, { path: filepath, filename, capturedAt: nowISO() }, undefined, start);
  }

  private async analyzeScreen(params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();
    const screenshotResult = await this.screenshot(params);

    if (!screenshotResult.success) {
      return screenshotResult;
    }

    const data = screenshotResult.data as { path: string; filename: string; capturedAt: string };

    return this.createResult(
      true,
      {
        path: data.path,
        filename: data.filename,
        capturedAt: data.capturedAt,
        analysis: 'Screenshot captured. Pass the image path to an AI model for visual analysis.',
      },
      undefined,
      start,
    );
  }

  private async ocrRegion(params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();
    const filename = `ocr_region_${generateId()}.png`;
    const filepath = join(SCREENSHOT_DIR, filename);

    const args: string[] = ['-x'];

    if (params.rect && typeof params.rect === 'string') {
      // rect format: "x,y,width,height"
      args.push('-R', params.rect);
    } else {
      // Interactive region selection
      args.push('-s');
    }

    args.push(filepath);

    await execFileAsync('screencapture', args, { timeout: 15_000 });

    this.log.info({ filepath }, 'Region captured for OCR');
    return this.createResult(
      true,
      {
        path: filepath,
        filename,
        capturedAt: nowISO(),
        note: 'Region captured. Pass to AI model with OCR prompt for text extraction.',
      },
      undefined,
      start,
    );
  }
}
