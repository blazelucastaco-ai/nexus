// Plugin Architecture — dynamic plugin loading for NEXUS
//
// Plugins live in ~/.nexus/plugins/<plugin-name>/
// Each has a manifest.json and optional index.js for custom tool handlers.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../utils/logger.js';
import type { ToolDefinition } from '../tools/definitions.js';

const log = createLogger('PluginLoader');

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  tools?: ToolDefinition[];
  hooks?: string[];
}

export interface LoadedPlugin {
  dir: string;
  manifest: PluginManifest;
  tools: ToolDefinition[];
  /** Optional JS handler loaded from index.js — maps tool name → handler fn */
  handlers: Record<string, (args: Record<string, unknown>) => Promise<string>>;
}

const PLUGINS_DIR = join(homedir(), '.nexus', 'plugins');

/** Ensure plugins directory exists */
export function ensurePluginsDir(): string {
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true });
    log.info({ dir: PLUGINS_DIR }, 'Created plugins directory');
  }
  return PLUGINS_DIR;
}

/** Load all plugins from ~/.nexus/plugins/ */
export async function loadPlugins(): Promise<LoadedPlugin[]> {
  ensurePluginsDir();

  const plugins: LoadedPlugin[] = [];

  let entries: string[];
  try {
    entries = readdirSync(PLUGINS_DIR);
  } catch {
    return plugins;
  }

  for (const entry of entries) {
    const pluginDir = join(PLUGINS_DIR, entry);
    try {
      const info = statSync(pluginDir);
      if (!info.isDirectory()) continue;

      const manifestPath = join(pluginDir, 'manifest.json');
      if (!existsSync(manifestPath)) {
        log.warn({ dir: pluginDir }, 'Plugin directory missing manifest.json — skipping');
        continue;
      }

      const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

      if (!manifest.name || !manifest.version) {
        log.warn({ dir: pluginDir }, 'Plugin manifest missing name or version — skipping');
        continue;
      }

      const tools: ToolDefinition[] = manifest.tools ?? [];
      const handlers: Record<string, (args: Record<string, unknown>) => Promise<string>> = {};

      // Try to load index.js for custom handlers
      const indexPath = join(pluginDir, 'index.js');
      if (existsSync(indexPath)) {
        try {
          const mod = await import(indexPath);
          // Expect mod.tools: Record<string, handler>
          if (mod.tools && typeof mod.tools === 'object') {
            for (const [toolName, fn] of Object.entries(mod.tools)) {
              if (typeof fn === 'function') {
                handlers[toolName] = fn as (args: Record<string, unknown>) => Promise<string>;
              }
            }
          }
        } catch (err) {
          log.warn({ dir: pluginDir, err }, 'Failed to load plugin index.js — tools will not execute');
        }
      }

      plugins.push({ dir: pluginDir, manifest, tools, handlers });
      log.info(
        { name: manifest.name, version: manifest.version, tools: tools.length },
        'Plugin loaded',
      );
    } catch (err) {
      log.warn({ dir: pluginDir, err }, 'Failed to load plugin — skipping');
    }
  }

  log.info({ count: plugins.length }, 'Plugins loaded');
  return plugins;
}

/** Format plugin list for display */
export function formatPluginList(plugins: LoadedPlugin[]): string {
  if (plugins.length === 0) {
    return `No plugins installed.\n\nAdd plugins to: ${PLUGINS_DIR}\nEach plugin needs a manifest.json with: { name, version, description, tools?, hooks? }`;
  }

  const lines = [`Installed plugins (${plugins.length}):\n`];
  for (const p of plugins) {
    lines.push(`  ${p.manifest.name} v${p.manifest.version}`);
    lines.push(`    ${p.manifest.description}`);
    if (p.tools.length > 0) {
      lines.push(`    Tools: ${p.tools.map((t) => t.name).join(', ')}`);
    }
    if (p.manifest.hooks && p.manifest.hooks.length > 0) {
      lines.push(`    Hooks: ${p.manifest.hooks.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
