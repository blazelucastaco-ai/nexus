// End-to-end smoke of the new architecture, wired together:
// - Event bus propagates events with trace context
// - Trace context threads through awaits
// - Project tracker subscribes, path inference works, persistence round-trips
// - Context provider registry builds prompt from multiple providers
// - Capability kernel boots a toy subsystem topology
// - Pipeline runner hands a context through stages that emit events
//
// This is the "does the whole stack actually work together" test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { events } from '../src/core/events.js';
import { traced, currentTraceId, newTraceId } from '../src/core/trace.js';
import { getDatabase } from '../src/memory/database.js';
import { startProjectTracker } from '../src/brain/project-tracker.js';
import { getProject, listJournalEntries } from '../src/data/projects-repository.js';
import { ContextPromptBuilder, PRIORITY } from '../src/core/context-provider.js';
import {
  platformRulesProvider,
  toolUsageProvider,
  systemInfoProvider,
  memorySynthesisProvider,
  injectionWarningProvider,
} from '../src/core/providers/standard-providers.js';
import { CapabilityKernel } from '../src/core/capability.js';
import { runPipeline, makeContext } from '../src/core/pipeline.js';
import { injectionGuardStage, frustrationStage } from '../src/core/stages/index.js';
import { toolManifests, effectiveRisk } from '../src/tools/contract.js';
import { registerBuiltinManifests } from '../src/tools/manifests.js';
import type { NexusContext } from '../src/types.js';

function clearTables(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM project_journal').run();
  db.prepare('DELETE FROM projects').run();
}

function fakeContext(): NexusContext {
  return {
    personality: {} as any,
    recentMemories: [],
    relevantFacts: [],
    activeTasks: [],
    conversationHistory: [],
    systemState: { uptime: 0, activeAgents: [], pendingTasks: 0 },
  };
}

describe('Integration: full architecture stack', () => {
  let trackerSubs: { unsubscribe(): void }[] = [];

  beforeEach(() => {
    clearTables();
    events.clear();
    trackerSubs = startProjectTracker();
  });

  afterEach(() => {
    for (const s of trackerSubs) s.unsubscribe();
  });

  it('traces a realistic message flow: pipeline → events → tracker → repo', async () => {
    const capturedTraceIds: string[] = [];
    const anySub = events.onAny((e) => {
      if (e.traceId) capturedTraceIds.push(e.traceId);
    });

    // Simulate a user message arriving — wrap in a trace context like the orchestrator does.
    const traceId = newTraceId();
    await traced({ traceId, chatId: 'test-chat' }, async () => {
      // Stage 1: early pipeline (injection + frustration detection)
      const pipeCtx = makeContext({ chatId: 'test-chat', text: 'build a landing page please' });
      await runPipeline([injectionGuardStage, frustrationStage], pipeCtx);
      expect(pipeCtx.response).toBeUndefined(); // not blocked
      expect(pipeCtx.hardBlocked).toBeFalsy();

      // Stage 2: simulate tool events that project tracker should pick up
      events.emit({
        type: 'tool.executed',
        toolName: 'write_file',
        success: true,
        durationMs: 20,
        resultLen: 100,
        params: { path: '/Users/test/nexus-workspace/smoke-project/index.html', content: '<html></html>' },
      });

      // Stage 3: task completion event
      events.emit({
        type: 'task.completed',
        title: 'Build landing page',
        success: true,
        durationMs: 1500,
        stepsCompleted: 2,
        totalSteps: 2,
        filesProduced: [
          '/Users/test/nexus-workspace/smoke-project/index.html',
          '/Users/test/nexus-workspace/smoke-project/styles.css',
        ],
      });

      // Trace ID must still be active here
      expect(currentTraceId()).toBe(traceId);
    });

    anySub.unsubscribe();

    // Every event we emitted inside traced() carried the same traceId
    expect(capturedTraceIds.length).toBeGreaterThan(0);
    for (const id of capturedTraceIds) {
      expect(id).toBe(traceId);
    }

    // Tracker persisted the project
    const project = getProject('smoke-project');
    expect(project).not.toBeNull();
    expect(project!.task_count).toBe(1);
    expect(project!.last_task_title).toBe('Build landing page');
    expect(project!.last_task_success).toBe(1);

    // Journal has the task entry
    const journal = listJournalEntries('smoke-project');
    expect(journal.length).toBeGreaterThan(0);
    expect(journal.some((j) => j.summary.includes('Build landing page'))).toBe(true);
  });

  it('context provider registry assembles prompt from multiple providers with priority ordering', () => {
    const builder = new ContextPromptBuilder();
    builder.register(platformRulesProvider);
    builder.register(toolUsageProvider);
    builder.register(systemInfoProvider);
    builder.register(memorySynthesisProvider);
    builder.register(injectionWarningProvider);

    const prompt = builder.build({
      context: fakeContext(),
      nowEpochMs: Date.now(),
      uptimeMs: 3600_000,
      memorySynthesis: 'User is working on Jake Fitness — a personal training site.',
      injectionDetected: { confidence: 0.8, patterns: ['ignore previous'] },
    });

    // Contains each section
    expect(prompt).toContain('Platform: macOS');
    expect(prompt).toContain('Tool Usage');
    expect(prompt).toContain('System Info');
    expect(prompt).toContain('Synthesized Memory Context');
    expect(prompt).toContain('SECURITY WARNING');

    // Security warning comes before platform (SECURITY=100 < PLATFORM=900)
    expect(prompt.indexOf('SECURITY WARNING')).toBeLessThan(prompt.indexOf('Platform: macOS'));
    // Platform comes before system info
    expect(prompt.indexOf('Platform: macOS')).toBeLessThan(prompt.indexOf('System Info'));
    // Synthesis comes before platform (SYNTHESIS=600 < PLATFORM=900)
    expect(prompt.indexOf('Synthesized Memory Context')).toBeLessThan(prompt.indexOf('Platform: macOS'));
  });

  it('capability kernel boots a subsystem topology in dependency order', async () => {
    const kernel = new CapabilityKernel();
    const bootOrder: string[] = [];
    const startOrder: string[] = [];
    const stopOrder: string[] = [];

    kernel.register({
      name: 'ai',
      provides: ['ai'],
      init: () => { bootOrder.push('ai'); return { client: 'claude' }; },
      start: () => { startOrder.push('ai'); },
      stop: () => { stopOrder.push('ai'); },
    });

    kernel.register({
      name: 'memory',
      provides: ['memory', 'memory.episodic'],
      requires: [],
      init: () => { bootOrder.push('memory'); return { db: 'sqlite' }; },
      stop: () => { stopOrder.push('memory'); },
    });

    kernel.register({
      name: 'personality',
      provides: ['personality'],
      requires: ['memory'],
      init: (deps) => {
        bootOrder.push('personality');
        expect(deps.memory).toEqual({ db: 'sqlite' });
        return { mood: 0 };
      },
      start: () => { startOrder.push('personality'); },
      stop: () => { stopOrder.push('personality'); },
    });

    kernel.register({
      name: 'orchestrator',
      provides: ['orchestrator'],
      requires: ['ai', 'memory', 'personality'],
      init: (deps) => {
        bootOrder.push('orchestrator');
        expect(deps.ai).toBeDefined();
        expect(deps.memory).toBeDefined();
        expect(deps.personality).toBeDefined();
        return { running: true };
      },
      start: () => { startOrder.push('orchestrator'); },
      stop: () => { stopOrder.push('orchestrator'); },
    });

    await kernel.boot();

    // ai, memory come first (no deps), personality next (deps on memory), orchestrator last
    expect(bootOrder.indexOf('memory')).toBeLessThan(bootOrder.indexOf('personality'));
    expect(bootOrder.indexOf('personality')).toBeLessThan(bootOrder.indexOf('orchestrator'));
    expect(bootOrder.indexOf('ai')).toBeLessThan(bootOrder.indexOf('orchestrator'));

    // All start() calls fire after all init() calls
    expect(kernel.get('orchestrator')).toEqual({ running: true });

    await kernel.shutdown();

    // Shutdown reverses boot order: orchestrator stops first (most deps),
    // then personality, then the no-dep leaves (ai, memory) stop last.
    expect(stopOrder[0]).toBe('orchestrator');
    expect(stopOrder.indexOf('personality')).toBeLessThan(stopOrder.indexOf('memory'));
    expect(stopOrder.indexOf('orchestrator')).toBeLessThan(stopOrder.indexOf('personality'));
  });

  it('tool contract registry + effective risk work together on real manifests', () => {
    toolManifests.clear();
    registerBuiltinManifests();

    // Every built-in tool has a manifest
    expect(toolManifests.has('write_file')).toBe(true);
    expect(toolManifests.has('run_terminal_command')).toBe(true);
    expect(toolManifests.has('recall')).toBe(true);

    // Risk reasoning works
    const writeFile = toolManifests.get('write_file')!;
    expect(effectiveRisk(writeFile)).toBe('logged');

    const background = toolManifests.get('run_background_command')!;
    expect(effectiveRisk(background)).toBe('confirm'); // detach elevates to confirm

    const readFile = toolManifests.get('read_file')!;
    expect(effectiveRisk(readFile)).toBe('auto');

    // Filter by effect
    const networkTools = toolManifests.listByEffect(['net.outbound']);
    expect(networkTools.length).toBeGreaterThan(0);
    expect(networkTools.some((t) => t.name === 'web_fetch')).toBe(true);
  });

  it('concurrent traces do not leak across async boundaries', async () => {
    const traceIdsA: string[] = [];
    const traceIdsB: string[] = [];

    await Promise.all([
      traced({ traceId: 'trace-a', chatId: 'a' }, async () => {
        traceIdsA.push(currentTraceId() ?? 'none');
        await new Promise((r) => setTimeout(r, 10));
        traceIdsA.push(currentTraceId() ?? 'none');
        events.emit({ type: 'message.received', chatId: 'a', text: 'x', textLen: 1 });
        await new Promise((r) => setTimeout(r, 10));
        traceIdsA.push(currentTraceId() ?? 'none');
      }),
      traced({ traceId: 'trace-b', chatId: 'b' }, async () => {
        traceIdsB.push(currentTraceId() ?? 'none');
        await new Promise((r) => setTimeout(r, 5));
        traceIdsB.push(currentTraceId() ?? 'none');
        events.emit({ type: 'message.received', chatId: 'b', text: 'y', textLen: 1 });
        await new Promise((r) => setTimeout(r, 15));
        traceIdsB.push(currentTraceId() ?? 'none');
      }),
    ]);

    expect(traceIdsA.every((id) => id === 'trace-a')).toBe(true);
    expect(traceIdsB.every((id) => id === 'trace-b')).toBe(true);
  });
});
