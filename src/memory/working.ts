// Nexus AI — Working memory (task state management)

import type { AgentTask } from '../types.js';
import { generateId, nowISO } from '../utils/helpers.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('WorkingMemory');

export class WorkingMemory {
  private tasks: Map<string, AgentTask> = new Map();

  constructor() {
    log.info('Working memory initialized');
  }

  /** Add a new task, returns its generated ID. */
  addTask(task: Partial<AgentTask>): string {
    const id = task.id ?? generateId();
    const now = nowISO();

    const full: AgentTask = {
      id,
      agentName: task.agentName ?? 'system',
      action: task.action ?? '',
      params: task.params ?? {},
      status: task.status ?? 'pending',
      result: task.result,
      createdAt: task.createdAt ?? now,
    };

    this.tasks.set(id, full);
    log.debug({ taskId: id, action: full.action }, 'Task added');
    return id;
  }

  /** Update fields on an existing task. */
  updateTask(id: string, updates: Partial<AgentTask>): void {
    const existing = this.tasks.get(id);
    if (!existing) throw new Error(`Task not found: ${id}`);

    this.tasks.set(id, {
      ...existing,
      ...updates,
      id, // never overwrite the ID
    });
    log.debug({ taskId: id, status: updates.status }, 'Task updated');
  }

  /** Get all tasks with status 'pending' or 'running'. */
  getActiveTasks(): AgentTask[] {
    return [...this.tasks.values()].filter(
      (t) => t.status === 'pending' || t.status === 'running',
    );
  }

  /** Get tasks that are pending (awaiting dispatch). */
  getPendingDecisions(): AgentTask[] {
    return [...this.tasks.values()].filter((t) => t.status === 'pending');
  }

  /** Format current task state for LLM context injection. */
  getTaskContext(): string {
    const active = this.getActiveTasks();
    if (active.length === 0) return '[No active tasks]';

    return active
      .map((t) => {
        return `- [${t.status.toUpperCase()}] ${t.action} (agent: ${t.agentName})`;
      })
      .join('\n');
  }

  /** Remove a task by ID. */
  removeTask(id: string): void {
    this.tasks.delete(id);
  }

  /** Get a single task by ID. */
  getTask(id: string): AgentTask | undefined {
    return this.tasks.get(id);
  }

  get size(): number {
    return this.tasks.size;
  }
}
