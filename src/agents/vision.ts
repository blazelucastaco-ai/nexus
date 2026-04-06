import { readFile } from 'node:fs/promises';
import type { AgentResult } from '../types.js';
import { BaseAgent } from './base-agent.js';
import { nowISO } from '../utils/helpers.js';
import { captureScreen, captureRegion } from '../macos/screenshots.js';

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
    const filepath = await captureScreen();
    this.log.info({ filepath }, 'Screenshot captured');
    return this.createResult(true, { path: filepath, capturedAt: nowISO() }, undefined, start);
  }

  private async analyzeScreen(params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();
    const filepath = await captureScreen();

    // Read the image as base64 so callers can pass it directly to a vision model
    const imageBase64 = await readFile(filepath, { encoding: 'base64' });

    this.log.info({ filepath }, 'Screen captured for analysis');
    return this.createResult(
      true,
      {
        path: filepath,
        imageBase64,
        mimeType: 'image/png',
        capturedAt: nowISO(),
        analysis: 'Screenshot captured. Pass imageBase64 to a vision model for analysis.',
      },
      undefined,
      start,
    );
  }

  private async ocrRegion(params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();

    let filepath: string;
    if (params.rect && typeof params.rect === 'string') {
      // rect format: "x,y,width,height"
      const parts = (params.rect as string).split(',').map(Number);
      if (parts.length !== 4 || parts.some(Number.isNaN)) {
        return this.createResult(false, null, 'rect must be "x,y,width,height"', start);
      }
      const [x, y, w, h] = parts as [number, number, number, number];
      filepath = await captureRegion(x, y, w, h);
    } else {
      filepath = await captureScreen();
    }

    const imageBase64 = await readFile(filepath, { encoding: 'base64' });

    this.log.info({ filepath }, 'Region captured for OCR');
    return this.createResult(
      true,
      {
        path: filepath,
        imageBase64,
        mimeType: 'image/png',
        capturedAt: nowISO(),
        note: 'Region captured. Pass imageBase64 to a vision model with an OCR prompt.',
      },
      undefined,
      start,
    );
  }
}
