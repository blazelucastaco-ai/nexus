import type { Logger } from 'pino';
import type { AgentName, AgentCapability, AgentResult } from '../types.js';
import { createLogger } from '../utils/logger.js';
import { nowISO } from '../utils/helpers.js';

export abstract class BaseAgent {
  readonly name: AgentName;
  readonly description: string;
  readonly capabilities: AgentCapability[];
  protected log: Logger;

  constructor(name: AgentName, description: string, capabilities: AgentCapability[]) {
    this.name = name;
    this.description = description;
    this.capabilities = capabilities;
    this.log = createLogger(`agent:${name}`);
  }

  abstract execute(action: string, params: Record<string, unknown>): Promise<AgentResult>;

  protected createResult(
    success: boolean,
    data: unknown,
    error?: string,
    startTime?: number,
  ): AgentResult {
    const duration = startTime ? Date.now() - startTime : 0;
    return {
      agentName: this.name,
      success,
      data,
      ...(error ? { error } : {}),
      duration,
    };
  }

  hasCapability(action: string): boolean {
    return this.capabilities.some((c) => c.name === action);
  }
}
