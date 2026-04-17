import type { AgentName, AgentTask, AgentResult, AgentCapability } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { generateId, nowISO } from '../utils/helpers.js';
import { BaseAgent } from './base-agent.js';
import { VisionAgent } from './vision.js';
import { FileAgent } from './file.js';
import { BrowserAgent } from './browser.js';
import { TerminalAgent } from './terminal.js';
import { CodeAgent } from './code.js';
import { ResearchAgent } from './research.js';
import { SystemAgent } from './system.js';
import { CommsAgent } from './comms.js';
import { SchedulerAgent } from './scheduler.js';

const log = createLogger('AgentManager');

export class AgentManager {
  private agents: Map<AgentName, BaseAgent> = new Map();
  private taskHistory: AgentTask[] = [];
  private static readonly MAX_TASK_HISTORY = 500;

  constructor() {
    this.registerAll();
  }

  private recordTask(task: AgentTask): void {
    this.taskHistory.push(task);
    if (this.taskHistory.length > AgentManager.MAX_TASK_HISTORY) {
      this.taskHistory = this.taskHistory.slice(-AgentManager.MAX_TASK_HISTORY);
    }
  }

  private registerAll(): void {
    const agents: BaseAgent[] = [
      new VisionAgent(),
      new FileAgent(),
      new BrowserAgent(),
      new TerminalAgent(),
      new CodeAgent(),
      new ResearchAgent(),
      new SystemAgent(),
      new CommsAgent(),
      new SchedulerAgent(),
    ];

    for (const agent of agents) {
      this.agents.set(agent.name, agent);
      log.info({ agent: agent.name, capabilities: agent.capabilities.length }, 'Agent registered');
    }

    log.info({ totalAgents: this.agents.size }, 'All agents registered');
  }

  getAgent(name: AgentName): BaseAgent | undefined {
    return this.agents.get(name);
  }

  async executeTask(task: AgentTask): Promise<AgentResult> {
    const agent = this.agents.get(task.agentName);

    if (!agent) {
      const result: AgentResult = {
        agentName: task.agentName,
        success: false,
        data: null,
        error: `Agent not found: ${task.agentName}`,
        duration: 0,
      };
      task.status = 'failed';
      task.result = result;
      this.recordTask(task);
      return result;
    }

    if (!agent.hasCapability(task.action)) {
      const result: AgentResult = {
        agentName: task.agentName,
        success: false,
        data: null,
        error: `Agent "${task.agentName}" does not have capability: ${task.action}`,
        duration: 0,
      };
      task.status = 'failed';
      task.result = result;
      this.recordTask(task);
      return result;
    }

    task.status = 'running';
    log.info({ taskId: task.id, agent: task.agentName, action: task.action }, 'Executing task');

    try {
      const result = await agent.execute(task.action, task.params);
      task.status = result.success ? 'completed' : 'failed';
      task.result = result;
      this.recordTask(task);

      log.info(
        { taskId: task.id, success: result.success, duration: result.duration },
        'Task completed',
      );

      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const result: AgentResult = {
        agentName: task.agentName,
        success: false,
        data: null,
        error,
        duration: 0,
      };
      task.status = 'failed';
      task.result = result;
      this.recordTask(task);

      log.error({ taskId: task.id, error }, 'Task failed');
      return result;
    }
  }

  /** Create and execute a task in one call */
  async dispatch(agentName: AgentName, action: string, params: Record<string, unknown> = {}): Promise<AgentResult> {
    const task: AgentTask = {
      id: generateId(),
      agentName,
      action,
      params,
      status: 'pending',
      createdAt: nowISO(),
    };
    return this.executeTask(task);
  }

  listCapabilities(): Array<{ agent: AgentName; capabilities: AgentCapability[] }> {
    const result: Array<{ agent: AgentName; capabilities: AgentCapability[] }> = [];
    for (const [name, agent] of this.agents) {
      result.push({ agent: name, capabilities: agent.capabilities });
    }
    return result;
  }

  getAvailableAgents(): Array<{ name: AgentName; description: string; capabilities: string[] }> {
    const result: Array<{ name: AgentName; description: string; capabilities: string[] }> = [];
    for (const [, agent] of this.agents) {
      result.push({
        name: agent.name,
        description: agent.description,
        capabilities: agent.capabilities.map((c) => c.name),
      });
    }
    return result;
  }

  getTaskHistory(): AgentTask[] {
    return [...this.taskHistory];
  }

  /** Graceful shutdown — cleans up scheduler timers etc. */
  destroy(): void {
    const scheduler = this.agents.get('scheduler');
    if (scheduler && scheduler instanceof SchedulerAgent) {
      scheduler.destroy();
    }
    log.info('AgentManager destroyed');
  }
}

// Re-export everything
export { BaseAgent } from './base-agent.js';
export { VisionAgent } from './vision.js';
export { FileAgent } from './file.js';
export { BrowserAgent } from './browser.js';
export { TerminalAgent } from './terminal.js';
export { CodeAgent } from './code.js';
export { ResearchAgent } from './research.js';
export { SystemAgent } from './system.js';
export { CommsAgent } from './comms.js';
export { SchedulerAgent } from './scheduler.js';
