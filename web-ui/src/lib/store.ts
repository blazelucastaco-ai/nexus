// Discrete UI state — a tiny external store consumed via useSyncExternalStore.
// (The orb amplitude and caption reveal do NOT live here; see signals.ts.)

import { useSyncExternalStore } from 'react';

export interface Card {
  id: number;
  kind: 'chart' | 'diagram' | 'panel' | 'projects';
  payload: Record<string, unknown>;
}
export interface FeedItem {
  id: number;
  kind: string;
  label: string;
  detail?: string;
  ok?: boolean;
}
export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'idea' | 'dream';
  text: string;
}
export interface Message {
  id: number;
  role: 'user' | 'nexus';
  text: string;
}
export interface UIState {
  connected: boolean;
  status: string;
  mood: number;
  messages: Message[];
  feed: FeedItem[];
  toasts: Toast[];
  cards: Card[];
  /** The current primary "stage" visual (from ui_show_visual), or null. The Stage
   *  renders it large + center, docks the orb, and builds it in as NEXUS narrates. */
  visual: Record<string, unknown> | null;
}

let state: UIState = {
  connected: false,
  status: '',
  mood: 0,
  messages: [],
  feed: [],
  toasts: [],
  cards: [],
  visual: null,
};

const listeners = new Set<() => void>();
let counter = 1;
const nextId = () => counter++;

function set(patch: Partial<UIState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const ui = {
  getSnapshot: (): UIState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },

  setConnected(v: boolean): void {
    if (v !== state.connected) set({ connected: v });
  },
  setStatus(s: string): void {
    if (s !== state.status) set({ status: s });
  },
  setMood(m: number): void {
    set({ mood: m });
  },
  addMessage(role: Message['role'], text: string): number {
    const id = nextId();
    set({ messages: [...state.messages, { id, role, text }].slice(-40) });
    return id;
  },
  addFeed(item: Omit<FeedItem, 'id'>): void {
    set({ feed: [{ id: nextId(), ...item }, ...state.feed].slice(0, 7) });
  },
  addToast(level: Toast['level'], text: string): void {
    const id = nextId();
    set({ toasts: [...state.toasts, { id, level, text }].slice(-4) });
    setTimeout(() => ui.removeToast(id), 9500);
  },
  removeToast(id: number): void {
    set({ toasts: state.toasts.filter((t) => t.id !== id) });
  },
  addCard(kind: Card['kind'], payload: Record<string, unknown>): void {
    set({ cards: [{ id: nextId(), kind, payload }, ...state.cards].slice(0, 6) });
  },
  removeCard(id: number): void {
    set({ cards: state.cards.filter((c) => c.id !== id) });
  },
  clearCards(): void {
    if (state.cards.length) set({ cards: [] });
  },
  setVisual(spec: Record<string, unknown>): void {
    set({ visual: spec });
  },
  clearVisual(): void {
    if (state.visual) set({ visual: null });
  },
};

export function useUI(): UIState {
  return useSyncExternalStore(ui.subscribe, ui.getSnapshot, ui.getSnapshot);
}
