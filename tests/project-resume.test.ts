import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDatabase } from '../src/memory/database.js';
import {
  upsertProject,
  appendJournalEntry,
  recordProjectTask,
  getProject,
} from '../src/data/projects-repository.js';
import { handleResume } from '../src/telegram/commands.js';

// Only scrub the project names this test file creates — a global truncate
// would race with other test files (like projects-repository.test.ts which
// relies on 1-second timing of its own rows).
const TEST_PROJECT_NAMES = ['jake-fitness', 'pufftracker', 'trading-bot', 'nonexistent-project'];

function clearProjects(): void {
  const db = getDatabase();
  for (const name of TEST_PROJECT_NAMES) {
    db.prepare('DELETE FROM project_journal WHERE project_name = ?').run(name);
    db.prepare('DELETE FROM projects WHERE name = ?').run(name);
  }
}

function makeCtx() {
  const reply = vi.fn(async () => undefined);
  return {
    reply,
    chat: { id: 999 },
    ctx: {
      reply,
      chat: { id: 999 },
    } as any,
  };
}

function makeOrchestratorStub() {
  const setActiveProject = vi.fn();
  return {
    activeProject: null as string | null,
    setActiveProject,
    stub: {
      activeProject: null as string | null,
      setActiveProject,
    } as any,
  };
}

describe('/resume command', () => {
  beforeEach(() => clearProjects());

  it('prompts for a name if none is given and no active project', async () => {
    const { ctx, reply } = makeCtx();
    const orch = makeOrchestratorStub();

    await handleResume(ctx, orch.stub, undefined);
    expect(reply).toHaveBeenCalled();
    const call = reply.mock.calls[0]![0] as string;
    expect(call).toMatch(/Usage:/);
  });

  it('shows currently-active project if none passed but one is set', async () => {
    const { ctx, reply } = makeCtx();
    const orch = makeOrchestratorStub();
    orch.stub.activeProject = 'jake-fitness';

    await handleResume(ctx, orch.stub, undefined);
    const call = reply.mock.calls[0]![0] as string;
    expect(call).toMatch(/jake-fitness/);
    expect(call).toMatch(/Currently resumed/i);
  });

  it('clears the active project with --clear', async () => {
    const { ctx, reply } = makeCtx();
    const orch = makeOrchestratorStub();

    await handleResume(ctx, orch.stub, '--clear');
    expect(orch.setActiveProject).toHaveBeenCalledWith(null);
    expect(reply.mock.calls[0]![0]).toMatch(/cleared/i);
  });

  it('returns an error if project does not exist', async () => {
    const { ctx, reply } = makeCtx();
    const orch = makeOrchestratorStub();

    await handleResume(ctx, orch.stub, 'nonexistent-project');
    const call = reply.mock.calls[0]![0] as string;
    expect(call).toMatch(/No project/i);
  });

  it('sets active project and returns a resume brief for an existing project', async () => {
    upsertProject({ name: 'jake-fitness', displayName: 'Jake Fitness', path: '/tmp/jake-fitness' });
    recordProjectTask({ name: 'jake-fitness', title: 'Build landing page', success: true });
    appendJournalEntry({
      project: 'jake-fitness',
      kind: 'task',
      summary: '✓ Build landing page — 3/3 steps, 45s',
    });

    const { ctx, reply } = makeCtx();
    const orch = makeOrchestratorStub();

    await handleResume(ctx, orch.stub, 'jake-fitness');

    expect(orch.setActiveProject).toHaveBeenCalledWith('jake-fitness');
    const call = reply.mock.calls[0]![0] as string;
    expect(call).toMatch(/Resuming/);
    expect(call).toMatch(/Jake Fitness/);
    expect(call).toMatch(/Build landing page/);
    expect(call).toMatch(/Where you left off/);
  });

  it('includes blocker section when an error journal entry exists', async () => {
    upsertProject({ name: 'pufftracker', displayName: 'PuffTracker' });
    appendJournalEntry({
      project: 'pufftracker',
      kind: 'error',
      summary: 'Swift build failed: missing @MainActor annotation',
    });

    const { ctx, reply } = makeCtx();
    const orch = makeOrchestratorStub();

    await handleResume(ctx, orch.stub, 'pufftracker');

    const call = reply.mock.calls[0]![0] as string;
    expect(call).toMatch(/blocker/i);
    expect(call).toMatch(/Swift build failed/);
  });

  it('slugifies the name before lookup', async () => {
    upsertProject({ name: 'trading-bot' });

    const { ctx, reply } = makeCtx();
    const orch = makeOrchestratorStub();

    await handleResume(ctx, orch.stub, 'Trading Bot');

    expect(orch.setActiveProject).toHaveBeenCalledWith('trading-bot');
    const call = reply.mock.calls[0]![0] as string;
    expect(call).toMatch(/Resuming/);
  });
});
