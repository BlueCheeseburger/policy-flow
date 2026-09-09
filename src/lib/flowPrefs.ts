// Shared flow-editor preferences (Settings.tsx's "Flow" card) and the places
// that read them live: FlowView.tsx (new-flow creation, auto-fit, AI tab
// summaries) and GeminiPanel.tsx (the AI agent's "create a flow" tool). Kept in
// one place, same pattern as autoFlowTagStyle.ts, so the setting, its default,
// and its storage key never drift between the two.
//
// These are display/behavior PREFERENCES, not per-flow data — they only ever
// affect a flow at the moment it's created, or a live in-app behavior (auto-fit,
// AI summaries), never retroactively rewriting an existing flow's own saved
// zoom/variant/etc.

// Type-only imports: erased at compile time, so these can't create a real
// runtime circular dependency even though FlowView.tsx imports readFlowPrefs
// from this same module.
import type { PolicyVariant, PFOrder } from '../components/FlowView';

export interface FlowPrefs {
  /** Stock issues vs Advantage for a brand-new POLICY flow made with the plain
   * "+" button (Auto Flow ignores this — it infers its own layout per doc).
   * Defaults to 'advantage': nearly every modern policy aff is an advantage aff,
   * and a stock-issues flow is one click away from an advantage one via the
   * rename suggestion in FlowView (see STOCK_ISSUES / suggestStockIssues). */
  defaultVariant: PolicyVariant;
  /** Pro-first vs Con-first for a brand-new PF flow, same "+"-button-only scope
   * as defaultVariant above (Auto Flow infers its own speech order per doc). */
  defaultPfOrder: PFOrder;
  /** Zoom % a brand-new flow opens at, before "fill the window" or a manual
   * zoom ever runs. An existing flow keeps whatever zoom it was last saved at. */
  defaultZoom: number;
  /** Cell text size (px) a brand-new flow opens at. An existing flow keeps
   * whatever size it was last saved at — this never resizes one retroactively. */
  defaultFontSize: number;
  /** Columns continuously stretch/shrink to fill the window (sidebar collapse,
   * resize, chat panel toggle). Off = zoom only changes when you ask it to. */
  autoFitColumns: boolean;
  /** The tab hover tooltip generates a one-sentence AI summary of the argument
   * on that sheet the first time you hover it (see FlowView's
   * ensureSheetSummary). Off = tabs only ever show the free local tag preview —
   * no Warroom AI call, ever, from hovering. */
  aiTabSummaries: boolean;
}

export const FLOW_PREFS_KEY = 'warroom-flow-prefs';
export const FLOW_PREFS_CHANGED_EVENT = 'warroom-flow-prefs-changed';

export const FLOW_PREFS_DEFAULTS: FlowPrefs = {
  defaultVariant: 'advantage',
  defaultPfOrder: 'pro-first',
  defaultZoom: 100,
  defaultFontSize: 13,
  autoFitColumns: true,
  aiTabSummaries: true,
};

export function readFlowPrefs(): FlowPrefs {
  try {
    const raw = localStorage.getItem(FLOW_PREFS_KEY);
    if (!raw) return { ...FLOW_PREFS_DEFAULTS };
    const p = JSON.parse(raw);
    return {
      defaultVariant: p.defaultVariant === 'stock-issues' ? 'stock-issues' : 'advantage',
      defaultPfOrder: p.defaultPfOrder === 'con-first' ? 'con-first' : 'pro-first',
      defaultZoom: typeof p.defaultZoom === 'number' && p.defaultZoom >= 50 && p.defaultZoom <= 150
        ? p.defaultZoom : FLOW_PREFS_DEFAULTS.defaultZoom,
      defaultFontSize: typeof p.defaultFontSize === 'number' && p.defaultFontSize >= 10 && p.defaultFontSize <= 20
        ? p.defaultFontSize : FLOW_PREFS_DEFAULTS.defaultFontSize,
      autoFitColumns: typeof p.autoFitColumns === 'boolean' ? p.autoFitColumns : FLOW_PREFS_DEFAULTS.autoFitColumns,
      aiTabSummaries: typeof p.aiTabSummaries === 'boolean' ? p.aiTabSummaries : FLOW_PREFS_DEFAULTS.aiTabSummaries,
    };
  } catch {
    return { ...FLOW_PREFS_DEFAULTS };
  }
}

export function writeFlowPrefs(prefs: FlowPrefs): void {
  localStorage.setItem(FLOW_PREFS_KEY, JSON.stringify(prefs));
  window.dispatchEvent(new CustomEvent(FLOW_PREFS_CHANGED_EVENT));
}
