// Execution Approval Framework — approval gate that combines policy + allowlist
// Called before any terminal command to determine if it should run.

import { createLogger } from '../utils/logger.js';
import { classifyCommand, type RiskTier, type TierResult } from './approval-policy.js';
import { isAllowlisted } from './command-allowlist.js';

const log = createLogger('ApprovalGate');

export interface ApprovalDecision {
  allowed: boolean;
  tier: RiskTier;
  reason: string;
  requiresApproval: boolean;
  message?: string;   // User-facing message when blocked or approval needed
}

/**
 * Check whether a command is allowed to run.
 * - BLOCKED: always refused
 * - DANGEROUS: refused unless allowlisted; response includes approval note
 * - MODERATE: allowed with logging
 * - SAFE: allowed silently
 */
export async function checkApproval(command: string, confirmed = false): Promise<ApprovalDecision> {
  const classification: TierResult = classifyCommand(command);

  // Check allowlist first (overrides DANGEROUS tier)
  if (classification.tier === 'DANGEROUS') {
    const allowlisted = await isAllowlisted(command);
    if (allowlisted) {
      log.info({ command: command.slice(0, 80), tier: 'DANGEROUS' }, 'Command is allowlisted — bypassing approval');
      return { allowed: true, tier: 'DANGEROUS', reason: 'Allowlisted', requiresApproval: false };
    }
  }

  switch (classification.tier) {
    case 'BLOCKED':
      log.error({ command: command.slice(0, 80), reason: classification.reason }, 'Command BLOCKED');
      return {
        allowed: false,
        tier: 'BLOCKED',
        reason: classification.reason,
        requiresApproval: false,
        message: `🚫 Command blocked: ${classification.reason}\nThis command is permanently refused for safety.`,
      };

    case 'DANGEROUS':
      if (confirmed) {
        log.warn({ command: command.slice(0, 80) }, 'DANGEROUS command confirmed by user');
        return { allowed: true, tier: 'DANGEROUS', reason: classification.reason, requiresApproval: false };
      }
      log.warn({ command: command.slice(0, 80), reason: classification.reason }, 'DANGEROUS command requires approval');
      return {
        allowed: false,
        tier: 'DANGEROUS',
        reason: classification.reason,
        requiresApproval: true,
        message:
          `⚠️ [REQUIRES APPROVAL] This command is classified as DANGEROUS:\n\n\`${command}\`\n\n` +
          `Reason: ${classification.reason}\n\n` +
          `To proceed: re-run with confirmed=true, or add this command to ~/.nexus/allowlist.json`,
      };

    case 'MODERATE':
      log.info({ command: command.slice(0, 80), reason: classification.reason }, 'MODERATE command — allowed with logging');
      return { allowed: true, tier: 'MODERATE', reason: classification.reason, requiresApproval: false };

    case 'SAFE':
    default:
      return { allowed: true, tier: 'SAFE', reason: classification.reason, requiresApproval: false };
  }
}
