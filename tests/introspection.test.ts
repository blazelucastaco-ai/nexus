import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { events } from '../src/core/events.js';
import { startIntrospection, type IntrospectionHandle } from '../src/brain/introspection.js';

describe('Introspection', () => {
  let handle: IntrospectionHandle;

  beforeEach(() => {
    events.clear();
    handle = startIntrospection();
  });

  afterEach(() => {
    for (const s of handle.subs) s.unsubscribe();
    events.clear();
  });

  it('starts in idle state', () => {
    expect(handle.getActivity().status).toBe('idle');
  });

  it('transitions to responding on message.received', () => {
    events.emit({ type: 'message.received', chatId: 'c1', text: 'hi', textLen: 2 });
    expect(handle.getActivity().status).toBe('responding');
  });

  it('transitions back to idle on message.completed', () => {
    events.emit({ type: 'message.received', chatId: 'c1', text: 'hi', textLen: 2 });
    events.emit({ type: 'message.completed', chatId: 'c1', durationMs: 500, responseLen: 20, toolCalls: 1 });
    expect(handle.getActivity().status).toBe('idle');
  });

  it('tracks task in progress', () => {
    events.emit({ type: 'task.started', title: 'Build landing page', planId: 'p1' });
    const a = handle.getActivity();
    expect(a.status).toBe('task');
    expect(a.currentTaskTitle).toBe('Build landing page');
  });

  it('clears currentTaskTitle on task.completed', () => {
    events.emit({ type: 'task.started', title: 'Build thing' });
    events.emit({
      type: 'task.completed',
      title: 'Build thing',
      success: true,
      durationMs: 1000,
      stepsCompleted: 3,
      totalSteps: 3,
      filesProduced: [],
    });
    expect(handle.getActivity().currentTaskTitle).toBeUndefined();
  });

  it('records recent tools with success/failure', () => {
    events.emit({ type: 'tool.executed', toolName: 'write_file', success: true, durationMs: 10, resultLen: 100 });
    events.emit({ type: 'tool.executed', toolName: 'run_terminal_command', success: false, durationMs: 200, resultLen: 50 });

    const snap = handle.getSnapshot();
    expect(snap.recentTools).toHaveLength(2);
    // Most-recent-first ordering
    expect(snap.recentTools[0]!.name).toBe('run_terminal_command');
    expect(snap.recentTools[0]!.success).toBe(false);
    expect(snap.recentTools[1]!.name).toBe('write_file');
    expect(snap.recentTools[1]!.success).toBe(true);
  });

  it('caps recent tools at window size', () => {
    for (let i = 0; i < 30; i++) {
      events.emit({ type: 'tool.executed', toolName: `t${i}`, success: true, durationMs: 1, resultLen: 1 });
    }
    expect(handle.getSnapshot().recentTools.length).toBeLessThanOrEqual(20);
  });

  it('infers currentProject from tool file paths', () => {
    events.emit({
      type: 'tool.executed',
      toolName: 'write_file',
      success: true,
      durationMs: 10,
      resultLen: 0,
      params: { path: '/Users/lucas/nexus-workspace/jake-fitness/index.html' },
    });
    expect(handle.getActivity().currentProject).toBe('jake-fitness');
  });

  it('tracks recent errors from tool.error and task.step.failed', () => {
    events.emit({ type: 'tool.error', toolName: 'write_file', error: 'EACCES permission denied' });
    events.emit({
      type: 'task.step.failed',
      planTitle: 'Build thing',
      stepId: 2,
      error: 'Network timeout',
      attempt: 1,
    });

    const errs = handle.getSnapshot().recentErrors;
    expect(errs.length).toBe(2);
    expect(errs[0]!.source).toBe('task');
    expect(errs[1]!.source).toBe('tool');
  });

  it('transitions to dreaming and back', () => {
    events.emit({ type: 'dream.started' });
    expect(handle.getActivity().status).toBe('dreaming');

    events.emit({
      type: 'dream.completed',
      consolidated: 0, decayed: 0, gcd: 0, reflections: 0, ideas: 0, durationMs: 10,
    });
    expect(handle.getActivity().status).toBe('idle');
  });

  it('compact line includes current status and idle seconds', () => {
    events.emit({ type: 'task.started', title: 'Refactor db layer' });
    const line = handle.getCompactLine();
    expect(line).toContain('status=task');
    expect(line).toContain('task=');
    expect(line).toContain('idle=');
  });

  it('narrative describes idle state', () => {
    const n = handle.getNarrative();
    expect(n).toMatch(/idle/i);
  });

  it('narrative names the current task when running', () => {
    events.emit({ type: 'task.started', title: 'Build the new dashboard' });
    const n = handle.getNarrative();
    expect(n).toContain('Build the new dashboard');
  });

  it('narrative includes recent tool summary', () => {
    events.emit({ type: 'tool.executed', toolName: 'write_file', success: true, durationMs: 10, resultLen: 10 });
    events.emit({ type: 'tool.executed', toolName: 'write_file', success: true, durationMs: 5, resultLen: 5 });
    events.emit({ type: 'tool.executed', toolName: 'read_file', success: true, durationMs: 2, resultLen: 3 });
    const n = handle.getNarrative();
    expect(n).toMatch(/write_file/);
    expect(n).toMatch(/×2|×3/);
  });

  it('includes projects touched in the last hour', () => {
    events.emit({
      type: 'tool.executed',
      toolName: 'write_file',
      success: true,
      durationMs: 1,
      resultLen: 1,
      params: { path: '/Users/lucas/nexus-workspace/pufftracker/App.swift' },
    });
    events.emit({
      type: 'tool.executed',
      toolName: 'write_file',
      success: true,
      durationMs: 1,
      resultLen: 1,
      params: { path: '/Users/lucas/nexus-workspace/jake-fitness/index.html' },
    });
    const snap = handle.getSnapshot();
    expect(snap.projectsTouched).toContain('pufftracker');
    expect(snap.projectsTouched).toContain('jake-fitness');
  });

  it('survives subscriber errors — bad events never throw', () => {
    expect(() => {
      events.emit({ type: 'tool.executed', toolName: '', success: true, durationMs: 0, resultLen: 0 });
    }).not.toThrow();
  });
});
