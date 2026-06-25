// Wire protocol — mirror of the daemon's src/web/protocol.ts. Kept as a small
// hand-synced copy because the frontend is a separate package.

export type OrbState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'tool'
  | 'task'
  | 'dreaming'
  | 'alert';

export type ServerFrame =
  | { t: 'hello'; chatId: string; version: string; serverTime: number; wakeWord?: boolean; bootId?: string }
  | { t: 'wake' }
  | { t: 'user_echo'; text: string }
  | { t: 'orb'; state: OrbState; intensity?: number; hue?: number; ttlMs?: number }
  | { t: 'status'; text: string }
  | { t: 'token'; delta: string }
  | { t: 'assistant'; text: string; final: boolean }
  | { t: 'audio'; url: string; text: string; queue?: boolean }
  | { t: 'activity'; kind: string; label: string; detail?: string; ok?: boolean }
  | { t: 'ui'; kind: string; payload: Record<string, unknown> }
  | { t: 'notice'; level: 'info' | 'warn' | 'idea' | 'dream'; text: string }
  | { t: 'heartbeat'; mood: number; uptimeSec: number; memoryCount: number }
  | { t: 'pong' };

export type ClientFrame =
  | { t: 'user_message'; text: string }
  | { t: 'listening'; on: boolean }
  | { t: 'ping' };
