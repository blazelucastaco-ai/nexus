import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentResult } from '../types.js';
import { BaseAgent } from './base-agent.js';
import { generateId, nowISO } from '../utils/helpers.js';

const execFileAsync = promisify(execFile);

interface ScheduledMessage {
  id: string;
  to: string;
  subject: string;
  body: string;
  scheduledFor: string;
  createdAt: string;
  status: 'pending' | 'sent' | 'cancelled';
  timer?: ReturnType<typeof setTimeout>;
}

export class CommsAgent extends BaseAgent {
  private scheduledMessages: Map<string, ScheduledMessage> = new Map();

  constructor() {
    super('comms', 'Sends notifications, drafts messages, and schedules messages for later delivery', [
      { name: 'send_notification', description: 'Send a macOS notification via osascript' },
      { name: 'draft_message', description: 'Draft a formatted message for review' },
      { name: 'schedule_message', description: 'Schedule a message for later delivery' },
    ]);
  }

  async execute(action: string, params: Record<string, unknown>): Promise<AgentResult> {
    const start = Date.now();
    this.log.info({ action, params }, 'CommsAgent executing');

    try {
      switch (action) {
        case 'send_notification':
          return await this.sendNotification(params, start);
        case 'draft_message':
          return this.draftMessage(params, start);
        case 'schedule_message':
          return this.scheduleMessage(params, start);
        default:
          return this.createResult(false, null, `Unknown action: ${action}`, start);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ action, error: msg }, 'CommsAgent failed');
      return this.createResult(false, null, msg, start);
    }
  }

  private async sendNotification(params: Record<string, unknown>, start: number): Promise<AgentResult> {
    const title = String(params.title ?? 'NEXUS');
    const message = String(params.message);
    const subtitle = params.subtitle ? String(params.subtitle) : undefined;
    const sound = String(params.sound ?? 'default');

    // Escape for AppleScript: backslashes first, then double quotes
    const escAS = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escTitle = escAS(title);
    const escMessage = escAS(message);

    let script = `display notification "${escMessage}" with title "${escTitle}"`;
    if (subtitle) {
      script += ` subtitle "${escAS(subtitle)}"`;
    }
    if (sound !== 'none') {
      script += ` sound name "${sound}"`;
    }

    await execFileAsync('osascript', ['-e', script], { timeout: 5_000 });

    this.log.info({ title, message }, 'Notification sent');
    return this.createResult(
      true,
      { title, message, subtitle, sound, sentAt: nowISO() },
      undefined,
      start,
    );
  }

  private draftMessage(params: Record<string, unknown>, start: number): AgentResult {
    const to = String(params.to ?? 'unspecified');
    const subject = String(params.subject ?? '');
    const body = String(params.body ?? '');
    const format = String(params.format ?? 'email');
    const tone = String(params.tone ?? 'professional');

    const toneGuides: Record<string, string> = {
      professional: 'Clear, direct, and polite. No slang or overly casual language.',
      casual: 'Friendly and conversational. Contractions are fine.',
      formal: 'Highly formal. Use proper titles, full words, structured paragraphs.',
      urgent: 'Get to the point immediately. Action required clearly stated.',
      friendly: 'Warm and personable. Show genuine interest.',
    };

    const templates: Record<string, string> = {
      email: [
        `To: ${to}`,
        `Subject: ${subject}`,
        '',
        body || `[Compose your ${tone} message here]`,
        '',
        'Best regards,',
        'Lucas',
      ].join('\n'),
      slack: [
        body || `[Compose your ${tone} Slack message here]`,
      ].join('\n'),
      text: [
        body || `[Compose your ${tone} text message here]`,
      ].join('\n'),
    };

    const draft = {
      id: generateId(),
      to,
      subject,
      format,
      tone,
      toneGuide: toneGuides[tone] ?? toneGuides.professional,
      draft: templates[format] ?? templates.email,
      createdAt: nowISO(),
    };

    return this.createResult(true, draft, undefined, start);
  }

  private scheduleMessage(params: Record<string, unknown>, start: number): AgentResult {
    const to = String(params.to ?? 'unspecified');
    const subject = String(params.subject ?? '');
    const body = String(params.body ?? '');
    const scheduledFor = String(params.scheduledFor ?? params.time ?? '');

    if (!scheduledFor) {
      return this.createResult(false, null, 'scheduledFor time is required', start);
    }

    const scheduledDate = new Date(scheduledFor);
    const now = new Date();
    const delayMs = scheduledDate.getTime() - now.getTime();

    if (delayMs < 0) {
      return this.createResult(false, null, 'Scheduled time is in the past', start);
    }

    const id = generateId();
    const message: ScheduledMessage = {
      id,
      to,
      subject,
      body,
      scheduledFor,
      createdAt: nowISO(),
      status: 'pending',
    };

    // Set timer to send notification when time arrives
    message.timer = setTimeout(async () => {
      const stored = this.scheduledMessages.get(id);
      if (stored && stored.status === 'pending') {
        stored.status = 'sent';
        try {
          await this.sendNotification(
            {
              title: `Scheduled: ${subject || 'Message'}`,
              message: `To: ${to}\n${body}`,
              subtitle: `Scheduled delivery`,
            },
            Date.now(),
          );
          this.log.info({ id, to }, 'Scheduled message delivered');
        } catch (err) {
          this.log.error({ id, error: err }, 'Failed to deliver scheduled message');
        }
      }
    }, delayMs);

    this.scheduledMessages.set(id, message);

    this.log.info({ id, to, scheduledFor, delayMs }, 'Message scheduled');
    return this.createResult(
      true,
      {
        id,
        to,
        subject,
        scheduledFor,
        delayMinutes: (delayMs / 60_000).toFixed(1),
        status: 'pending',
        createdAt: nowISO(),
      },
      undefined,
      start,
    );
  }

  /** Clear all pending scheduled-message timers on shutdown. */
  destroy(): void {
    for (const msg of this.scheduledMessages.values()) {
      if (msg.timer) clearTimeout(msg.timer);
    }
    this.scheduledMessages.clear();
  }
}
