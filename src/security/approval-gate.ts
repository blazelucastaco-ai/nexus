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
 * - DANGEROUS: refused unless allowlisted. We INTENTIONALLY do NOT honor the
 *   LLM-provided `confirmed` flag here — the LLM controls its own tool args,
 *   so trusting `confirmed=true` is equivalent to no gate at all (CRIT-3).
 *   The only legitimate bypass is the on-disk allowlist, which the user edits.
 * - MODERATE: allowed with logging
 * - SAFE: allowed silently
 *
 * The `confirmed` parameter is kept in the signature for backwards compatibility
 * but is now only consulted for historical-legacy paths; it has NO effect on
 * DANGEROUS commands.
 */
export async function checkApproval(command: string, _confirmed = false): Promise<ApprovalDecision> {
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
      log.warn({ command: command.slice(0, 80), reason: classification.reason }, 'DANGEROUS command refused (allowlist only)');
      return {
        allowed: false,
        tier: 'DANGEROUS',
        reason: classification.reason,
        requiresApproval: true,
        message:
          `⚠️ This command is classified as DANGEROUS and cannot be run automatically:\n\n\`${command}\`\n\n` +
          `Reason: ${classification.reason}\n\n` +
          `If the user explicitly wants to run this, they can either (a) run it manually in their own terminal, or (b) add an exact match or prefix to \`~/.nexus/allowlist.json\` and retry. You, the assistant, do NOT have a way to self-confirm this — please explain the risk to the user and wait for them to decide.`,
      };

    case 'MODERATE':
      log.info({ command: command.slice(0, 80), reason: classification.reason }, 'MODERATE command — allowed with logging');
      return { allowed: true, tier: 'MODERATE', reason: classification.reason, requiresApproval: false };

    case 'SAFE':
    default:
      return { allowed: true, tier: 'SAFE', reason: classification.reason, requiresApproval: false };
  }
}
