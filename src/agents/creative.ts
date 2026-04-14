import type { AgentResult } from '../types.js';
import { BaseAgent } from './base-agent.js';
import { generateId, nowISO } from '../utils/helpers.js';

export class CreativeAgent extends BaseAgent {
  constructor() {
    super('creative', 'Generates creative content — writing prompts, brainstorms, and name ideas', [
      { name: 'write_text', description: 'Generate a structured writing prompt or template for the AI' },
      { name: 'brainstorm', description: 'Generate a structured brainstorm format for a given topic' },
      { name: 'name_generator', description: 'Generate name ideas for projects, products, or concepts' },
    ]);
  }

  async execute(action: string, params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();
    this.log.info({ action, params }, 'CreativeAgent executing');

    try {
      switch (action) {
        case 'write_text':
          return this.writeText(params, start);
        case 'brainstorm':
          return this.brainstorm(params, start);
        case 'name_generator':
          return this.nameGenerator(params, start);
        default:
          return this.createResult(false, null, `Unknown action: ${action}`, start);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ action, error: msg }, 'CreativeAgent failed');
      return this.createResult(false, null, msg, start);
    }
  }

  private writeText(params: Record<string, unknown>, start: number): AgentResult {
    const topic = String(params.topic ?? 'general');
    const style = String(params.style ?? 'professional');
    const format = String(params.format ?? 'article');
    const length = String(params.length ?? 'medium');
    const audience = String(params.audience ?? 'general');

    const lengthGuide: Record<string, string> = {
      short: '200-400 words',
      medium: '500-800 words',
      long: '1000-1500 words',
      brief: '50-100 words',
    };

    const template = {
      id: generateId(),
      type: 'writing_prompt',
      prompt: `Write a ${format} about "${topic}" in a ${style} style.`,
      guidelines: {
        topic,
        style,
        format,
        targetLength: lengthGuide[length] ?? lengthGuide.medium,
        audience,
      },
      structure: this.getStructureTemplate(format),
      createdAt: nowISO(),
    };

    return this.createResult(true, template, undefined, start);
  }

  private getStructureTemplate(format: string): string[] {
    const structures: Record<string, string[]> = {
      article: [
        'Compelling headline',
        'Hook / opening paragraph',
        'Context and background',
        'Main points (3-5)',
        'Supporting evidence or examples',
        'Conclusion with takeaway',
      ],
      email: [
        'Subject line',
        'Greeting',
        'Purpose statement (first sentence)',
        'Details / body',
        'Call to action',
        'Sign-off',
      ],
      blog: [
        'SEO-friendly title',
        'Hook / intro paragraph',
        'Table of contents (for long posts)',
        'Sections with subheadings',
        'Practical examples or code snippets',
        'Summary / key takeaways',
        'CTA or next steps',
      ],
      social: [
        'Attention-grabbing first line',
        'Core message (1-2 sentences)',
        'Hashtags or mentions',
        'Call to action',
      ],
      story: [
        'Setting / world-building',
        'Character introduction',
        'Inciting incident',
        'Rising action',
        'Climax',
        'Resolution',
      ],
    };

    return structures[format] ?? structures.article;
  }

  private brainstorm(params: Record<string, unknown>, start: number): AgentResult {
    const topic = String(params.topic);
    const context = String(params.context ?? '');
    const constraints = (params.constraints as string[]) ?? [];
    const method = String(params.method ?? 'structured');

    const methods: Record<string, object> = {
      structured: {
        format: 'Structured Brainstorm',
        sections: [
          {
            name: 'Problem Definition',
            prompt: `Clearly define the core problem or opportunity around "${topic}"`,
          },
          {
            name: 'Current State',
            prompt: 'What exists today? What are the pain points?',
          },
          {
            name: 'Wild Ideas',
            prompt: 'Generate 10 ideas with no constraints — quantity over quality',
          },
          {
            name: 'Practical Ideas',
            prompt: 'Generate 5 ideas that could be implemented this week',
          },
          {
            name: 'Moonshot Ideas',
            prompt: 'Generate 3 ambitious ideas that could be game-changers',
          },
          {
            name: 'Constraints Check',
            prompt: `Filter ideas through these constraints: ${constraints.join(', ') || 'none specified'}`,
          },
          {
            name: 'Top 3 Picks',
            prompt: 'Select the top 3 ideas and outline next steps for each',
          },
        ],
      },
      scamper: {
        format: 'SCAMPER Method',
        prompts: [
          { letter: 'S', name: 'Substitute', prompt: `What can be substituted in "${topic}"?` },
          { letter: 'C', name: 'Combine', prompt: 'What can be combined or merged?' },
          { letter: 'A', name: 'Adapt', prompt: 'What can be adapted from other domains?' },
          { letter: 'M', name: 'Modify', prompt: 'What can be modified, magnified, or minimized?' },
          { letter: 'P', name: 'Put to other uses', prompt: 'Can this be used in a different way?' },
          { letter: 'E', name: 'Eliminate', prompt: 'What can be removed or simplified?' },
          { letter: 'R', name: 'Reverse', prompt: 'What if we reversed or rearranged the process?' },
        ],
      },
      sixhats: {
        format: 'Six Thinking Hats',
        hats: [
          { color: 'White', focus: 'Facts', prompt: `What data and facts do we have about "${topic}"?` },
          { color: 'Red', focus: 'Feelings', prompt: 'What is your gut reaction? What feels right or wrong?' },
          { color: 'Black', focus: 'Caution', prompt: 'What are the risks and downsides?' },
          { color: 'Yellow', focus: 'Optimism', prompt: 'What are the benefits and best-case outcomes?' },
          { color: 'Green', focus: 'Creativity', prompt: 'What new ideas or alternatives exist?' },
          { color: 'Blue', focus: 'Process', prompt: 'What is the next step? How do we decide?' },
        ],
      },
    };

    const brainstormData = {
      id: generateId(),
      topic,
      context,
      constraints,
      method,
      ...(methods[method] ?? methods.structured),
      createdAt: nowISO(),
    };

    return this.createResult(true, brainstormData, undefined, start);
  }

  private nameGenerator(params: Record<string, unknown>, start: number): AgentResult {
    const concept = String(params.concept ?? params.topic ?? 'project');
    const style = String(params.style ?? 'tech');
    const count = Number(params.count ?? 10);
    const keywords = (params.keywords as string[]) ?? [];

    const prefixes: Record<string, string[]> = {
      tech: ['Neo', 'Flux', 'Apex', 'Pulse', 'Zeta', 'Nova', 'Hyper', 'Core', 'Meta', 'Sync', 'Drift', 'Aura'],
      elegant: ['Aria', 'Luna', 'Stella', 'Ember', 'Sage', 'Haven', 'Crest', 'Bloom', 'Pearl', 'Velvet'],
      bold: ['Thunder', 'Strike', 'Forge', 'Blaze', 'Titan', 'Vanguard', 'Apex', 'Prime', 'Iron', 'Storm'],
      playful: ['Fizz', 'Pop', 'Spark', 'Ziggy', 'Boop', 'Snap', 'Dash', 'Zoom', 'Wobble', 'Glimmer'],
      minimal: ['Dot', 'Line', 'Arc', 'Node', 'Loop', 'Void', 'Zero', 'One', 'Edge', 'Link'],
    };

    const suffixes: Record<string, string[]> = {
      tech: ['ly', 'io', 'ify', 'hub', 'lab', 'OS', 'AI', 'X', 'flow', 'stack'],
      elegant: ['', 'co', 'studio', 'house', 'craft', 'works'],
      bold: ['force', 'works', 'corp', 'pro', 'max', 'systems'],
      playful: ['!', 'oo', 'ey', 'pop', 'go', 'fun'],
      minimal: ['', '.so', '.co', '.app', '.dev', '.run'],
    };

    const stylePrefixes = prefixes[style] ?? prefixes.tech;
    const styleSuffixes = suffixes[style] ?? suffixes.tech;

    const safeCount = Math.min(count, stylePrefixes.length * 3, 50);
    const names: string[] = [];
    // Shuffle prefix indices so each name gets a unique prefix until pool is exhausted
    const prefixPool = stylePrefixes.map((_, i) => i).sort(() => Math.random() - 0.5);

    for (let i = 0; i < safeCount; i++) {
      const prefixIdx = prefixPool[i % prefixPool.length]!;
      const prefix = stylePrefixes[prefixIdx]!;
      const suffix = styleSuffixes[Math.floor(Math.random() * styleSuffixes.length)];
      const keyword = keywords.length > 0 ? keywords[Math.floor(Math.random() * keywords.length)] : '';

      if (keyword && Math.random() > 0.5) {
        names.push(`${prefix}${keyword.charAt(0).toUpperCase() + keyword.slice(1)}${suffix}`);
      } else {
        names.push(`${prefix}${suffix}`);
      }
    }

    return this.createResult(
      true,
      {
        concept,
        style,
        keywords,
        names: [...new Set(names)].slice(0, safeCount),
        generatedAt: nowISO(),
        note: 'These are starter suggestions. Combine, modify, or use as inspiration.',
      },
      undefined,
      start,
    );
  }
}
