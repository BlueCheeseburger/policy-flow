// The app's shared state. Much smaller than Warroom's, because this app is one
// feature: a list of flows, whichever one is open, and the handful of things
// that cross component boundaries.

import { create } from 'zustand';
import { readSettings, writeSettings, type Settings } from '../platform/settings';

export type DebateEvent = 'policy';

export interface FlowMeta {
  id: string;
  name: string;
  event: DebateEvent;
  /** True once this flow is synced to the cloud under this browser identity. */
  cloud?: boolean;
  /** True when the flow is a live room — edits stream to everyone in it. */
  live?: boolean;
  /** Set when the flow arrived through someone else's share link. */
  shared?: boolean;
  /** The secret in this flow's share link. Owner-only; never for a shared flow. */
  shareToken?: string;
  /** ISO timestamp set at creation. */
  createdAt?: string;
  /** ISO timestamp of the last edit — bumped by FlowView's persist(). Drives
   * the home screen's default "last modified" sort. */
  updatedAt?: string;
  /** ISO timestamp of the last time this flow was opened. Drives the "last
   * viewed" sort option; unset for a flow that's never been opened. */
  viewedAt?: string;
  /** A short scratch note shown on the flow's card — opponent, round, judge,
   * whatever you'd otherwise forget between rounds. Lives on the card only. */
  notes?: string;
}

export type View =
  | { kind: 'home' }
  | { kind: 'flow'; flowId: string }
  | { kind: 'settings' };

export interface UndoToast {
  id: string;
  message: string;
  onUndo: () => void | Promise<void>;
}

interface AppState {
  view: View;
  setView: (v: View) => void;

  /** Policy only — kept as a field so the ported flow code reads the same. */
  event: DebateEvent;

  flowsIndex: FlowMeta[];
  setFlowsIndex: (idx: FlowMeta[]) => void;

  /** The hidden browser identity, once anonymous sign-in has resolved. */
  identityId: string | null;
  setIdentityId: (id: string | null) => void;

  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;

  undoToasts: UndoToast[];
  pushUndoToast: (message: string, onUndo: () => void | Promise<void>) => void;
  dismissUndoToast: (id: string) => void;
}

export const useApp = create<AppState>((set) => ({
  view: { kind: 'home' },
  setView: (view) => set({ view }),

  event: 'policy',

  flowsIndex: [],
  setFlowsIndex: (flowsIndex) => set({ flowsIndex }),

  identityId: null,
  setIdentityId: (identityId) => set({ identityId }),

  settings: readSettings(),
  updateSettings: (patch) => set({ settings: writeSettings(patch) }),

  undoToasts: [],
  pushUndoToast: (message, onUndo) => set((s) => ({
    undoToasts: [...s.undoToasts, { id: crypto.randomUUID(), message, onUndo }].slice(-3),
  })),
  dismissUndoToast: (id) => set((s) => ({ undoToasts: s.undoToasts.filter((t) => t.id !== id) })),
}));
