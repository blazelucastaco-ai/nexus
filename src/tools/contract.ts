// Tool contract — declarative capabilities + risk model.
//
// The current ToolExecutor has 40+ tools inlined in a big switch and relies
// on a sparse TOOL_RISK map for approval gating. This file introduces a
// declarative contract: every tool is a ToolManifest that explicitly
// declares what it reads, writes, spawns, or touches.
//
// Benefits:
// - Approval gate can reason structurally: "this tool writes to fs AND
//   spawns a process — require confirmation even though risk tier says
//   logged."
// - Audit / telemetry can categorize tools by effect (network vs fs vs
//   process) for dashboards.
// - Typed input via Zod schemas gives runtime validation for free.
// - Tools become self-describing for docs and MCP-style integrations.
//
// Migration strategy: ToolExecutor keeps its switch for now. Each tool
// gains a manifest entry; approval gate reads from manifests when present,
// falls back to the legacy risk tier for tools without a manifest.

import type { ZodType } from 'zod';

/**
 * Side effects a tool may perform. Used by approval gate and audit layer.
 * A tool can declare multiple; e.g. `write_file` reads fs then writes fs.
 */
export type ToolEffect =
  | 'fs.read'       // Reads from the filesystem (outside workspace)
  | 'fs.write'      // Writes or modifies files
  | 'fs.delete'     // Removes files or directories
  | 'net.outbound'  // Makes outbound network requests (HTTP, DNS, etc.)
  | 'process.spawn' // Starts a child process (short-lived)
  | 'process.detach'// Starts a detached background process
  | 'mem.read'      // Queries the NEXUS memory store
  | 'mem.write'     // Stores/modifies memories
  | 'os.input'      // Simulates keyboard/mouse input on the host
  | 'os.screenshot' // Captures the screen
  | 'browser.read'  // Reads browser DOM/state (via Chrome bridge)
  | 'browser.write' // Modifies browser state (navigate, click, fill)
  | 'telegram.send' // Sends messages via Telegram
  | 'llm.call';     // Makes an LLM API call (cost/latency signal)

/**
 * Risk tier — coarser than effects, used for the default approval behavior.
 * Effects refine this: a LOGGED tool that declares `fs.delete` should be
 * treated as CONFIRM by the approval gate.
 */
export type RiskTier = 'auto' | 'logged' | 'confirm';

/**
 * A declarative description of a tool. The ToolExecutor still owns the
 * actual implementation; this is metadata consumed by approval gate,
 * audit, and docs generation.
 */
export interface ToolManifest<Input = unknown> {
  /** Canonical tool name as used in OpenAI function-call format. */
  name: string;
  /** Short description shown to the LLM. */
  description: string;
  /**
   * Zod schema for input validation. If present, ToolExecutor can use it
   * to validate args before dispatching. Optional — tools without schemas
   * fall through to legacy runtime checks.
   */
  inputSchema?: ZodType<Input>;
  /** Declared side-effects — the core of the capability model. */
  effects: readonly ToolEffect[];
  /** Default risk tier, before effect-based refinement. */
  risk: RiskTier;
  /** True if this tool is idempotent (safe to retry). */
  idempotent?: boolean;
  /** True if this tool should NEVER be retried on transient error. */
  noRetry?: boolean;
  /** Optional category for grouping in UI / docs. */
  category?: 'files' | 'terminal' | 'browser' | 'memory' | 'system' | 'media' | 'web' | 'meta' | 'tasks';
  /** Optional keywords for tool discovery / planning. */
  keywords?: readonly string[];
}

// ─── Effect categorization helpers ──────────────────────────────────────────

const DESTRUCTIVE_EFFECTS: readonly ToolEffect[] = [
  'fs.delete', 'fs.write', 'browser.write', 'telegram.send', 'os.input', 'process.detach',
];

/**
 * Return the effective risk tier after considering declared effects.
 * This is the structural reasoning the approval gate should use.
 */
export function effectiveRisk(manifest: ToolManifest): RiskTier {
  // Any destructive effect elevates to at least logged.
  const hasDestructive = manifest.effects.some((e) => DESTRUCTIVE_EFFECTS.includes(e));

  // fs.delete alone elevates to confirm unconditionally.
  if (manifest.effects.includes('fs.delete')) return 'confirm';

  // Detached process spawn is inherently dangerous (can outlive NEXUS).
  if (manifest.effects.includes('process.detach')) return 'confirm';

  // Otherwise trust the declared risk, but never downgrade past auto
  // if the tool has any destructive effect.
  if (hasDestructive && manifest.risk === 'auto') return 'logged';
  return manifest.risk;
}

// ─── Registry ──────────────────────────────────────────────────────────────

class ToolManifestRegistry {
  private manifests = new Map<string, ToolManifest>();

  register<T>(manifest: ToolManifest<T>): void {
    this.manifests.set(manifest.name, manifest as ToolManifest);
  }

  get(name: string): ToolManifest | undefined {
    return this.manifests.get(name);
  }

  has(name: string): boolean {
    return this.manifests.has(name);
  }

  list(): ToolManifest[] {
    return Array.from(this.manifests.values());
  }

  /** Tools whose declared effects intersect a given set. */
  listByEffect(effects: ToolEffect[]): ToolManifest[] {
    const wanted = new Set(effects);
    return this.list().filter((m) => m.effects.some((e) => wanted.has(e)));
  }

  clear(): void {
    this.manifests.clear();
  }
}

export const toolManifests = new ToolManifestRegistry();
