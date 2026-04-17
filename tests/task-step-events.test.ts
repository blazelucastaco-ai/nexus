import { describe, it, expect, beforeEach } from 'vitest';
import { events } from '../src/core/events.js';

/**
 * FIND-CMP-01: `task.step.started` / `task.step.completed` / `task.step.failed`
 * are declared in the event union and subscribed to by Introspection. This
 * test verifies the declarations are wired — that you CAN emit and receive
 * them through the bus. Actual task-runner integration is exercised by a
 * higher-level integration test (see `/ultra-test` queue).
 */

describe('task.step.* events plumbing', () => {
  beforeEach(() => events.clear());

  it('task.step.started round-trips', () => {
    let received: unknown = null;
    const sub = events.on('task.step.started', (e) => {
      received = e;
    });
    events.emit({
      type: 'task.step.started',
      planTitle: 'Test plan',
      stepId: 1,
      stepTitle: 'First step',
    });
    sub.unsubscribe();
    expect(received).toMatchObject({ stepId: 1, stepTitle: 'First step' });
  });

  it('task.step.completed round-trips with filesWritten', () => {
    let received: { filesWritten: string[]; success: boolean } | null = null;
    const sub = events.on('task.step.completed', (e) => {
      received = { filesWritten: e.filesWritten, success: e.success };
    });
    events.emit({
      type: 'task.step.completed',
      planTitle: 'P',
      stepId: 2,
      success: true,
      durationMs: 1234,
      filesWritten: ['a.ts', 'b.ts'],
    });
    sub.unsubscribe();
    expect(received).not.toBeNull();
    expect(received!.filesWritten).toEqual(['a.ts', 'b.ts']);
    expect(received!.success).toBe(true);
  });

  it('task.step.failed carries attempt number and error', () => {
    let received: { attempt: number; error: string } | null = null;
    const sub = events.on('task.step.failed', (e) => {
      received = { attempt: e.attempt, error: e.error };
    });
    events.emit({
      type: 'task.step.failed',
      planTitle: 'P',
      stepId: 3,
      error: 'boom',
      attempt: 2,
    });
    sub.unsubscribe();
    expect(received).toEqual({ attempt: 2, error: 'boom' });
  });
});
