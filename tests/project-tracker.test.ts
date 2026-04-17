import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDatabase } from '../src/memory/database.js';
import { events } from '../src/core/events.js';
import { startProjectTracker } from '../src/brain/project-tracker.js';
import { getProject, listProjects, listJournalEntries } from '../src/data/projects-repository.js';

function clearTables(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM project_journal').run();
  db.prepare('DELETE FROM projects').run();
}

describe('ProjectTracker event subscribers', () => {
  let subs: { unsubscribe(): void }[] = [];

  beforeEach(() => {
    clearTables();
    events.clear();
    subs = startProjectTracker();
  });

  afterEach(() => {
    for (const s of subs) s.unsubscribe();
  });

  it('creates project and records task on task.completed', () => {
    events.emit({
      type: 'task.completed',
      title: 'Build Jake landing page',
      success: true,
      durationMs: 45_000,
      stepsCompleted: 3,
      totalSteps: 3,
      filesProduced: ['/Users/foo/nexus-workspace/jake-fitness/index.html', '/Users/foo/nexus-workspace/jake-fitness/styles.css'],
    });

    const p = getProject('jake-fitness');
    expect(p).not.toBeNull();
    expect(p!.task_count).toBe(1);
    expect(p!.last_task_title).toBe('Build Jake landing page');
    expect(p!.last_task_success).toBe(1);

    const journal = listJournalEntries('jake-fitness');
    expect(journal.length).toBeGreaterThan(0);
    expect(journal[0]?.kind).toBe('task');
    expect(journal[0]?.summary).toContain('Build Jake landing page');
  });

  it('attributes failed task with warning marker', () => {
    events.emit({
      type: 'task.completed',
      title: 'Deploy API',
      success: false,
      durationMs: 10_000,
      stepsCompleted: 2,
      totalSteps: 5,
      filesProduced: ['/Users/foo/nexus-workspace/my-api/config.yaml'],
    });

    const p = getProject('my-api');
    expect(p?.last_task_success).toBe(0);
    const journal = listJournalEntries('my-api');
    expect(journal[0]?.summary).toContain('✗');
  });

  it('does not create project when files are not in a workspace', () => {
    events.emit({
      type: 'task.completed',
      title: 'Save note',
      success: true,
      durationMs: 1000,
      stepsCompleted: 1,
      totalSteps: 1,
      filesProduced: ['/Users/foo/Desktop/note.txt'],
    });

    expect(listProjects()).toHaveLength(0);
  });

  it('infers project from write_file tool.executed events', () => {
    events.emit({
      type: 'tool.executed',
      toolName: 'write_file',
      success: true,
      durationMs: 50,
      resultLen: 100,
      params: { path: '/Users/foo/Projects/trading-bot/main.py', content: 'pass' },
    });

    const p = getProject('trading-bot');
    expect(p).not.toBeNull();
  });

  it('tracks step failures in journal', () => {
    // Need a project to exist first so the FK passes
    events.emit({
      type: 'task.completed',
      title: 'Init',
      success: true,
      durationMs: 1000,
      stepsCompleted: 1,
      totalSteps: 1,
      filesProduced: ['/Users/foo/nexus-workspace/my-proj/x.ts'],
    });

    // unknown-project error won't be stored (FK), but project's step failures will be
    events.emit({
      type: 'task.step.completed',
      planTitle: 'Build thing',
      stepId: 2,
      success: false,
      durationMs: 5000,
      filesWritten: ['/Users/foo/nexus-workspace/my-proj/partial.ts'],
    });

    const journal = listJournalEntries('my-proj');
    const stepEntry = journal.find((j) => j.summary.includes('Step 2'));
    expect(stepEntry).toBeDefined();
  });

  it('picks the project with the most files when paths span multiple projects', () => {
    events.emit({
      type: 'task.completed',
      title: 'Mixed task',
      success: true,
      durationMs: 1000,
      stepsCompleted: 1,
      totalSteps: 1,
      filesProduced: [
        '/Users/foo/nexus-workspace/alpha/a.ts',
        '/Users/foo/nexus-workspace/beta/b.ts',
        '/Users/foo/nexus-workspace/beta/c.ts',
        '/Users/foo/nexus-workspace/beta/d.ts',
      ],
    });

    // beta wins (3 files vs 1)
    const beta = getProject('beta');
    expect(beta?.task_count).toBe(1);
  });
});
