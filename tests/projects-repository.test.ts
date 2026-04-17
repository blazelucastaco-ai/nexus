import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../src/memory/database.js';
import {
  upsertProject,
  getProject,
  listProjects,
  archiveProject,
  unarchiveProject,
  recordProjectTask,
  appendJournalEntry,
  listJournalEntries,
  inferProjectFromPath,
  slugify,
} from '../src/data/projects-repository.js';

function clearTables(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM project_journal').run();
  db.prepare('DELETE FROM projects').run();
}

describe('ProjectsRepository', () => {
  beforeEach(() => {
    clearTables();
  });

  describe('upsertProject + getProject', () => {
    it('creates a project on first upsert', () => {
      upsertProject({ name: 'jake-fitness', displayName: 'Jake Fitness', path: '/tmp/jake-fitness' });
      const p = getProject('jake-fitness');
      expect(p).not.toBeNull();
      expect(p!.display_name).toBe('Jake Fitness');
      expect(p!.path).toBe('/tmp/jake-fitness');
      expect(p!.task_count).toBe(0);
      expect(p!.archived).toBe(0);
    });

    it('auto-humanizes display name when not provided', () => {
      upsertProject({ name: 'jake-fitness' });
      const p = getProject('jake-fitness');
      expect(p?.display_name).toBe('Jake Fitness');
    });

    it('updates last_active_at on second upsert', async () => {
      // Unique name so parallel test files' global DELETE FROM projects
      // doesn't nuke this row during the 1.1s wait below.
      const N = '__timing_test_last_active_at__';
      upsertProject({ name: N });
      const firstActive = getProject(N)!.last_active_at;
      await new Promise((r) => setTimeout(r, 1100)); // sqlite datetime() is second-resolution
      upsertProject({ name: N });
      const secondActive = getProject(N)!.last_active_at;
      expect(secondActive).not.toBe(firstActive);
    });

    it('preserves first_seen_at across upserts', async () => {
      const N = '__timing_test_first_seen_at__';
      upsertProject({ name: N });
      const firstSeen = getProject(N)!.first_seen_at;
      await new Promise((r) => setTimeout(r, 1100));
      upsertProject({ name: N });
      expect(getProject(N)!.first_seen_at).toBe(firstSeen);
    });

    it('returns null for missing project', () => {
      expect(getProject('ghost')).toBeNull();
    });
  });

  describe('listProjects', () => {
    it('returns empty array when no projects', () => {
      expect(listProjects()).toEqual([]);
    });

    it('orders by last_active_at DESC', async () => {
      upsertProject({ name: 'alpha' });
      await new Promise((r) => setTimeout(r, 1100));
      upsertProject({ name: 'beta' });

      const list = listProjects();
      expect(list[0]?.name).toBe('beta');
      expect(list[1]?.name).toBe('alpha');
    });

    it('excludes archived by default', () => {
      upsertProject({ name: 'a' });
      upsertProject({ name: 'b' });
      archiveProject('b');

      const list = listProjects();
      expect(list.map((p) => p.name)).toEqual(['a']);
    });

    it('includes archived when requested', () => {
      upsertProject({ name: 'a' });
      archiveProject('a');

      expect(listProjects({ includeArchived: true }).length).toBe(1);
    });
  });

  describe('archive / unarchive', () => {
    it('flips archived flag', () => {
      upsertProject({ name: 'x' });
      expect(archiveProject('x')).toBe(true);
      expect(getProject('x')?.archived).toBe(1);
      expect(unarchiveProject('x')).toBe(true);
      expect(getProject('x')?.archived).toBe(0);
    });

    it('returns false on missing project', () => {
      expect(archiveProject('ghost')).toBe(false);
    });
  });

  describe('recordProjectTask', () => {
    it('increments task_count and stores last_task fields', () => {
      upsertProject({ name: 'x' });
      recordProjectTask({ name: 'x', title: 'Build login page', success: true });
      recordProjectTask({ name: 'x', title: 'Add OAuth', success: false });

      const p = getProject('x')!;
      expect(p.task_count).toBe(2);
      expect(p.last_task_title).toBe('Add OAuth');
      expect(p.last_task_success).toBe(0);
    });
  });

  describe('journal', () => {
    it('appends + lists entries', () => {
      upsertProject({ name: 'x' });
      appendJournalEntry({ project: 'x', kind: 'task', summary: 'Started something' });
      appendJournalEntry({ project: 'x', kind: 'error', summary: 'Hit a wall' });

      const entries = listJournalEntries('x');
      expect(entries).toHaveLength(2);
      expect(entries[0]?.kind).toBe('error'); // DESC order
      expect(entries[1]?.kind).toBe('task');
    });

    it('stores metadata as JSON', () => {
      upsertProject({ name: 'x' });
      appendJournalEntry({
        project: 'x',
        kind: 'task',
        summary: 'Done',
        metadata: { files: ['a.ts', 'b.ts'], durationMs: 1500 },
      });
      const entries = listJournalEntries('x');
      const meta = JSON.parse(entries[0]!.metadata);
      expect(meta.files).toEqual(['a.ts', 'b.ts']);
      expect(meta.durationMs).toBe(1500);
    });

    it('silently skips when project does not exist', () => {
      // Should not throw — FK failure is caught inside
      expect(() => {
        appendJournalEntry({ project: 'nonexistent', kind: 'task', summary: 'x' });
      }).not.toThrow();
    });

    it('respects limit', () => {
      upsertProject({ name: 'x' });
      for (let i = 0; i < 10; i++) {
        appendJournalEntry({ project: 'x', kind: 'task', summary: `t${i}` });
      }
      expect(listJournalEntries('x', 3)).toHaveLength(3);
    });
  });

  describe('inferProjectFromPath', () => {
    it('extracts from ~/nexus-workspace/<name>/...', () => {
      const result = inferProjectFromPath('/Users/foo/nexus-workspace/jake-fitness/src/app.ts');
      expect(result?.name).toBe('jake-fitness');
      expect(result?.dir).toContain('jake-fitness');
    });

    it('extracts from Projects/<name>/...', () => {
      const result = inferProjectFromPath('/Users/foo/Projects/pufftracker/ios/App.swift');
      expect(result?.name).toBe('pufftracker');
    });

    it('slugifies names with spaces or underscores', () => {
      const result = inferProjectFromPath('/Users/foo/workspace/My_Cool_App/main.py');
      expect(result?.name).toBe('my-cool-app');
    });

    it('returns null for paths not matching any pattern', () => {
      expect(inferProjectFromPath('/Users/foo/Desktop/note.txt')).toBeNull();
      expect(inferProjectFromPath('/tmp/file')).toBeNull();
    });
  });

  describe('slugify', () => {
    it('lowercases + hyphenates', () => {
      expect(slugify('Jake Fitness')).toBe('jake-fitness');
      expect(slugify('MyCoolApp')).toBe('mycoolapp');
      expect(slugify('my_cool_app')).toBe('my-cool-app');
    });

    it('strips unsafe chars', () => {
      expect(slugify('foo/bar&baz')).toBe('foo-bar-baz');
    });

    it('returns "project" for empty-ish input', () => {
      expect(slugify('---')).toBe('project');
      expect(slugify('')).toBe('project');
    });
  });
});
