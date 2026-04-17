// Session-load stage (factory).
//
// On the first message of a session, loads the last N messages from disk
// into the orchestrator's in-memory conversationHistory. On subsequent
// messages, no-op.
//
// This stage needs access to the orchestrator's conversationHistory and
// session-first-turn flag, so it's exposed as a factory that closes over
// those references.

import { loadSession } from '../session-store.js';
import { stage, type NamedStage, type MessageContext } from '../pipeline.js';
import type { AIMessage } from '../../types.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('SessionLoadStage');

export interface SessionLoadDeps {
  conversationHistory: AIMessage[];
  isFirstCallSoFar: () => boolean;
  markHistoryLoaded: () => void;
}

export function makeSessionLoadStage(deps: SessionLoadDeps): NamedStage {
  return stage('SessionLoad', (ctx: MessageContext) => {
    if (!deps.isFirstCallSoFar()) return;

    const persisted = loadSession(ctx.chatId, 10);
    const validRoles = new Set(['user', 'assistant', 'system', 'tool']);
    const validMessages = persisted.filter((m) => validRoles.has(m.role));

    if (validMessages.length > 0) {
      deps.conversationHistory.push(
        ...validMessages.map((m) => ({ role: m.role as AIMessage['role'], content: m.content })),
      );
      log.info(
        { chatId: ctx.chatId, loaded: validMessages.length, skipped: persisted.length - validMessages.length },
        'Loaded persisted session',
      );
    }

    deps.markHistoryLoaded();
  });
}
