import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { useApp, FlowMeta } from '../store/appStore';
import SharePanel from './SharePanel';
import { createFlowSync, FlowSyncHandle, RemoteCursor, PresenceUser, FlowSyncStatus } from '../lib/flowSync';
import { isShortcutDisabled, matchesShortcut } from '../lib/shortcutPrefs';
import {
  seedDoc, docToData, cellText, setYText, metaMap, sheetsArr, sheetCells, findSheet,
  u8ToB64, LOCAL_ORIGIN, REMOTE_ORIGIN, FlowDocData,
} from '../lib/flowDoc';
import {
  HILITE, HILITE_RGB, cellToHtml, htmlToText, cleanPastedHtml, sanitizeCellHtml, matchRangesIn,
  cellHasEmphasis, setCellEmphasis, Emphasis,
} from '../lib/cellHtml';
import {
  CellSelection, toggleCell, rangeTo, planMove, planDrop, applyMove, applyPaste,
  clearCells, selectionKeys, isSelected as selHas, cellKey as selCellKey,
} from '../lib/flowSelection';
import { flushCellsIntoSheets } from '../lib/flowCellFlush';
import { flowDataToXlsxBase64 } from '../utils/flowImport';
import { readKey, writeKey } from '../platform/storage';
import { saveBase64 } from '../platform/files';
import { summarizeFlowSheet } from '../platform/aiFeatures';
import { saveSnapshot as cloudSaveSnapshot } from '../platform/cloud';
import { cloudConfigured } from '../platform/supabase';
import { readSettings, SETTINGS_CHANGED_EVENT } from '../platform/settings';
import { readFlowPrefs, FLOW_PREFS_CHANGED_EVENT } from '../lib/flowPrefs';
import { planStockIssueConversion, StockIssuePlan } from '../lib/stockIssueSuggest';
import {
  wasAutoFlowed, summaryColumnFor, summaryEntries, summarySignature, SheetRole,
} from '../lib/flowTabSummary';
import { isFreeArrow, isCellArrow, toFraction, fromFraction, straightPath, bumpArrow, dropArrowsTouching } from '../lib/flowArrowGeo';
import Tooltip from './Tooltip';
import Logo from './Logo';

// Highlight-registry names for find hits (see the ::highlight() rules in index.css).
const FIND_HL = 'flow-find';
const FIND_HL_CURRENT = 'flow-find-current';

// True on macOS — used to show ⌘ vs Ctrl in tips and tooltips.
const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? navigator.userAgent);
const mod = isMac ? '⌘' : 'Ctrl';

// Stable per-user cursor color (hash the user id into a fixed palette).
const PRESENCE_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#0d9488'];
function colorForUser(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return PRESENCE_COLORS[Math.abs(h) % PRESENCE_COLORS.length];
}

// ─── Column definitions ───────────────────────────────────────────────────────

export const POLICY_COLS = ['1AC', '1NC', '2AC', '2NC/1NR', '1AR', '2NR', '2AR'];
export const PF_PRO_FIRST_COLS = ['Pro Case', 'Con Case', 'Con Rebuttal', 'Pro Rebuttal', 'Pro Summary', 'Con Summary', 'Pro FF', 'Con FF'];
export const PF_CON_FIRST_COLS = ['Con Case', 'Pro Case', 'Pro Rebuttal', 'Con Rebuttal', 'Con Summary', 'Pro Summary', 'Con FF', 'Pro FF'];

// Blue = aff/pro, green = neg/con
const POLICY_BLUE = new Set([0, 2, 4, 6]);
const PF_PRO_FIRST_BLUE = new Set([0, 3, 4, 6]);
const PF_CON_FIRST_BLUE = new Set([1, 2, 5, 7]);

// ─── Default sheet names ──────────────────────────────────────────────────────

export const SHEETS_STOCK_ISSUES = ['Inherency', 'Harms', 'Solvency', 'Off 1', 'Off 2', 'Off 3', 'Off 4'];
export const SHEETS_ADVANTAGE = ['Adv 1', 'Adv 2', 'Adv 3', 'Off 1', 'Off 2', 'Off 3', 'Off 4'];
export const SHEETS_PF = ['Contention 1', 'Contention 2', 'Turns', 'Off 1', 'Off 2'];

/**
 * How many rows a new flow starts with. Rows are growable per flow now (see
 * `numRows` on StoredFlowData), so this is only the starting point — never the
 * limit. Anything reasoning about an EXISTING flow must read that flow's own
 * count and fall back to this, because flows made before rows grew have no
 * field to read.
 */
export const DEFAULT_ROWS = 60;

/** @deprecated Prefer a flow's own `numRows`, falling back to DEFAULT_ROWS. */
export const NUM_ROWS = DEFAULT_ROWS;

/**
 * Ceiling on a single flow's rows. Every row renders its own cells for all
 * seven columns, so this is a rendering budget, not a data one — and it also
 * bounds what a corrupt or hand-edited stored count can ask the grid to draw.
 */
export const MAX_ROWS = 5000;
const DEFAULT_COL_WIDTH = 185;
const DEFAULT_FONT_SIZE = 13;

// ─── Types ────────────────────────────────────────────────────────────────────

export type PolicyVariant = 'stock-issues' | 'advantage';
export type PFOrder = 'pro-first' | 'con-first';

export interface FlowArrow {
  id: string;
  /** Cell-anchored ("ri-ci") — Auto Flow's arrows, and anything drawn before
   *  free-form endpoints existed. Follows its cells when a row is inserted. */
  from?: string;
  to?: string;
  /** Free-form endpoints, as FRACTIONS of the grid content box. A hand-drawn
   *  arrow lands exactly where it was clicked and snaps to nothing — see
   *  src/lib/flowArrowGeo.ts for why fractions rather than pixels. */
  fx1?: number; fy1?: number;
  fx2?: number; fy2?: number;
}

export interface SheetData {
  id: string;
  name: string;
  cells: Record<string, string>;
  arrows?: FlowArrow[];
  // Cell keys ("ri-ci") whose content is an AI-generated summary (Auto Flow's
  // opt-in summary mode). No ring is drawn from this anymore (AI-generated
  // taglines never get one — see CLAUDE.md), but it's kept so a summarized
  // cell still knows to drop itself from this set once the user edits it (see
  // clearAiCell) — the content is theirs from that point on.
  aiCells?: string[];
  // Auto Flow's classification of this tab, stamped on every sheet it writes.
  // Its PRESENCE is what makes a tab eligible for an AI hover summary at all
  // (a hand-typed tab is already in the debater's own words), and its VALUE
  // picks which speech column that summary reads. See lib/flowTabSummary.ts.
  autoFlowRole?: SheetRole | null;
  // A one-sentence AI summary of the argument as a WHOLE on this tab, shown in
  // the tab's hover tooltip. Two ways this gets set: (1) folded for free from
  // Auto Flow's opt-in per-card summaries at write time (no extra API call —
  // see commitWrite in AutoFlow.tsx), or (2) generated lazily on hover by
  // ensureSheetSummary() below, the first time a tab with real content is
  // hovered after `aiSummarySource` goes stale. Either way this is a genuine
  // Warroom AI call — the tooltip marks it with ✨.
  aiSummary?: string;
  // Signature of the entries `aiSummary` was generated from (see
  // summarySignature in lib/flowTabSummary.ts) — compared against the sheet's
  // current content to decide whether the cached summary is still valid.
  // Covers only the ONE column the summary reads, so answers typed into a later
  // speech don't invalidate a summary they couldn't have changed.
  aiSummarySource?: string;
}

// Exported so features that write into a flow from outside the editor (Auto
// Flow) can build/read this shape without redefining it. Cell keys are
// "ri-ci" (row index-col index); values are HTML strings (see lib/cellHtml.ts
// for what's allowed in them — plain text is also accepted and upgraded).
export interface StoredFlowData {
  event: 'policy' | 'pf';
  variant: PolicyVariant;
  pfOrder: PFOrder;
  sheets: SheetData[];
  columnWidths: number[];
  customColumns: string[] | null;
  columnColors?: (string | null)[];
  fontSize: number;
  zoom: number;
  // How many rows this flow has. Absent on every flow made before rows became
  // growable, which is why every read falls back to DEFAULT_ROWS rather than
  // trusting the field to be there.
  numRows?: number;
  // Which tab was open, so reopening the flow (or relaunching the app) lands
  // back where you left off — see the session-restore work. Distinct from
  // FlowSnapshot below (the undo stack), which deliberately excludes this:
  // undo is about document content, not which tab you're looking at.
  activeSheetIdx?: number;
}

// An undo step. Deliberately holds no active-sheet index: which tab is open is
// navigation, not part of the document, and restoring it would move the user.
interface FlowSnapshot {
  sheets: SheetData[];
  columnColors: (string | null)[];
  customColumns: string[] | null;
  columnWidths: number[];
  variant: PolicyVariant;
  pfOrder: PFOrder;
  event: 'policy' | 'pf';
  // Row count is part of the document: adding rows is undoable, and undoing
  // back past the addition must not leave cells stranded below the new end.
  numRows: number;
}

const COLOR_SWATCHES = ['#2563eb', '#16a34a', '#dc2626', '#d97706', '#9333ea', '#0891b2', '#db2777', '#475569'];

// Cell values are stored as HTML (to support bold/italic/underline/strikethrough
// and highlight). Legacy plain-text values (and AI-written plain text) are
// upgraded on render. The sanitizer and clipboard cleaning live in lib/cellHtml.

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = (hex || '').replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h || '000000', 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSheets(event: 'policy' | 'pf', variant: PolicyVariant): SheetData[] {
  const names = event === 'pf' ? SHEETS_PF : (variant === 'advantage' ? SHEETS_ADVANTAGE : SHEETS_STOCK_ISSUES);
  return names.map((name) => ({ id: crypto.randomUUID(), name, cells: {} }));
}

// Heal a sheet list at READ time (see CLAUDE.md, "Fixing a bad write must also
// heal what's already saved"): every sheet gets an id, a `cells` object and an
// `arrows` array, and `cells` is a fresh copy so the live edit buffer can never
// alias an object that also sits inside React state / an undo snapshot. A sheet
// written without `cells` (older Auto Flow runs, an external writer) used to
// crash the tab tooltip and Find with "Object.entries(undefined)".
function normalizeSheets(list: SheetData[] | undefined | null): SheetData[] {
  return (list ?? [])
    .filter((sh) => sh && typeof sh === 'object')
    .map((sh) => ({
      ...sh,
      id: typeof sh.id === 'string' && sh.id ? sh.id : crypto.randomUUID(),
      name: typeof sh.name === 'string' ? sh.name : 'Sheet',
      cells: { ...(sh.cells && typeof sh.cells === 'object' ? sh.cells : {}) },
      arrows: Array.isArray(sh.arrows) ? sh.arrows : [],
    }));
}

export function makeDefaultData(event: 'policy' | 'pf', variant: PolicyVariant, pfOrder: PFOrder): StoredFlowData {
  const cols = event === 'policy' ? POLICY_COLS : (pfOrder === 'pro-first' ? PF_PRO_FIRST_COLS : PF_CON_FIRST_COLS);
  return {
    event, variant, pfOrder,
    sheets: makeSheets(event, variant),
    columnWidths: cols.map(() => DEFAULT_COL_WIDTH),
    customColumns: null,
    fontSize: DEFAULT_FONT_SIZE,
    zoom: 100,
  };
}

function useDarkMode() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    obs.observe(document.documentElement, { attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

function colBg(color: string, isDark: boolean, isHeader: boolean): string {
  const { r, g, b } = hexToRgb(color);
  const pct = isDark ? 34 : 30;
  // The column header is STICKY, so the grid scrolls underneath it. A tint with
  // an alpha channel let that text show through the header — taglines sliding
  // behind the speech name, which is unreadable and looks broken. Mix the same
  // tint against the grid's own background instead: identical color, no alpha,
  // nothing bleeds through. (Data cells keep the alpha — nothing scrolls under
  // them, and it lets the arrow overlay read against any column color.)
  if (isHeader) return `color-mix(in srgb, rgb(${r},${g},${b}) ${pct}%, var(--bg-main))`;
  return `rgba(${r},${g},${b},0.12)`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function FlowView() {
  const { view, setView, event, flowsIndex, setFlowsIndex, identityId, pushUndoToast } = useApp();
  const flowId = view.kind === 'flow' ? (view as any).flowId : undefined;
  const flowMeta: FlowMeta | undefined = flowsIndex.find((f) => f.id === flowId);
  const dark = useDarkMode();

  // ── Core state ────────────────────────────────────────────────────────────

  const [loaded, setLoaded] = useState(false);
  // Bumped to force a full reload from storage (e.g. after Warroom AI edits a cell)
  const [reloadNonce, setReloadNonce] = useState(0);
  // Bumped to remount cell DOM from cellsRef WITHOUT re-reading storage (undo/redo)
  const [cellNonce, setCellNonce] = useState(0);
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);

  // Cancel an in-progress arrow draw whenever the active sheet changes. An
  // endpoint is a position on THIS sheet — the same fraction of the content box
  // on another tab lands next to a completely different argument — so a draw
  // started here and finished after a tab switch would put the arrow somewhere
  // the user never pointed at. The hover state goes too: it names an arrow on
  // the sheet we just left.
  // The selection goes too — its rows name cells on the sheet we just left.
  // (A cross-tab drag re-creates it at the drop, after this has run.)
  useEffect(() => { cancelDrawMode(); setHoveredArrow(null); clearSelection(); }, [activeSheetIdx]); // eslint-disable-line react-hooks/exhaustive-deps
  const [columnWidths, setColumnWidths] = useState<number[]>([]);
  const [customColumns, setCustomColumns] = useState<string[] | null>(null);
  const [columnColors, setColumnColors] = useState<(string | null)[]>([]);
  const [fontSize, setFontSize] = useState(() => readFlowPrefs().defaultFontSize);
  // Density and typeface are global settings, applied live to whatever flow is
  // open — there is no per-flow control for them any more.
  const [rowHeight, setRowHeight] = useState(() => readFlowPrefs().rowHeight);
  const [cellFont, setCellFont] = useState(() => readFlowPrefs().cellFont);
  useEffect(() => {
    function onPrefs() {
      const p = readFlowPrefs();
      setFontSize(p.defaultFontSize);
      setRowHeight(p.rowHeight);
      setCellFont(p.cellFont);
    }
    window.addEventListener(FLOW_PREFS_CHANGED_EVENT, onPrefs);
    return () => window.removeEventListener(FLOW_PREFS_CHANGED_EVENT, onPrefs);
  }, []);
  const [zoom, setZoom] = useState(100);
  const [variant, setVariant] = useState<PolicyVariant>('stock-issues');
  const [pfOrder, setPfOrder] = useState<PFOrder>('pro-first');
  const [numRows, setNumRows] = useState<number>(DEFAULT_ROWS);
  // What the "add rows" field is set to. Google Sheets defaults this to 100 and
  // debaters coming from it expect the same number sitting there.
  const [addRowsCount, setAddRowsCount] = useState('100');
  const [tipDismissed, setTipDismissed] = useState(
    () => localStorage.getItem('pf-tips-dismissed') === '1'
  );

  // Default side colors, straight from Settings. These used to be read from
  // two standalone localStorage keys that nothing in this app ever wrote — a
  // leftover from the desktop port — so the Settings pickers changed a value
  // the grid never looked at.
  const [affColor, setAffColor] = useState(() => readSettings().affColor);
  const [negColor, setNegColor] = useState(() => readSettings().negColor);

  // Find
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatches, setFindMatches] = useState<{ sheetIdx: number; key: string }[]>([]);
  const [findIdx, setFindIdx] = useState(0);

  // Tab drag-to-reorder
  const [dragTabIdx, setDragTabIdx] = useState<number | null>(null);
  const [dropTabIdx, setDropTabIdx] = useState<number | null>(null);

  // Arrow draw mode
  const [drawMode, setDrawMode] = useState(false);
  // Mirror for the window keydown handler, which must toggle against the value
  // that is true NOW rather than the one its closure was built with. ⌘L used to
  // be handled twice — once by the focused cell, once by the window listener —
  // and the second copy toggled off what the first had just switched on.
  const drawModeRef = useRef(false);
  // Which emphasis is on at the caret, for lighting up the toolbar buttons.
  const [fmt, setFmt] = useState({ bold: false, italic: false, underline: false, strike: false, highlight: false });

  // ── Multi-cell selection ──────────────────────────────────────────────────
  // ⌘-click builds a group of cells within ONE column (see lib/flowSelection.ts
  // for why one column). The group can then be moved with ⌘-arrows or dragged,
  // formatted as a unit, or cleared.
  const [selection, setSelection] = useState<CellSelection | null>(null);
  const selectionRef = useRef<CellSelection | null>(null);
  useLayoutEffect(() => { selectionRef.current = selection; });
  // Where a shift-click range starts from.
  const selAnchor = useRef<{ row: number; col: number } | null>(null);
  // The toolbar describes the selection while there is one, so it has to be
  // recomputed when the group changes — no caret moves, so `selectionchange`
  // never fires for this.
  useEffect(() => { refreshFormatState(); }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps
  // A drag in progress (or about to be — `moved` flips once the pointer has
  // travelled far enough that this is a drag and not a click).
  const drag = useRef<{
    originSheetId: string; col: number; rows: number[]; grabRow: number;
    payload: string[]; startX: number; startY: number; moved: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dropAt, setDropAt] = useState<CellSelection | null>(null);
  const [dropTab, setDropTab] = useState<number | null>(null);
  // Hovering a tab mid-drag opens it after a beat, so a group can be carried to
  // another sheet without letting go.
  const tabHover = useRef<{ idx: number; timer: ReturnType<typeof setTimeout> } | null>(null);

  function clearSelection() {
    setSelection(null);
    selectionRef.current = null;
    selAnchor.current = null;
  }
  // Free-form draw: the first clicked point (fractions of the content box) and
  // where the cursor is now, for the rubber-band preview.
  const [drawStart, setDrawStart] = useState<{ fx: number; fy: number } | null>(null);
  const [drawCursor, setDrawCursor] = useState<{ x: number; y: number } | null>(null);
  const [arrowGeo, setArrowGeo] = useState<{ id: string; d: string; mx: number; my: number }[]>([]);
  const [hoveredArrow, setHoveredArrow] = useState<string | null>(null);

  // ── UI state ──────────────────────────────────────────────────────────────

  const [renamingCol, setRenamingCol] = useState<number | null>(null);
  const [renamingSheet, setRenamingSheet] = useState<number | null>(null);
  // Dismissed once = quiet for the rest of this flow. "Solvency" is a legitimate
  // advantage-flow tab, so a false positive must cost one click, not a nag.
  const [stockIssueDismissed, setStockIssueDismissed] = useState(false);
  const skipNextRenameCommit = useRef(false);
  const [renamingFlow, setRenamingFlow] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [colMenu, setColMenu] = useState<number | null>(null);
  // Right-click menu on a sheet tab: which tab, and where to draw it.
  const [tabMenu, setTabMenu] = useState<{ idx: number; x: number; y: number } | null>(null);
  const [hoveredCell, setHoveredCell] = useState<{ ri: number; ci: number } | null>(null);
  const [hoveredGap, setHoveredGap] = useState<{ ri: number; ci: number } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  // ── Live collaboration ──────────────────────────────────────────────────────
  const [live, setLive] = useState(false);              // is this flow live-synced?
  const [liveReady, setLiveReady] = useState(false);    // sync handle attached
  const [liveStarting, setLiveStarting] = useState(false);
  const [remoteCursors, setRemoteCursors] = useState<RemoteCursor[]>([]);
  // Live-sync connection status — see flowSync.ts's FlowSyncStatus. Only
  // meaningful while `live` is true; the flow keeps working offline either
  // way, this just says whether edits are currently reaching teammates.
  const [syncStatus, setSyncStatus] = useState<FlowSyncStatus>('CONNECTING');
  const syncRef = useRef<FlowSyncHandle | null>(null);
  const liveRef = useRef(false);                          // mirror for callbacks
  const applyingRemote = useRef(false);                   // guard structural echo

  // ── Refs ──────────────────────────────────────────────────────────────────

  const cellsRef = useRef<Record<string, string>>({});
  // WHICH sheet `cellsRef.current` actually belongs to. `cellsRef` is the live,
  // unsaved buffer for the sheet being edited, and it used to be flushed back by
  // INDEX (`sheets[activeSheetIdx]`). That silently corrupted data: React state
  // (`activeSheetIdx`) and `snap.current` only resync in a post-render effect, so
  // any flush landing in that gap — an async AI-summary write, a debounced save,
  // anything after a tab switch or a drag-reorder that shifted indices — wrote
  // the CURRENT tab's cells into a DIFFERENT tab's slot. That's the "content
  // teleported between tabs" bug. Flushing by sheet id instead makes a mismatch
  // impossible to write: if the id isn't found, the buffer is simply not flushed.
  const cellsOwnerId = useRef<string | null>(null);
  // Cell keys edited since the last persist(). When an external writer (Warroom
  // AI, "send to flow" from a speech doc, Auto Flow) rewrites this flow's
  // storage and asks for a reload, these are the only keystrokes that exist
  // nowhere but in `cellsRef` — so they are carried across the reload and laid
  // over the freshly-read sheet instead of being thrown away with the buffer.
  const dirtyKeys = useRef<Set<string>>(new Set());
  // Set by onExternalEdit so the load effect knows this reload should keep the
  // dirty buffer (a flow SWITCH must not — the buffer belongs to another flow).
  const reloadKeepsBuffer = useRef(false);
  // Tab-summary backoff — see noteSummaryFailure. `summaryDisabled` kills the
  // feature for the session on a quota/auth failure; `summaryCooldown` backs off
  // one sheet at a time for anything else.
  const summaryDisabled = useRef(false);
  const summaryCooldown = useRef<Map<string, number>>(new Map());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Debounces the Team Files push (see pushToWatchedTeamFile below) — persist()
  // can fire on every keystroke via the autosave path, but re-exporting to
  // xlsx and hitting Supabase on every one of those would be wasteful.
  const cloudPushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cellEls = useRef<Record<string, HTMLDivElement | null>>({});
  const resizing = useRef<{ idx: number; startX: number; startW: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Scroll offset per sheet, keyed by sheet id (not index, so deleting or
  // reordering a sheet can't hand one tab another's position). Sheets share one
  // scroll container, so without this, switching tabs keeps wherever you were —
  // scroll to the middle of the Politics DA and the Case sheet opens mid-page.
  const sheetScroll = useRef<Record<string, { top: number; left: number }>>({});
  const gridContentRef = useRef<HTMLDivElement>(null);
  const flowNameInputRef = useRef<HTMLInputElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const focusedCell = useRef<string | null>(null);

  // Undo / redo — snapshots of editable flow state
  const history = useRef<FlowSnapshot[]>([]);
  const histIdx = useRef(-1);
  const restoring = useRef(false);
  // Mirrored to state so the Undo/Redo toolbar buttons can grey out when there's
  // nothing to undo/redo (the underlying counters are refs, which don't re-render).
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  function syncHistButtons() {
    setCanUndo(histIdx.current > 0);
    setCanRedo(histIdx.current < history.current.length - 1);
  }

  // Always-current snapshot for use in async/event callbacks.
  //
  // A LAYOUT effect, deliberately: it is declared before every other layout
  // effect in this component, so anything that reads `snap.current` during the
  // commit (recomputeArrows, scroll restore) sees the state that was just
  // rendered. As a plain useEffect it ran a beat later, and recomputeArrows —
  // fired by the tab switch — still read the OLD sheet's arrows and drew them
  // over the new tab's cells, where they sat until something else happened to
  // trigger a recompute. That was "arrows follow me between tabs".
  const snap = useRef({ sheets, columnWidths, customColumns, columnColors, fontSize, zoom, variant, pfOrder, activeSheetIdx, numRows, event: 'policy' as 'policy' | 'pf' });
  useLayoutEffect(() => { snap.current = { sheets, columnWidths, customColumns, columnColors, fontSize, zoom, variant, pfOrder, activeSheetIdx, numRows, event: flowEvent }; });

  // ── Derived ───────────────────────────────────────────────────────────────

  // This app is policy only. The PF branches below are the ported data model's
  // — inert here, kept because the grid, arrow and selection code is shared and
  // shaping around them would be a rewrite of well-tested code for no gain.
  const flowEvent: 'policy' | 'pf' = 'policy';
  const baseCols = flowEvent === 'policy'
    ? POLICY_COLS
    : (pfOrder === 'pro-first' ? PF_PRO_FIRST_COLS : PF_CON_FIRST_COLS);
  const blueCols = flowEvent === 'policy'
    ? POLICY_BLUE
    : (pfOrder === 'pro-first' ? PF_PRO_FIRST_BLUE : PF_CON_FIRST_BLUE);
  const columns = customColumns ?? baseCols;
  const activeSheet = sheets[activeSheetIdx] ?? sheets[0];

  // Effective base color for a column: explicit override, else the side default.
  function colColor(ci: number): string {
    const override = columnColors[ci];
    if (override) return override;
    return blueCols.has(ci) ? affColor : negColor;
  }

  // Zoom-adjusted display widths (stored widths are logical, unscaled)
  const effectiveWidths = columnWidths.map((w) => Math.round(w * zoom / 100));
  const effectiveFontSize = Math.max(8, Math.round(fontSize * zoom / 100));
  const totalWidth = effectiveWidths.reduce((a, b) => a + b, 0);
  const gridTemplate = effectiveWidths.map((w) => `${w}px`).join(' ');

  // Which cell (in the active sheet) each remote teammate is currently editing.
  const remoteCursorMap = new Map<string, RemoteCursor>();
  remoteCursors.forEach((c) => { if (c.cell) remoteCursorMap.set(c.cell, c); });

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!flowId) return;
    setLoaded(false);
    // Kill any debounced save still pending from the flow we're leaving. Its
    // callback closes over the PREVIOUS flow's sheets, so letting it fire after
    // the switch pushed the old flow's tabs into this one's view (until the
    // async read below overwrote them) — one flow's arguments briefly showing
    // up in another.
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    // An external-edit reload keeps the keystrokes that only exist in the
    // buffer (see dirtyKeys); a flow switch drops the buffer outright — it
    // belongs to the flow we're leaving.
    const keep = reloadKeepsBuffer.current && cellsOwnerId.current && dirtyKeys.current.size
      ? {
          owner: cellsOwnerId.current,
          cells: Object.fromEntries([...dirtyKeys.current].map((k) => [k, cellsRef.current[k] ?? ''])),
        }
      : null;
    reloadKeepsBuffer.current = false;
    cellsRef.current = {}; cellsOwnerId.current = null; dirtyKeys.current.clear();
    setStockIssueDismissed(false);
    readKey(`flow_data_${flowId}`).then((data: StoredFlowData | null) => {
      // If live sync already took over, don't let this (possibly stale) local
      // mirror clobber the merged doc state.
      if (liveRef.current) { setLoaded(true); return; }
      if (data?.sheets?.length) {
        const ev = data.event ?? flowMeta?.event ?? 'policy';
        const v: PolicyVariant = data.variant ?? 'stock-issues';
        const pfo: PFOrder = data.pfOrder ?? 'pro-first';
        const cols = ev === 'policy' ? POLICY_COLS : (pfo === 'pro-first' ? PF_PRO_FIRST_COLS : PF_CON_FIRST_COLS);
        const custCols = data.customColumns ?? null;
        const colCount = (custCols ?? cols).length;

        let loadedSheets = normalizeSheets(data.sheets);
        // Lay the unsaved keystrokes back over the sheet they were typed on.
        // Only the keys that were actually edited — the external writer's own
        // changes to every other cell come through untouched.
        let merged = false;
        if (keep && loadedSheets.some((sh) => sh.id === keep.owner)) {
          loadedSheets = loadedSheets.map((sh) =>
            sh.id === keep.owner ? { ...sh, cells: { ...sh.cells, ...keep.cells } } : sh);
          merged = true;
        }

        setVariant(v);
        setPfOrder(pfo);
        // Clamped: a corrupt or hand-edited count must not render a million rows.
        setNumRows(Math.max(DEFAULT_ROWS, Math.min(MAX_ROWS, Number(data.numRows) || DEFAULT_ROWS)));
        setSheets(loadedSheets);
        setColumnWidths(
          data.columnWidths?.length === colCount
            ? data.columnWidths
            : (custCols ?? cols).map(() => DEFAULT_COL_WIDTH)
        );
        setCustomColumns(custCols);
        setColumnColors(
          data.columnColors?.length === colCount ? data.columnColors : (custCols ?? cols).map(() => null)
        );

        setZoom(data.zoom ?? 100);
        // Restore which tab was open (session restore) — falls back to 0 for
        // flows saved before this field existed, same as a fresh load.
        const savedTab = data.activeSheetIdx;
        const idx = typeof savedTab === 'number' && savedTab >= 0 && savedTab < loadedSheets.length ? savedTab : 0;
        // The edit buffer must point at the tab that is actually on screen.
        // It used to be seeded from sheet 0 regardless of the restored tab, so a
        // flow reopened on tab 3 rendered tab 0's arguments under tab 3's label
        // and filed every edit onto tab 0 — which read as content vanishing from
        // one tab and turning up on another.
        cellsRef.current = { ...(loadedSheets[idx]?.cells ?? {}) }; cellsOwnerId.current = loadedSheets[idx]?.id ?? null;
        setActiveSheetIdx(idx);
        // The merged keystrokes are only in memory until the next save — write
        // them now so a crash or a second external edit can't drop them again.
        if (merged) requestAnimationFrame(() => persist());
      } else {
        const ev: 'policy' | 'pf' = flowEvent;
        // Only a brand-new flow reads these — an existing flow always keeps its
        // own saved variant/zoom, this branch only runs when there's no saved
        // data at all yet.
        const prefs = readFlowPrefs();
        const def = makeDefaultData(ev, prefs.defaultVariant, prefs.defaultPfOrder);
        setVariant(prefs.defaultVariant);
        setPfOrder(prefs.defaultPfOrder);
        setSheets(def.sheets);
        setColumnWidths(def.columnWidths);
        setCustomColumns(null);
        setColumnColors(def.columnWidths.map(() => null));
        setFontSize(prefs.defaultFontSize);
        setZoom(prefs.defaultZoom);
        cellsRef.current = {}; cellsOwnerId.current = def.sheets[0]?.id ?? null;
        setActiveSheetIdx(0);
      }
      setLoaded(true);
      history.current = []; histIdx.current = -1;
      requestAnimationFrame(recordHistory);
    }).catch(() => {
      const ev: 'policy' | 'pf' = flowEvent;
      const prefs = readFlowPrefs();
      const def = makeDefaultData(ev, prefs.defaultVariant, prefs.defaultPfOrder);
      setVariant(prefs.defaultVariant);
      setPfOrder(prefs.defaultPfOrder);
      setSheets(def.sheets);
      setColumnWidths(def.columnWidths);
      setCustomColumns(null);
      setColumnColors(def.columnWidths.map(() => null));
      setFontSize(prefs.defaultFontSize);
      setZoom(prefs.defaultZoom);
      cellsRef.current = {}; cellsOwnerId.current = def.sheets[0]?.id ?? null;
      setActiveSheetIdx(0);
      setLoaded(true);
      history.current = []; histIdx.current = -1;
      requestAnimationFrame(recordHistory);
    });
    // Also on unmount — a pending save must never outlive the view that armed it.
    return () => { if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; } };
  }, [flowId, reloadNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live reload when Warroom AI (or another writer) edits this flow ─────────
  //
  // TWO channels, because they are two different events with two different costs:
  //
  //  'warroom-flow-updated'    — someone rewrote this flow's storage key. Do the
  //                              full reload: drop the local buffer, re-read from
  //                              disk, remount the cells.
  //  'warroom-flow-live-patch' — a frame of Auto Flow's fill-in animation. The
  //                              sheets ride ON the event, so nothing is read
  //                              back and `loaded` is never cleared.
  //
  // Auto Flow's replay used to fire the first one ~150 times, once per frame.
  // Each fire set `loaded` false, so every frame swapped the whole grid for the
  // "Loading flow…" placeholder and then rebuilt it from an async disk read that
  // landed after the next frame had already started. What the user saw was a
  // strobing loading screen with nothing filling in — the animation was running,
  // it just never had a frame long enough to be visible.
  useEffect(() => {
    if (!flowId) return;
    function onExternalEdit(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.flowId !== flowId) return;
      // Drop any pending local save so it can't clobber the freshly-written data,
      // then force a clean reload from storage (re-mounts cells via reloadNonce).
      // The reload keeps whatever was typed since the last save — see dirtyKeys.
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      reloadKeepsBuffer.current = true;
      setReloadNonce((n) => n + 1);
    }
    function onLivePatch(e: Event) {
      const detail = (e as CustomEvent).detail as
        { flowId?: string; sheets?: SheetData[]; activeSheetIdx?: number } | undefined;
      if (!detail || detail.flowId !== flowId || !detail.sheets?.length) return;
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      const next = normalizeSheets(detail.sheets);
      const idx = typeof detail.activeSheetIdx === 'number'
        ? Math.max(0, Math.min(detail.activeSheetIdx, next.length - 1))
        : snap.current.activeSheetIdx;
      setSheets(next);
      setActiveSheetIdx(idx);
      // Keep the edit buffer pointed at the sheet on screen; the writer owns the
      // content during a replay, so adopting its cells wholesale is correct.
      cellsRef.current = { ...(next[idx]?.cells ?? {}) };
      cellsOwnerId.current = next[idx]?.id ?? null;
      dirtyKeys.current.clear();
      snap.current = { ...snap.current, sheets: next, activeSheetIdx: idx };
      setCellNonce((n) => n + 1);
    }
    window.addEventListener('warroom-flow-updated', onExternalEdit as EventListener);
    window.addEventListener('warroom-flow-live-patch', onLivePatch as EventListener);
    return () => {
      window.removeEventListener('warroom-flow-updated', onExternalEdit as EventListener);
      window.removeEventListener('warroom-flow-live-patch', onLivePatch as EventListener);
    };
  }, [flowId]);

  // ── Live-update default side colors when changed in Settings ────────────────
  useEffect(() => {
    function onColors() {
      const s = readSettings();
      setAffColor(s.affColor);
      setNegColor(s.negColor);
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, onColors);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onColors);
  }, []);

  // ── Global shortcuts: find (⌘F), undo (⌘Z), redo (⌘⇧Z) ─────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!flowId) return;
      if (e.key === 'Escape') {
        if (drawModeRef.current) cancelDrawMode();
        else if (selectionRef.current) clearSelection();
        else if (findOpen) closeFind();
        return;
      }
      // ── With a group of cells selected, the group is what the keyboard acts
      // on. These run before the single-cell equivalents below, and before the
      // per-cell handler ever sees the key (⌘-click never focuses a cell).
      if (selectionRef.current) {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && !e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
          // The up/down pair is the same gesture as the single-cell ⌘↑/⌘↓, so it
          // honours that shortcut's disable toggle. Left/right is its own thing
          // (it has no single-cell equivalent) and isn't covered by it.
          const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
          if (vertical && isShortcutDisabled('flow-move-row')) return;
          e.preventDefault();
          moveSelection(
            e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0,
            e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0,
          );
          return;
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault(); clearSelectedCells(); return;
        }
        for (const [id, cmd] of [
          ['flow-bold', 'bold'], ['flow-italic', 'italic'], ['flow-underline', 'underline'],
          ['flow-strike', 'strikeThrough'], ['flow-highlight', 'highlight'],
        ] as const) {
          if (matchesShortcut(e, id)) { e.preventDefault(); applyFormatToSelection(cmd); return; }
        }
      }
      // ⌘L — the ONE handler for it, whether the caret is in a cell or not.
      // The per-cell keydown deliberately doesn't handle it: both used to fire
      // on the same keypress, and the pair cancelled out. Toggles against the
      // ref, not the closure, for the same reason.
      if (matchesShortcut(e, 'flow-link')) {
        e.preventDefault();
        if (drawModeRef.current) cancelDrawMode(); else startDrawMode();
        return;
      }
      if (matchesShortcut(e, 'find-page')) {
        e.preventDefault();
        setFindOpen(true);
        setTimeout(() => findInputRef.current?.focus(), 0);
      } else if (matchesShortcut(e, 'flow-undo')) {
        e.preventDefault(); undo();
      } else if (matchesShortcut(e, 'flow-redo')) {
        e.preventDefault(); redo();
      } else if (matchesShortcut(e, 'flow-sheet-new')) {
        e.preventDefault(); addSheet();
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        // ⌘1–8 pick a sheet by position; ⌘9 jumps to the last one (browser-tab
        // convention), so it still lands somewhere useful with >9 sheets. Not
        // individually rebindable — it's a range, not one combo — but still
        // respects the disable toggle.
        if (isShortcutDisabled('flow-sheet-switch')) return;
        const all = snap.current.sheets;
        const n = Number(e.key);
        const idx = n === 9 ? all.length - 1 : n - 1;
        if (idx < 0 || idx >= all.length) return;
        e.preventDefault();
        switchSheet(idx);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flowId, drawMode, findOpen, sheets, activeSheetIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Persist ───────────────────────────────────────────────────────────────

  /**
   * Merge the live cell buffer (`cellsRef`) back into a sheets array, matched by
   * the OWNER SHEET ID rather than by `activeSheetIdx` — the guard against
   * cross-tab content corruption. See src/lib/flowCellFlush.ts for why.
   */
  function flushInto(sheetList: SheetData[]): SheetData[] {
    return flushCellsIntoSheets(sheetList, cellsOwnerId.current, cellsRef.current);
  }

  function persist(overrides: Partial<StoredFlowData> = {}) {
    if (!flowId) return;
    const s = snap.current;
    const flushedSheets = flushInto(s.sheets);
    // Everything in the buffer is in this payload — nothing is "unsaved" now.
    dirtyKeys.current.clear();
    const payload = {
      event: flowEvent,
      variant: s.variant,
      pfOrder: s.pfOrder,
      sheets: flushedSheets,
      columnWidths: s.columnWidths,
      customColumns: s.customColumns,
      columnColors: s.columnColors,
      fontSize: s.fontSize,
      zoom: s.zoom,
      numRows: s.numRows,
      activeSheetIdx: s.activeSheetIdx,
      ...overrides,
    } as StoredFlowData;
    // Local mirror — keeps the flow in the sidebar and working offline even when live.
    writeKey(`flow_data_${flowId}`, payload);
    // When live, mirror layout/structure into the Y.Doc so the shared snapshot
    // carries it and teammates re-render. Cell *text* is synced separately, per
    // keystroke, so we deliberately don't push cells here (would clobber merges).
    if (liveRef.current && !applyingRemote.current) syncStructureToDoc(payload);
    pushCloudSnapshot(payload);
  }

  // Persist purely switching tabs too (not just content edits) — otherwise
  // opening a flow, clicking a different tab, and closing without editing
  // anything would silently forget the tab switch on next open/relaunch.
  useEffect(() => {
    if (!loaded) return;
    persist();
  }, [activeSheetIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Mirror the flow to the cloud so it survives this browser.
   *
   * Local storage is still the source of truth while you type — the cloud copy
   * is a debounced snapshot behind it, so a dropped connection costs you
   * nothing but the sync. A LIVE flow skips this entirely: its own sync handle
   * already persists the merged Y.Doc, and pushing a second, non-merged copy
   * from here would race it and could overwrite a co-editor's work.
   */
  function pushCloudSnapshot(payload: StoredFlowData) {
    if (!flowId || liveRef.current) return;
    if (cloudPushTimer.current) clearTimeout(cloudPushTimer.current);
    cloudPushTimer.current = setTimeout(async () => {
      cloudPushTimer.current = null;
      const seed = new Y.Doc();
      try {
        // seedDoc wants every layout field present; a payload built before a
        // column color was ever set can be missing one.
        seedDoc(seed, { ...payload, columnColors: payload.columnColors ?? [] }, cellToHtml);
        await cloudSaveSnapshot(flowId, flowMeta?.name ?? 'Flow', u8ToB64(Y.encodeStateAsUpdate(seed)));
      } catch { /* offline or over the size cap — the local copy is unaffected */ }
      finally { seed.destroy(); }
    }, 3000);
  }

  // ── Live: structure ↔ Y.Doc ────────────────────────────────────────────────
  // Mirror meta + sheet identity/names into the doc (not cell text). Reconciles
  // the sheets Y.Array by stable id so renames/adds/removes propagate.
  function syncStructureToDoc(data: StoredFlowData) {
    const handle = syncRef.current;
    if (!handle) return;
    const doc = handle.doc;
    doc.transact(() => {
      const meta = metaMap(doc);
      meta.set('event', data.event);
      meta.set('variant', data.variant);
      meta.set('pfOrder', data.pfOrder);
      meta.set('fontSize', data.fontSize);
      meta.set('zoom', data.zoom);
      meta.set('numRows', data.numRows ?? DEFAULT_ROWS);
      meta.set('customColumns', data.customColumns ?? null);
      meta.set('columnWidths', data.columnWidths);
      meta.set('columnColors', data.columnColors ?? []);

      const arr = sheetsArr(doc);
      const haveIds = new Set<string>();
      for (let i = 0; i < arr.length; i++) haveIds.add(arr.get(i).get('id'));
      // add / rename
      data.sheets.forEach((sh) => {
        let sm: Y.Map<any> | null = null;
        for (let i = 0; i < arr.length; i++) { const m = arr.get(i); if (m.get('id') === sh.id) { sm = m; break; } }
        if (!sm) {
          sm = new Y.Map();
          sm.set('id', sh.id);
          sm.set('name', sh.name);
          sm.set('cells', new Y.Map<Y.Text>());
          sm.set('arrows', new Y.Array());
          arr.push([sm]);
        } else if (sm.get('name') !== sh.name) {
          sm.set('name', sh.name);
        }
        haveIds.delete(sh.id);
      });
      // remove sheets that no longer exist locally
      if (haveIds.size) {
        for (let i = arr.length - 1; i >= 0; i--) {
          if (haveIds.has(arr.get(i).get('id'))) arr.delete(i, 1);
        }
      }
    }, LOCAL_ORIGIN);
  }

  // Push one cell's HTML into its Y.Text (realtime, per keystroke).
  function pushLiveCell(key: string, html: string) {
    const handle = syncRef.current;
    if (!liveRef.current || !handle || applyingRemote.current) return;
    // Owner id, not activeSheetIdx — a stale index here would push the keystroke
    // into another sheet's cell in the SHARED doc and broadcast it to the team.
    const sheetId = cellsOwnerId.current;
    if (!sheetId) return;
    const t = cellText(handle.doc, sheetId, key);
    if (t) setYText(t, html, LOCAL_ORIGIN);
  }

  // Build the current flow's plain data (for seeding a fresh live doc).
  function currentDataForDoc(): FlowDocData {
    const s = snap.current;
    // Flush by owner id, not index — see flushInto/flowCellFlush.ts. Getting this
    // wrong here would seed the SHARED doc with one tab's cells on another tab.
    const sheets = flushInto(s.sheets).map((sh) => ({
      id: sh.id, name: sh.name,
      cells: { ...sh.cells },
      arrows: [...(sh.arrows ?? [])],
    }));
    return {
      event: flowEvent,
      variant: s.variant, pfOrder: s.pfOrder, sheets, numRows: s.numRows,
      columnWidths: [...s.columnWidths], customColumns: s.customColumns ? [...s.customColumns] : null,
      columnColors: [...s.columnColors], fontSize: s.fontSize, zoom: s.zoom,
    };
  }

  // Replace local React state + cell DOM from the Y.Doc (initial hydrate on join,
  // and a coarse rebuild when a remote *structural* change lands).
  function hydrateFromDoc(doc: Y.Doc, opts: { remountCells: boolean } = { remountCells: true }) {
    const data = docToData(doc);
    if (!data) return;
    applyingRemote.current = true;
    try {
      const cols = data.event === 'policy' ? POLICY_COLS : (data.pfOrder === 'pro-first' ? PF_PRO_FIRST_COLS : PF_CON_FIRST_COLS);
      const colCount = (data.customColumns ?? cols).length;
      setVariant(data.variant);
      setPfOrder(data.pfOrder);
      setSheets(normalizeSheets(data.sheets as any));
      setColumnWidths(data.columnWidths?.length === colCount ? data.columnWidths : (data.customColumns ?? cols).map(() => DEFAULT_COL_WIDTH));
      setCustomColumns(data.customColumns);
      setColumnColors(data.columnColors?.length === colCount ? data.columnColors : (data.customColumns ?? cols).map(() => null));

      setNumRows(data.numRows ?? DEFAULT_ROWS);
      // Zoom is deliberately NOT adopted from the shared doc. It's a per-viewer
      // fit to your own window, and the grid auto-fits on every container resize
      // — so applying a teammate's zoom would start a feedback loop: they fit to
      // their width and broadcast, you adopt it, your auto-fit corrects it to
      // your width and broadcasts back, forever. Your zoom stays yours.
      // Stay on the sheet you're actually looking at, by ID. Clamping the old
      // index instead meant a teammate adding, deleting, or reordering a tab
      // silently slid you onto a different one mid-round. Falls back to the
      // clamped index only if your sheet is genuinely gone (someone deleted it).
      const priorId = snap.current.sheets[snap.current.activeSheetIdx]?.id;
      const byId = priorId ? data.sheets.findIndex((sh) => sh.id === priorId) : -1;
      const idx = byId !== -1 ? byId : Math.min(snap.current.activeSheetIdx, data.sheets.length - 1);
      if (idx !== snap.current.activeSheetIdx) setActiveSheetIdx(idx);
      cellsRef.current = { ...(data.sheets[idx]?.cells ?? {}) }; cellsOwnerId.current = data.sheets[idx]?.id ?? null;
      if (opts.remountCells) setCellNonce((n) => n + 1);
    } finally {
      // release on the next tick so setState-driven persists don't echo back
      requestAnimationFrame(() => { applyingRemote.current = false; });
    }
  }

  // Apply a single remote cell-text change straight to the DOM (no remount, so
  // neither user loses their caret). We never overwrite the cell *this* user is
  // focused in — same-cell concurrent edits reconcile on blur instead.
  function patchRemoteCell(key: string, html: string) {
    // Remote HTML is untrusted (any teammate — or anyone who reached the live
    // broadcast channel — can send it), so sanitize before it touches the DOM
    // or our local mirror.
    const clean = sanitizeCellHtml(html || '');
    cellsRef.current[key] = clean;
    if (focusedCell.current === key) return;
    const el = cellEls.current[key];
    if (el) { el.innerHTML = clean; el.dataset.init = '1'; }
  }

  // ── Live lifecycle: attach / detach the sync handle ─────────────────────────
  useEffect(() => {
    if (!flowId || !live || !identityId) return;
    let cancelled = false;
    let handle: FlowSyncHandle | null = null;
    setLiveStarting(true);
    (async () => {
      // Presence is colors only — no name is ever collected, so there is none to show.
      const me: PresenceUser = { id: identityId, name: '', color: colorForUser(identityId) };
      try {
        handle = await createFlowSync(flowId, flowMeta?.name ?? 'Flow', me);
      } catch {
        if (!cancelled) { setLiveStarting(false); setLive(false); }
        return;
      }
      if (cancelled) { handle.destroy(); return; }
      syncRef.current = handle;
      liveRef.current = true;
      // If the doc already has content (snapshot or a peer), adopt it. Otherwise
      // we're the first writer — seed it from what we already have on screen.
      if (!docToData(handle.doc)) seedDoc(handle.doc, currentDataForDoc(), cellToHtml);
      else hydrateFromDoc(handle.doc, { remountCells: true });
      handle.onCursors((c) => { if (!cancelled) setRemoteCursors(c); });
      handle.onStatus((s) => {
        if (cancelled) return;
        setSyncStatus(s);
        // Record that this flow has a server copy the moment it actually has
        // one. Nothing else sets this any more: going live used to be an
        // explicit step that set it, and now every flow is live from the start.
        // It is not cosmetic — deleting a flow only removes the server row when
        // this is true, so leaving it false orphans the row permanently.
        if (s === 'SUBSCRIBED' && !flowMeta?.cloud) updateFlowMeta({ cloud: true });
      });
      setLiveReady(true);
      setLiveStarting(false);
    })();
    return () => {
      cancelled = true;
      liveRef.current = false;
      setLiveReady(false);
      setRemoteCursors([]);
      setSyncStatus('CONNECTING');
      syncRef.current = null;
      handle?.destroy();
    };
  }, [flowId, live, identityId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every flow is live. There is no per-flow toggle and no "go live" step: if
  // this browser has an identity and the build has a Supabase project, the flow
  // joins its realtime channel on open. Sharing is then only about handing out
  // the link — not about changing what the flow is.
  useEffect(() => {
    setLive(cloudConfigured && !!identityId);
  }, [flowId, identityId]);

  // ── Live observers: meta/sheets (structural) + active-sheet cells (text) ─────
  useEffect(() => {
    const handle = syncRef.current;
    if (!liveReady || !handle) return;
    const doc = handle.doc;
    const onMeta = (_e: any, tr: Y.Transaction) => { if (tr.origin === REMOTE_ORIGIN) hydrateFromDoc(doc, { remountCells: false }); };
    const onSheets = (_e: any, tr: Y.Transaction) => { if (tr.origin === REMOTE_ORIGIN) hydrateFromDoc(doc, { remountCells: true }); };
    metaMap(doc).observe(onMeta);
    sheetsArr(doc).observe(onSheets);
    return () => { metaMap(doc).unobserve(onMeta); sheetsArr(doc).unobserve(onSheets); };
  }, [liveReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Observe the *active* sheet's cells; patch remote text edits into the DOM.
  useEffect(() => {
    const handle = syncRef.current;
    const sheetId = activeSheet?.id;
    if (!liveReady || !handle || !sheetId) return;
    const sheet = findSheet(handle.doc, sheetId);
    if (!sheet) return;
    const cells = sheetCells(sheet);
    const onCells = (events: any[], tr: Y.Transaction) => {
      if (tr.origin !== REMOTE_ORIGIN) return;
      applyingRemote.current = true;
      try {
        events.forEach((ev: any) => {
          if (ev.target instanceof Y.Text && ev.path.length >= 1) {
            patchRemoteCell(String(ev.path[ev.path.length - 1]), ev.target.toString());
          } else if (ev.target === cells && ev.changes?.keys) {
            ev.changes.keys.forEach((_chg: any, key: string) => {
              const t = cells.get(key); patchRemoteCell(key, t ? t.toString() : '');
            });
          }
        });
      } finally { requestAnimationFrame(() => { applyingRemote.current = false; }); }
    };
    cells.observeDeep(onCells);
    return () => cells.unobserveDeep(onCells);
  }, [liveReady, activeSheet?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Go live / leave ─────────────────────────────────────────────────────────
  /**
   * Turn this flow into a room: push what's on screen up as the starting
   * snapshot, then let the sync handle take over. Returns false (and stays
   * local) if the cloud can't be reached — better than handing out a share
   * link to a room that was never created.
   */
  async function startLiveCollab(): Promise<{ ok: boolean; shareToken?: string; error?: string }> {
    if (!flowId || !identityId) return { ok: false, error: 'Still connecting — try again in a moment.' };
    setLiveStarting(true);
    const seed = new Y.Doc();
    seedDoc(seed, currentDataForDoc(), cellToHtml);
    const content = u8ToB64(Y.encodeStateAsUpdate(seed));
    seed.destroy();

    // The cloud row may not exist yet (a flow made offline, or one imported
    // from xlsx before the identity resolved), so create it on demand.
    const res = await cloudSaveSnapshot(flowId, flowMeta?.name ?? 'Flow', content);
    if (!res.ok) { setLiveStarting(false); return { ok: false, error: res.error }; }
    const token = res.data.shareToken ?? flowMeta?.shareToken;
    if (!token) { setLiveStarting(false); return { ok: false, error: 'Only the person who made this flow can share it.' }; }
    updateFlowMeta({ live: true, cloud: true, shareToken: token });
    setLive(true); // the lifecycle effect picks it up
    return { ok: true, shareToken: token };
  }

  // ── Undo / redo ──────────────────────────────────────────────────────────
  function takeSnapshot(): FlowSnapshot {
    const s = snap.current;
    // Flush by owner id, not index (see flushInto) — otherwise a snapshot taken
    // while the index is stale bakes one tab's cells onto another, and undo
    // faithfully restores that corruption.
    const sheets = flushInto(s.sheets).map((sh) => ({
      ...sh,
      cells: { ...sh.cells },
      arrows: [...(sh.arrows ?? [])],
    }));
    return {
      sheets,
      columnColors: [...s.columnColors],
      customColumns: s.customColumns ? [...s.customColumns] : null,
      columnWidths: [...s.columnWidths],
      variant: s.variant,
      pfOrder: s.pfOrder,
      event: s.event,
      numRows: s.numRows,
    };
  }

  function recordHistory() {
    if (restoring.current) return;
    const snapshot = takeSnapshot();
    history.current = history.current.slice(0, histIdx.current + 1);
    history.current.push(snapshot);
    if (history.current.length > 120) history.current.shift();
    histIdx.current = history.current.length - 1;
    syncHistButtons();
  }

  function restoreSnapshot(s: FlowSnapshot) {
    restoring.current = true;
    // Stay on the tab the user is looking at. Undo is for edits, not navigation:
    // switching tabs records no snapshot, so an older one still carries whatever
    // tab happened to be open when it was taken — restoring that index yanked you
    // back to tab 1 for undoing an edit you made on tab 2. Clamp, because undoing
    // an "add sheet" can delete the tab we're standing on.
    const idx = Math.max(0, Math.min(snap.current.activeSheetIdx, s.sheets.length - 1));
    setCustomColumns(s.customColumns);
    setColumnWidths(s.columnWidths);
    setColumnColors(s.columnColors);
    setVariant(s.variant);
    setPfOrder(s.pfOrder);
    setNumRows(s.numRows);
    setSheets(s.sheets);
    setActiveSheetIdx(idx);
    cellsRef.current = { ...(s.sheets[idx]?.cells ?? {}) }; cellsOwnerId.current = s.sheets[idx]?.id ?? null;
    dirtyKeys.current.clear();
    snap.current = { ...snap.current, sheets: s.sheets, columnColors: s.columnColors, customColumns: s.customColumns, columnWidths: s.columnWidths, activeSheetIdx: idx, variant: s.variant, pfOrder: s.pfOrder, numRows: s.numRows };
    persist({ sheets: s.sheets, columnColors: s.columnColors, customColumns: s.customColumns, columnWidths: s.columnWidths, variant: s.variant, pfOrder: s.pfOrder, event: s.event, numRows: s.numRows });
    setCellNonce((n) => n + 1);
    requestAnimationFrame(recomputeArrows);
    setTimeout(() => { restoring.current = false; }, 0);
  }

  function undo() {
    if (histIdx.current > 0) { histIdx.current -= 1; restoreSnapshot(history.current[histIdx.current]); syncHistButtons(); }
  }
  function redo() {
    if (histIdx.current < history.current.length - 1) { histIdx.current += 1; restoreSnapshot(history.current[histIdx.current]); syncHistButtons(); }
  }

  function scheduleSave() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const s = snap.current;
      const updated = flushInto(s.sheets);
      setSheets(updated);
      snap.current = { ...snap.current, sheets: updated };
      persist({ sheets: updated });
      recordHistory();
    }, 600);
  }

  // ── Cell input / keyboard ─────────────────────────────────────────────────

  // Drop a cell from the active sheet's AI-summary set (removes its ring) — once
  // the user edits an AI-written cell, the content is theirs, not the AI's.
  function clearAiCell(key: string) {
    const s = snap.current;
    const owner = cellsOwnerId.current;
    const sh = s.sheets.find((x) => x.id === owner);
    if (!sh?.aiCells?.includes(key)) return;
    const updated = s.sheets.map((x) =>
      x.id === owner ? { ...x, aiCells: (x.aiCells ?? []).filter((k) => k !== key) } : x
    );
    setSheets(updated);
    snap.current = { ...snap.current, sheets: updated };
  }

  // Every path that changes a cell's HTML goes through here: buffer it, mark it
  // unsaved, mirror it to live teammates, and arm the debounced save.
  function noteCellEdit(key: string, html: string) {
    cellsRef.current[key] = html;
    dirtyKeys.current.add(key);
    pushLiveCell(key, html);
    scheduleSave();
  }

  function handleInput(ri: number, ci: number, e: React.FormEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const key = `${ri}-${ci}`;
    clearAiCell(key);
    noteCellEdit(key, el.innerHTML);
    refreshFormatState();
  }

  // Word and Google Docs put fully-styled HTML on the clipboard — font family,
  // point size, and an explicit ink color. Pasting that natively drags all of it
  // into the cell, so a tag copied out of a speech doc lands in the wrong font at
  // the wrong size, and (from a dark-themed doc) in white-on-white. Intercept the
  // paste and insert a cleaned copy: emphasis survives, everything else inherits
  // the cell's own styling.
  function handlePaste(ri: number, ci: number, e: React.ClipboardEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    if (!html && !text) return;
    e.preventDefault();
    const insert = cleanPastedHtml(html, text);
    if (!insert) return;
    document.execCommand('insertHTML', false, insert);
    noteCellEdit(`${ri}-${ci}`, el.innerHTML);
  }

  // Apply rich-text emphasis to the focused cell (toolbar buttons).
  // Buttons call this from onMouseDown(preventDefault) so the cell keeps focus
  // and its selection, letting execCommand act on the selected text.
  function applyFormat(cmd: 'bold' | 'italic' | 'underline' | 'strikeThrough' | 'highlight') {
    // A group selection takes precedence: it's the thing the user is pointing at,
    // and none of its cells is focused.
    if (applyFormatToSelection(cmd)) return;
    const key = focusedCell.current;
    const el = key ? cellEls.current[key] : null;
    if (!key || !el) return;
    el.focus();
    if (cmd === 'highlight') toggleHighlight();
    else if (cmd === 'bold') toggleBold();
    else document.execCommand(cmd);
    noteCellEdit(key, el.innerHTML);
    refreshFormatState();
  }

  // Cells are bold by default, so ⌘B usually turns bold OFF — and "off" has to
  // be written down. With styleWithCSS on, Chromium emits an inline
  // `font-weight: normal` (which the cell sanitizer allows) rather than trying
  // to strip a <b> that was never there. Both directions round-trip.
  function toggleBold() {
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand('bold');
    document.execCommand('styleWithCSS', false, 'false');
  }

  // What emphasis is on at the caret right now — drives the toolbar's B/I/U/S/H
  // active state. Read from the browser's own editing state (the same thing
  // execCommand toggles), so it's right whether the emphasis came from the
  // button, the shortcut, or a paste. Cheap, and only re-renders on a change.
  function refreshFormatState() {
    // With a group selected the buttons describe the GROUP, not a caret.
    const sel = selectionRef.current;
    if (sel) {
      const keys = selectionKeys(sel).filter((k) => htmlToText(cellToHtml(cellsRef.current[k] ?? '')).trim());
      const all = (e: Emphasis) => keys.length > 0 && keys.every((k) => cellHasEmphasis(cellToHtml(cellsRef.current[k] ?? ''), e));
      const next = {
        bold: all('bold'), italic: all('italic'), underline: all('underline'),
        strike: all('strikeThrough'), highlight: all('highlight'),
      };
      setFmt((f) => (f.bold === next.bold && f.italic === next.italic && f.underline === next.underline
        && f.strike === next.strike && f.highlight === next.highlight) ? f : next);
      return;
    }
    const key = focusedCell.current;
    const el = key ? cellEls.current[key] : null;
    if (!el || document.activeElement !== el) {
      setFmt((f) => (f.bold || f.italic || f.underline || f.strike || f.highlight)
        ? { bold: false, italic: false, underline: false, strike: false, highlight: false } : f);
      return;
    }
    let next: typeof fmt;
    try {
      const back = (document.queryCommandValue('backColor') || '').replace(/\s/g, '').toLowerCase();
      next = {
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'),
        strike: document.queryCommandState('strikeThrough'),
        highlight: back === HILITE_RGB || back === HILITE,
      };
    } catch { return; }
    setFmt((f) => (f.bold === next.bold && f.italic === next.italic && f.underline === next.underline
      && f.strike === next.strike && f.highlight === next.highlight) ? f : next);
  }

  // The caret moves without any key we handle (mouse click, shift-arrow, ⌘A),
  // so the toolbar state follows the document's own selection events.
  useEffect(() => {
    let raf = 0;
    const onSel = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(refreshFormatState); };
    document.addEventListener('selectionchange', onSel);
    return () => { document.removeEventListener('selectionchange', onSel); cancelAnimationFrame(raf); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Highlight is a background-color span rather than an execCommand flag, so it
  // has no built-in toggle — read the caret's current background and clear it if
  // it is already ours. styleWithCSS keeps this as an inline style the cell
  // sanitizer allows (background-color) instead of a legacy <font> attribute.
  function toggleHighlight() {
    document.execCommand('styleWithCSS', false, 'true');
    const cur = (document.queryCommandValue('backColor') || '').replace(/\s/g, '').toLowerCase();
    const on = cur === HILITE_RGB || cur === HILITE;
    document.execCommand('hiliteColor', false, on ? 'transparent' : HILITE);
    document.execCommand('styleWithCSS', false, 'false');
  }

  // Screen rect of a collapsed range. Chromium gives a zero-width rect at the
  // caret; an empty cell yields an all-zero rect, so fall back to the cell box.
  function rectOf(range: Range, el: HTMLElement): DOMRect {
    const r = range.getBoundingClientRect();
    if (!r.top && !r.bottom && !r.left) return el.getBoundingClientRect();
    return r;
  }

  // Is the caret on the cell's first / last *visual* line? Compared by y against
  // a caret placed at the very start / end of the cell, because wrapped lines
  // have no node boundary to test — only a position on screen.
  function caretOnEdgeLine(el: HTMLDivElement, edge: 'first' | 'last'): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return true;
    const cur = rectOf(sel.getRangeAt(0), el);
    const probe = document.createRange();
    probe.selectNodeContents(el);
    probe.collapse(edge === 'first');
    const target = rectOf(probe, el);
    // Half a line of tolerance: same line ⇒ same top, next line ⇒ a full line away.
    return Math.abs(cur.top - target.top) < Math.max(4, cur.height * 0.5);
  }

  // Is the (collapsed) caret at the very start / end of the cell's text? Used
  // for ← / → : inside the text they move the caret, at the edge they move to
  // the neighbouring column. Measured by the text between the cell's boundary
  // and the caret, so it's right across bold/italic spans and line breaks.
  function caretAtTextEdge(el: HTMLDivElement, edge: 'start' | 'end'): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer)) return false;
    const probe = document.createRange();
    probe.selectNodeContents(el);
    if (edge === 'start') probe.setEnd(r.startContainer, r.startOffset);
    else probe.setStart(r.endContainer, r.endOffset);
    return probe.toString().length === 0;
  }

  // Focus a cell and place the caret at its start or end, then make sure the
  // cell is actually visible: `focus()`'s own scroll-into-view doesn't know
  // about the sticky column header, so moving up a row could land the caret
  // under it, and moving down could leave it a pixel past the bottom edge.
  const HEADER_H = 36;
  function focusCell(key: string, place: 'start' | 'end' = 'end') {
    const el = cellEls.current[key];
    if (!el) return;
    el.focus({ preventScroll: true });
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(place === 'start');
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const c = containerRef.current;
    if (!c) return;
    const cr = c.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const pad = 8;
    if (r.top < cr.top + HEADER_H + pad) c.scrollTop -= (cr.top + HEADER_H + pad) - r.top;
    else if (r.bottom > cr.bottom - pad) c.scrollTop += r.bottom - (cr.bottom - pad);
    if (r.left < cr.left + pad) c.scrollLeft -= (cr.left + pad) - r.left;
    else if (r.right > cr.right - pad) c.scrollLeft += r.right - (cr.right - pad);
  }

  function handleKeyDown(ri: number, ci: number, e: React.KeyboardEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const mod = e.metaKey || e.ctrlKey;

    // Rich-text emphasis — ⌘B / ⌘I / ⌘U
    if (matchesShortcut(e, 'flow-bold') || matchesShortcut(e, 'flow-italic') || matchesShortcut(e, 'flow-underline')) {
      e.preventDefault();
      const cmd = matchesShortcut(e, 'flow-bold') ? 'bold' : matchesShortcut(e, 'flow-italic') ? 'italic' : 'underline';
      if (cmd === 'bold') toggleBold(); else document.execCommand(cmd);
      noteCellEdit(`${ri}-${ci}`, el.innerHTML);
      refreshFormatState();
      return;
    }
    if (matchesShortcut(e, 'flow-strike')) {
      e.preventDefault();
      document.execCommand('strikeThrough');
      noteCellEdit(`${ri}-${ci}`, el.innerHTML);
      refreshFormatState();
      return;
    }
    if (matchesShortcut(e, 'flow-highlight')) {
      e.preventDefault();
      toggleHighlight();
      noteCellEdit(`${ri}-${ci}`, el.innerHTML);
      refreshFormatState();
      return;
    }
    // ⌘L (draw an arrow) is NOT handled here — the window listener owns it,
    // and it fires for a keypress inside a cell too. Handling it in both places
    // made the two toggles cancel each other out.
    // Move this cell's content up/down a row (swaps with its neighbour). Not
    // individually rebindable — it's a pair (up + down), not one combo — but
    // still respects the disable toggle.
    if (mod && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (isShortcutDisabled('flow-move-row')) return;
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 'down' : 'up';
      const t = dir === 'down' ? ri + 1 : ri - 1;
      if (t < 0 || t >= numRows) return;
      moveCell(ri, ci, dir);
      focusCell(`${t}-${ci}`);
      return;
    }
    if (mod) return; // let ⌘Z/⌘F/⌘A etc. bubble to global handlers

    if (e.key === 'Tab') {
      e.preventDefault();
      const next = e.shiftKey ? ri - 1 : ri + 1;
      if (next >= 0 && next < numRows) focusCell(`${next}-${ci}`, 'start');
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
      noteCellEdit(`${ri}-${ci}`, el.innerHTML);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (ri < numRows - 1) focusCell(`${ri + 1}-${ci}`, 'start');
    // Up / Down move a line within the cell, and only leave it once there is no
    // line left to go to. Left / Right move the caret through the text, and
    // only step to the neighbouring column once the caret is already at the
    // very start / end of the cell — so the flow walks like a spreadsheet
    // without ever eating a caret move inside a cell. Shift+arrow (selecting)
    // is always left to the browser.
    } else if (e.key === 'ArrowUp') {
      if (!e.shiftKey && ri > 0 && caretOnEdgeLine(el, 'first')) { e.preventDefault(); focusCell(`${ri - 1}-${ci}`); }
    } else if (e.key === 'ArrowDown') {
      if (!e.shiftKey && ri < numRows - 1 && caretOnEdgeLine(el, 'last')) { e.preventDefault(); focusCell(`${ri + 1}-${ci}`, 'start'); }
    } else if (e.key === 'ArrowLeft') {
      if (!e.shiftKey && ci > 0 && caretAtTextEdge(el, 'start')) { e.preventDefault(); focusCell(`${ri}-${ci - 1}`, 'end'); }
    } else if (e.key === 'ArrowRight') {
      if (!e.shiftKey && ci < columns.length - 1 && caretAtTextEdge(el, 'end')) { e.preventDefault(); focusCell(`${ri}-${ci + 1}`, 'start'); }
    }
  }

  // ── Multi-cell selection: move, clear, format ─────────────────────────────

  /**
   * Write a new cell map for the ACTIVE sheet and drop any arrow whose ends the
   * change disturbed (rule: a moved or overwritten cell invalidates its arrows —
   * re-anchoring would point the line at whatever now sits there instead).
   * Everything that mutates a selection goes through here so the arrow rule and
   * the live-sync push can't be forgotten at one call site.
   */
  function writeCells(
    cells: Record<string, string>,
    opts: { remap?: Map<string, string>; dropArrows?: Set<string> } = {},
  ) {
    const owner = cellsOwnerId.current;
    if (!owner) return;
    const prev = cellsRef.current;
    // Diff the whole map rather than trusting a caller-supplied key list. An
    // insert cascades — it can shift cells the caller never named — and a
    // repaint that misses one leaves stale text on screen until the next
    // remount, which reads as content duplicating itself.
    const touched = new Set([...Object.keys(prev), ...Object.keys(cells)]
      .filter((k) => (prev[k] ?? '') !== (cells[k] ?? '')));
    cellsRef.current = cells;
    touched.forEach((k) => {
      dirtyKeys.current.add(k);
      const el = cellEls.current[k];
      if (el) { el.innerHTML = cellToHtml(cells[k] ?? ''); el.dataset.init = '1'; }
      pushLiveCell(k, cellToHtml(cells[k] ?? ''));
    });
    const remap = opts.remap;
    const updated = snap.current.sheets.map((sh) => {
      if (sh.id !== owner) return sh;
      // Order matters. Bump FIRST, so an arrow on a cell the insert pushed down
      // follows it — that argument didn't change, only its row. Then drop the
      // arrows anchored to the moved selection itself, which no longer describe
      // anything true (per the rule: a moved cell's arrows go).
      let arrows = sh.arrows ?? [];
      if (remap?.size) arrows = arrows.map((a) => bumpArrow(a, (k) => remap.get(k) ?? k));
      if (opts.dropArrows?.size) arrows = dropArrowsTouching(arrows, opts.dropArrows);
      const aiCells = remap?.size ? sh.aiCells?.map((k) => remap.get(k) ?? k) : sh.aiCells;
      return { ...sh, cells: { ...cells }, arrows, aiCells };
    });
    setSheets(updated);
    snap.current = { ...snap.current, sheets: updated };
    persist({ sheets: updated });
    recordHistory();
    requestAnimationFrame(recomputeArrows);
  }

  /**
   * ⌘↑ / ⌘↓ / ⌘← / ⌘→ with a selection: move the whole group, inserting it at
   * the destination and sliding whatever was there down. Refused outright if
   * the column has no room left to absorb the displaced cells — better a
   * keystroke that does nothing than one that pushes an argument off the sheet.
   */
  function moveSelection(dRow: number, dCol: number) {
    const sel = selectionRef.current;
    const plan = planMove(sel, dRow, dCol, numRows, columns.length);
    if (!plan) return;
    const res = applyMove(cellsRef.current, plan, numRows);
    if (!res) return;
    // The moved cells keep their arrows' fate: dropped. Displaced cells keep
    // theirs: remapped. `shifted` never names a destination row, since the
    // insert frees each target before writing to it.
    writeCells(res.cells, { remap: res.shifted, dropArrows: plan.touched });
    setSelection(plan.next);
    selectionRef.current = plan.next;
    selAnchor.current = { row: plan.next.rows[0], col: plan.next.col };
  }

  /** Delete / Backspace with a selection: empty every selected cell. */
  function clearSelectedCells() {
    const sel = selectionRef.current;
    const keys = selectionKeys(sel);
    if (!keys.length) return;
    writeCells(clearCells(cellsRef.current, keys), { dropArrows: new Set(keys) });
  }

  const EMPHASIS_OF: Record<'bold' | 'italic' | 'underline' | 'strikeThrough' | 'highlight', Emphasis> = {
    bold: 'bold', italic: 'italic', underline: 'underline', strikeThrough: 'strikeThrough', highlight: 'highlight',
  };

  /**
   * B / I / U / S / H across a whole selection. There is no caret in any of
   * those cells, so this rewrites their HTML instead of using execCommand.
   * Toggle direction is decided once for the group — if every cell with text
   * already has the emphasis it comes off, otherwise it goes on all of them —
   * so one press can't leave a selection half formatted.
   */
  function applyFormatToSelection(cmd: keyof typeof EMPHASIS_OF): boolean {
    const sel = selectionRef.current;
    const keys = selectionKeys(sel);
    if (!keys.length) return false;
    const e = EMPHASIS_OF[cmd];
    const withText = keys.filter((k) => htmlToText(cellToHtml(cellsRef.current[k] ?? '')).trim());
    if (!withText.length) return true; // nothing to format, but the selection still owned the keypress
    const on = !withText.every((k) => cellHasEmphasis(cellToHtml(cellsRef.current[k] ?? ''), e));
    const next = { ...cellsRef.current };
    withText.forEach((k) => { next[k] = setCellEmphasis(cellToHtml(next[k] ?? ''), e, on); });
    // Formatting doesn't move anything, so no arrow is invalidated — pass an
    // empty touched-set to writeCells' arrow rule and repaint by hand.
    const owner = cellsOwnerId.current;
    cellsRef.current = next;
    withText.forEach((k) => {
      dirtyKeys.current.add(k);
      const el = cellEls.current[k];
      if (el) { el.innerHTML = cellToHtml(next[k] ?? ''); el.dataset.init = '1'; }
      pushLiveCell(k, cellToHtml(next[k] ?? ''));
    });
    const updated = snap.current.sheets.map((sh) => sh.id === owner ? { ...sh, cells: { ...next } } : sh);
    setSheets(updated);
    snap.current = { ...snap.current, sheets: updated };
    persist({ sheets: updated });
    recordHistory();
    return true;
  }

  // ── Dragging a selection ──────────────────────────────────────────────────

  /** The cell under the pointer, if any (used for the drop target). */
  function cellAtPoint(x: number, y: number): { ri: number; ci: number } | null {
    const el = document.elementsFromPoint(x, y)
      .find((n) => n instanceof HTMLElement && n.dataset.ri !== undefined) as HTMLElement | undefined;
    if (!el) return null;
    return { ri: Number(el.dataset.ri), ci: Number(el.dataset.ci) };
  }

  function startDragCandidate(ri: number, ci: number, e: React.MouseEvent) {
    const sel = selectionRef.current;
    if (!sel || !selHas(sel, ri, ci)) return;
    drag.current = {
      originSheetId: cellsOwnerId.current ?? '',
      col: sel.col, rows: [...sel.rows], grabRow: ri,
      payload: sel.rows.map((r) => cellsRef.current[selCellKey(r, sel.col)] ?? ''),
      startX: e.clientX, startY: e.clientY, moved: false,
    };
  }

  function endDrag() {
    if (tabHover.current) { clearTimeout(tabHover.current.timer); tabHover.current = null; }
    drag.current = null;
    setDragging(false);
    setDragPos(null);
    setDropAt(null);
    setDropTab(null);
  }

  /** Drop the carried cells onto (row, col) of whatever sheet is open now. */
  function commitDrop(targetRow: number, targetCol: number) {
    const d = drag.current;
    if (!d) return;
    const sameSheet = d.originSheetId === cellsOwnerId.current;

    if (sameSheet) {
      const plan = planDrop({ col: d.col, rows: d.rows }, d.grabRow, targetRow, targetCol, numRows, columns.length);
      if (!plan) return;
      const res = applyMove(cellsRef.current, plan, numRows);
      if (!res) return; // no room below to absorb what's already there
      writeCells(res.cells, { remap: res.shifted, dropArrows: plan.touched });
      setSelection(plan.next);
      selectionRef.current = plan.next;
      return;
    }

    // Landed on a different tab. Two sheets change: the cells arrive here, and
    // they leave the sheet they came from. Both sheets lose the arrows that
    // pointed at the cells involved.
    const shift = Math.max(-d.rows[0], Math.min(targetRow - d.grabRow, numRows - 1 - d.rows[d.rows.length - 1]));
    const rows = d.rows.map((r) => r + shift);
    const gone = new Set(d.rows.map((r) => selCellKey(r, d.col)));

    // Insert into THIS sheet, sliding its existing cells down, exactly as a
    // same-sheet move does.
    const res = applyPaste(cellsRef.current, targetCol, rows, d.payload, numRows);
    if (!res) return;
    const owner = cellsOwnerId.current;
    const prev = cellsRef.current;
    const touched = new Set([...Object.keys(prev), ...Object.keys(res.cells)]
      .filter((k) => (prev[k] ?? '') !== (res.cells[k] ?? '')));
    cellsRef.current = res.cells;
    touched.forEach((k) => {
      dirtyKeys.current.add(k);
      const el = cellEls.current[k];
      if (el) { el.innerHTML = cellToHtml(res.cells[k] ?? ''); el.dataset.init = '1'; }
      pushLiveCell(k, cellToHtml(res.cells[k] ?? ''));
    });

    const updated = snap.current.sheets.map((sh) => {
      if (sh.id === owner) {
        // Nothing to drop here — the arriving cells brought no arrows with them.
        // The cells they pushed down keep theirs, remapped to the new rows.
        const arrows = res.shifted.size
          ? (sh.arrows ?? []).map((a) => bumpArrow(a, (k) => res.shifted.get(k) ?? k))
          : sh.arrows ?? [];
        const aiCells = res.shifted.size ? sh.aiCells?.map((k) => res.shifted.get(k) ?? k) : sh.aiCells;
        return { ...sh, cells: { ...res.cells }, arrows, aiCells };
      }
      if (sh.id === d.originSheetId) {
        // The cells left this sheet, so their arrows here no longer point at
        // anything. A hole is left behind rather than closing the gap up —
        // the rows below didn't move, and pulling them up would rewrite rows
        // the user never touched.
        return { ...sh, cells: clearCells(sh.cells ?? {}, [...gone]), arrows: dropArrowsTouching(sh.arrows ?? [], gone) };
      }
      return sh;
    });
    setSheets(updated);
    snap.current = { ...snap.current, sheets: updated };
    persist({ sheets: updated });
    recordHistory();
    requestAnimationFrame(recomputeArrows);
    const next = { col: targetCol, rows };
    setSelection(next);
    selectionRef.current = next;
  }

  // Pointer handling for a drag lives on the window: the pointer leaves the
  // cell it started in immediately, and can end up over a tab or off the grid.
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d = drag.current;
      if (!d) return;
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
        d.moved = true;
        setDragging(true);
        window.getSelection()?.removeAllRanges();
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      setDragPos({ x: e.clientX, y: e.clientY });

      // Over a sheet tab? Hold there and it opens, drag still in hand.
      const tabEl = document.elementsFromPoint(e.clientX, e.clientY)
        .find((n) => n instanceof HTMLElement && n.dataset.sheetIdx !== undefined) as HTMLElement | undefined;
      const idx = tabEl ? Number(tabEl.dataset.sheetIdx) : null;
      if (idx !== null && idx !== snap.current.activeSheetIdx) {
        setDropTab(idx);
        setDropAt(null);
        if (tabHover.current?.idx !== idx) {
          if (tabHover.current) clearTimeout(tabHover.current.timer);
          tabHover.current = { idx, timer: setTimeout(() => { tabHover.current = null; switchSheet(idx); }, 450) };
        }
        return;
      }
      if (tabHover.current) { clearTimeout(tabHover.current.timer); tabHover.current = null; }
      setDropTab(null);

      const at = cellAtPoint(e.clientX, e.clientY);
      if (!at) { setDropAt(null); return; }
      const shift = Math.max(-d.rows[0], Math.min(at.ri - d.grabRow, numRows - 1 - d.rows[d.rows.length - 1]));
      setDropAt({ col: at.ci, rows: d.rows.map((r) => r + shift) });
    }
    function onUp(e: MouseEvent) {
      const d = drag.current;
      if (!d) return;
      if (!d.moved) {
        // A plain click on a selected cell, not a drag: let it go back to
        // ordinary editing rather than leaving the group stuck to the cursor.
        const at = cellAtPoint(e.clientX, e.clientY);
        endDrag();
        clearSelection();
        if (at) focusCell(selCellKey(at.ri, at.ci));
        return;
      }
      const at = cellAtPoint(e.clientX, e.clientY);
      if (at) commitDrop(at.ri, at.ci);
      endDrag();
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [columns.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Mouse-down on a cell: build/extend a selection, or start dragging one. */
  function handleCellMouseDown(ri: number, ci: number, e: React.MouseEvent) {
    if (drawMode) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey) {
      e.preventDefault(); // no caret, no focus — this is a selection gesture
      const next = toggleCell(selectionRef.current, ri, ci);
      setSelection(next);
      selectionRef.current = next;
      selAnchor.current = next ? { row: ri, col: ci } : null;
      return;
    }
    if (e.shiftKey && selAnchor.current && selAnchor.current.col === ci) {
      e.preventDefault();
      const next = rangeTo(selAnchor.current.row, ri, ci);
      setSelection(next);
      selectionRef.current = next;
      return;
    }
    if (selHas(selectionRef.current, ri, ci)) {
      // Grabbing the group. Suppressing the default also stops the browser's own
      // text-drag from starting inside the contentEditable.
      e.preventDefault();
      startDragCandidate(ri, ci, e);
      return;
    }
    if (selectionRef.current) clearSelection();
  }

  // ── Cell move ─────────────────────────────────────────────────────────────

  /**
   * ⌘↑ / ⌘↓ on a single cell (and the hover arrows). Same insert rule as a
   * group move: the cell goes into the next row and anything already there
   * slides down.
   *
   * This used to SWAP with the neighbour, which let you walk an argument past
   * the ones around it by holding ⌘↓. Inserting can't do that — the neighbour
   * is pushed along ahead of the cell instead of trading places with it — but
   * one rule for every kind of move beats two rules that disagree.
   */
  function moveCell(ri: number, ci: number, dir: 'up' | 'down') {
    const plan = planMove({ col: ci, rows: [ri] }, dir === 'up' ? -1 : 1, 0, numRows, columns.length);
    if (!plan) return;
    const res = applyMove(cellsRef.current, plan, numRows);
    if (!res) return;
    writeCells(res.cells, { remap: res.shifted, dropArrows: plan.touched });
  }

  // Insert a blank cell between rows `afterRi` and `afterRi+1` in a single column,
  // pushing that column's cells (and any arrow endpoints in it) down one. Single
  // column, not a full row — matches the hover "+" between two stacked cells: you
  // slot a missed argument into one speech's column without disturbing the others.
  function insertRowBetween(afterRi: number, ci: number) {
    const insertAt = afterRi + 1;
    if (insertAt >= numRows) return;
    // Shift bottom-up so we never overwrite a source before copying it.
    const cells = { ...cellsRef.current };
    for (let r = numRows - 1; r > insertAt; r--) {
      const src = cells[`${r - 1}-${ci}`];
      if (src !== undefined) cells[`${r}-${ci}`] = src; else delete cells[`${r}-${ci}`];
    }
    delete cells[`${insertAt}-${ci}`]; // the new blank
    cellsRef.current = cells;

    // Move arrow endpoints in this column at/below the insert point down with it.
    const bump = (key: string) => {
      const [rs, cs] = key.split('-'); const r = Number(rs), c = Number(cs);
      if (c === ci && r >= insertAt && r < numRows - 1) return `${r + 1}-${c}`;
      return key;
    };
    // By owner id, not index — an index that hasn't caught up with a tab switch
    // would write this tab's shifted cells onto a different tab.
    const s = snap.current;
    const owner = cellsOwnerId.current;
    if (!owner || !s.sheets.some((sh) => sh.id === owner)) return;
    const updated = s.sheets.map((sh) =>
      sh.id === owner
        ? {
            ...sh, cells: { ...cells },
            arrows: (sh.arrows ?? []).map((a) => bumpArrow(a, bump)),
            aiCells: sh.aiCells?.map(bump),
          }
        : sh
    );
    setSheets(updated);
    snap.current = { ...snap.current, sheets: updated };
    persist({ sheets: updated });
    recordHistory();
    if (liveRef.current) {
      for (let r = insertAt; r < numRows; r++) pushLiveCell(`${r}-${ci}`, cellToHtml(cells[`${r}-${ci}`] ?? ''));
    }
    setCellNonce((n) => n + 1);
    requestAnimationFrame(recomputeArrows);
  }

  // ── Column resize ─────────────────────────────────────────────────────────

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!resizing.current) return;
      const { idx, startX, startW } = resizing.current;
      // delta in screen px → logical px (divide by zoom factor)
      const logicalDelta = (e.clientX - startX) * 100 / snap.current.zoom;
      const newW = Math.max(60, Math.round(startW + logicalDelta));
      setColumnWidths((prev) => { const n = [...prev]; n[idx] = newW; return n; });
    }
    function onUp() {
      if (!resizing.current) return;
      resizing.current = null;
      persist();
      requestAnimationFrame(recomputeArrows);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Restore each sheet's own scroll offset when it becomes active ──────────
  // Layout effect, so the jump happens before paint rather than as a visible
  // flick. A sheet never visited lands at the top, which is what you want when
  // an off-case tab opens for the first time.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !loaded) return;
    const id = sheets[activeSheetIdx]?.id;
    const pos = id ? sheetScroll.current[id] : null;
    el.scrollTop = pos?.top ?? 0;
    el.scrollLeft = pos?.left ?? 0;
  }, [activeSheetIdx, loaded, reloadNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Recompute arrow geometry when layout/content changes ──────────────────
  useLayoutEffect(() => {
    recomputeArrows();
  }, [loaded, reloadNonce, cellNonce, activeSheetIdx, zoom, fontSize, customColumns, columnWidths, sheets, findOpen, drawMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Col menu close on outside click ──────────────────────────────────────

  useEffect(() => {
    if (colMenu === null) return;
    function h(e: MouseEvent) { if (!(e.target as HTMLElement).closest('[data-col-menu]')) setColMenu(null); }
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [colMenu]);

  // ── Column ops ────────────────────────────────────────────────────────────

  function startRenameCol(ci: number) { setColMenu(null); setRenamingCol(ci); setRenameValue(columns[ci]); }
  function commitRenameCol() {
    if (renamingCol === null) return;
    const next = [...columns]; next[renamingCol] = renameValue.trim() || columns[renamingCol];
    setCustomColumns(next); setRenamingCol(null); persist({ customColumns: next }); recordHistory();
  }
  function colorsForCount(n: number): (string | null)[] {
    const cur = snap.current.columnColors;
    return Array.from({ length: n }, (_, i) => cur[i] ?? null);
  }
  function insertColumn(at: number) {
    setColMenu(null);
    const next = [...columns]; next.splice(at, 0, `Col ${next.length + 1}`);
    const newW = [...snap.current.columnWidths]; newW.splice(at, 0, DEFAULT_COL_WIDTH);
    const newC = [...snap.current.columnColors]; newC.splice(at, 0, null);
    setCustomColumns(next); setColumnWidths(newW); setColumnColors(newC);
    persist({ customColumns: next, columnWidths: newW, columnColors: newC }); recordHistory();
  }
  function deleteColumn(ci: number) {
    setColMenu(null);
    if (columns.length <= 2) return;
    const next = columns.filter((_, i) => i !== ci);
    const newW = snap.current.columnWidths.filter((_, i) => i !== ci);
    const newC = snap.current.columnColors.filter((_, i) => i !== ci);
    setCustomColumns(next); setColumnWidths(newW); setColumnColors(newC);
    persist({ customColumns: next, columnWidths: newW, columnColors: newC }); recordHistory();
  }
  function setColumnColor(ci: number, color: string | null) {
    setColMenu(null);
    const newC = colorsForCount(columns.length); newC[ci] = color;
    setColumnColors(newC);
    persist({ columnColors: newC }); recordHistory();
  }
  function resetColumns() {
    setCustomColumns(null);
    const defW = baseCols.map(() => DEFAULT_COL_WIDTH);
    const defC = baseCols.map(() => null);
    setColumnWidths(defW); setColumnColors(defC);
    persist({ customColumns: null, columnWidths: defW, columnColors: defC }); recordHistory();
  }

  // ── Arrows ────────────────────────────────────────────────────────────────
  function setActiveSheetArrows(updater: (arrows: FlowArrow[]) => FlowArrow[]) {
    const s = snap.current;
    const owner = cellsOwnerId.current ?? s.sheets[s.activeSheetIdx]?.id;
    const updated = s.sheets.map((sh) =>
      sh.id === owner ? { ...sh, arrows: updater(sh.arrows ?? []) } : sh
    );
    setSheets(updated);
    snap.current = { ...snap.current, sheets: updated };
    persist({ sheets: updated }); recordHistory();
    requestAnimationFrame(recomputeArrows);
  }
  /** ⌘L / the toolbar button. Arms the draw layer; the next two clicks are the
   *  arrow's two ends, wherever they land. */
  function startDrawMode() {
    drawModeRef.current = true;
    setDrawMode(true);
    setDrawStart(null);
    setDrawCursor(null);
  }
  function cancelDrawMode() {
    drawModeRef.current = false;
    setDrawMode(false);
    setDrawStart(null);
    setDrawCursor(null);
  }

  /**
   * A click on an arrow's body. It does NOT delete the arrow — the × at the
   * midpoint does that (clicking the line to delete it meant any click near a
   * line, on the way to the cell under it, threw the arrow away). Instead the
   * click is handed through to whatever cell is underneath, caret and all, so
   * an arrow lying across a cell never blocks editing that cell.
   */
  function clickThroughArrow(e: React.MouseEvent) {
    const under = document.elementsFromPoint(e.clientX, e.clientY)
      .find((n) => n instanceof HTMLDivElement && n.classList.contains('flow-cell')) as HTMLDivElement | undefined;
    if (!under) return;
    under.focus({ preventScroll: true });
    const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const range = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
    const sel = window.getSelection();
    if (range && sel && under.contains(range.startContainer)) { sel.removeAllRanges(); sel.addRange(range); }
  }

  /**
   * A click on the draw layer. The point is taken from the pointer and nothing
   * else — no nearest-cell search, no snapping, no rounding to a row. Stored as
   * a fraction of the content box so it stays put when the grid is zoomed or the
   * columns are resized (see src/lib/flowArrowGeo.ts).
   */
  function handleDrawClick(e: React.MouseEvent) {
    const content = gridContentRef.current;
    if (!content) return;
    const base = content.getBoundingClientRect();
    const fx = toFraction(e.clientX - base.left, base.width);
    const fy = toFraction(e.clientY - base.top, base.height);
    if (!drawStart) { setDrawStart({ fx, fy }); return; }
    // A second click in the same spot is a cancel, not a zero-length arrow.
    const dx = (fx - drawStart.fx) * base.width;
    const dy = (fy - drawStart.fy) * base.height;
    if (Math.hypot(dx, dy) < 4) { cancelDrawMode(); return; }
    const from = drawStart;
    setActiveSheetArrows((arr) => [
      ...arr,
      { id: crypto.randomUUID(), fx1: from.fx, fy1: from.fy, fx2: fx, fy2: fy },
    ]);
    cancelDrawMode();
  }
  function deleteArrow(id: string) {
    setActiveSheetArrows((arr) => arr.filter((a) => a.id !== id));
  }
  function recomputeArrows() {
    const content = gridContentRef.current;
    const arrows = snap.current.sheets[snap.current.activeSheetIdx]?.arrows ?? [];
    if (!content || arrows.length === 0) { setArrowGeo([]); return; }
    const base = content.getBoundingClientRect();
    const geo: { id: string; d: string; mx: number; my: number }[] = [];
    for (const a of arrows) {
      // A hand-drawn arrow owns its endpoints outright — no cell lookup, no
      // nearest-cell snap, no edge routing. Straight from point to point,
      // exactly where it was clicked.
      if (isFreeArrow(a)) {
        const x1 = fromFraction(a.fx1!, base.width), y1 = fromFraction(a.fy1!, base.height);
        const x2 = fromFraction(a.fx2!, base.width), y2 = fromFraction(a.fy2!, base.height);
        geo.push({ id: a.id, d: straightPath(x1, y1, x2, y2), mx: (x1 + x2) / 2, my: (y1 + y2) / 2 });
        continue;
      }
      if (!isCellArrow(a)) continue;
      const fe = cellEls.current[a.from!];
      const te = cellEls.current[a.to!];
      if (!fe || !te) continue;
      const fr = fe.getBoundingClientRect();
      const tr = te.getBoundingClientRect();

      // Arrows are STRAIGHT lines, edge to edge. A curve reads as decoration on
      // a paper-style flow and, over a long vertical gap, sweeps across the
      // cells in between and obscures them — a debater just needs to see that
      // A points at B.
      let x1: number, y1: number, x2: number, y2: number;
      const sameColumn = Math.abs(fr.left - tr.left) < 2;
      if (sameColumn) {
        // Stacked in one column (an answer that couldn't share its target's
        // row): run the line down the column's right edge so it doesn't cut
        // through the text of the cells between them.
        const edge = Math.max(fr.right, tr.right) - base.left - 6;
        x1 = edge; y1 = fr.top + fr.height / 2 - base.top;
        x2 = edge; y2 = tr.top + tr.height / 2 - base.top;
      } else {
        // Start at the source's facing edge, end at the target's facing edge.
        const targetLeft = tr.left + tr.width / 2 < fr.left + fr.width / 2;
        x1 = (targetLeft ? fr.left : fr.right) - base.left;
        y1 = fr.top + fr.height / 2 - base.top;
        x2 = (targetLeft ? tr.right : tr.left) - base.left;
        y2 = tr.top + tr.height / 2 - base.top;
      }
      geo.push({
        id: a.id,
        d: straightPath(x1, y1, x2, y2),
        mx: (x1 + x2) / 2,
        my: (y1 + y2) / 2,
      });
    }
    setArrowGeo(geo);
  }

  // ── Find ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!findOpen || !findQuery.trim()) { setFindMatches([]); setFindIdx(0); return; }
    const q = findQuery.toLowerCase();
    const out: { sheetIdx: number; key: string }[] = [];
    snap.current.sheets.forEach((sh, si) => {
      const cells = sh.id === cellsOwnerId.current ? cellsRef.current : sh.cells;
      for (const [key, val] of Object.entries(cells)) {
        if (htmlToText(val).toLowerCase().includes(q)) out.push({ sheetIdx: si, key });
      }
    });
    setFindMatches(out);
    setFindIdx(0);
  }, [findQuery, findOpen, activeSheetIdx, reloadNonce, cellNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  function gotoMatch(idx: number) {
    const m = findMatches[idx];
    if (!m) return;
    if (m.sheetIdx !== activeSheetIdx) { switchSheet(m.sheetIdx); }
    requestAnimationFrame(() => {
      const el = cellEls.current[m.key];
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
  function findNext(dir: 1 | -1) {
    if (findMatches.length === 0) return;
    const next = (findIdx + dir + findMatches.length) % findMatches.length;
    setFindIdx(next); gotoMatch(next);
  }
  function closeFind() { setFindOpen(false); setFindQuery(''); setFindMatches([]); }

  // Paint find hits with the CSS Custom Highlight API rather than wrapping them
  // in <mark>. Cell HTML is user content that gets persisted and broadcast to
  // live teammates, so mutating it to show a search hit would write the
  // highlight into the document itself. Highlight ranges live outside the DOM
  // and disappear the moment they're cleared, touching nothing.
  useLayoutEffect(() => {
    const highlights = (window as any).CSS?.highlights;
    const Ctor = (window as any).Highlight;
    if (!highlights || !Ctor) return; // engine without the API: scroll-into-view still works
    highlights.delete(FIND_HL);
    highlights.delete(FIND_HL_CURRENT);
    const q = findQuery.trim().toLowerCase();
    if (!findOpen || !q) return;

    // Only the active sheet is mounted, so only its hits can be painted; the
    // rest are reached by stepping through matches (which switches sheets).
    const cur = findMatches[findIdx];
    const currentKey = cur && cur.sheetIdx === activeSheetIdx ? cur.key : null;
    const rest: Range[] = [];
    const current: Range[] = [];

    for (const [key, el] of Object.entries(cellEls.current)) {
      if (!el || !el.isConnected) continue;
      for (const r of matchRangesIn(el, q)) (key === currentKey ? current : rest).push(r);
    }
    if (rest.length) highlights.set(FIND_HL, new Ctor(...rest));
    if (current.length) highlights.set(FIND_HL_CURRENT, new Ctor(...current));
  }, [findOpen, findQuery, findIdx, findMatches, activeSheetIdx, cellNonce, reloadNonce]);

  // Highlight registries are global to the document — drop ours on unmount so
  // they can't outlive the flow view.
  useEffect(() => () => {
    const highlights = (window as any).CSS?.highlights;
    highlights?.delete(FIND_HL);
    highlights?.delete(FIND_HL_CURRENT);
  }, []);

  // ── Sheet ops ─────────────────────────────────────────────────────────────

  function flushAndGetSheets(): SheetData[] {
    return flushInto(snap.current.sheets);
  }

  // Snapshot the flow once, when the Analyze Round panel opens — not on every
  // FlowView render while it's open. FlowView re-renders on every keystroke

  // Stash where the current sheet is scrolled to, before anything moves.
  function rememberScroll() {
    const el = containerRef.current;
    const id = snap.current.sheets[snap.current.activeSheetIdx]?.id;
    if (el && id) sheetScroll.current[id] = { top: el.scrollTop, left: el.scrollLeft };
  }

  function switchSheet(idx: number) {
    if (idx === activeSheetIdx) return;
    rememberScroll();
    const saved = flushAndGetSheets();
    setSheets(saved);
    // When live, the Y.Doc is the source of truth — a sheet we left may have
    // received remote edits while it was inactive, so read its cells back from
    // the doc rather than the (possibly stale) local snapshot.
    const handle = syncRef.current;
    const targetId = saved[idx]?.id;
    if (liveRef.current && handle && targetId) {
      const sheet = findSheet(handle.doc, targetId);
      const cells: Record<string, string> = {};
      if (sheet) sheetCells(sheet).forEach((t, k) => { const v = t.toString(); if (v) cells[k] = v; });
      cellsRef.current = cells;
    } else {
      cellsRef.current = saved[idx]?.cells ?? {};
    }
    cellsOwnerId.current = targetId ?? null;
    dirtyKeys.current.clear(); // the buffer we just flushed is about to be persisted below
    setActiveSheetIdx(idx);
    // Same hand-update the other sheet ops do, so anything that runs before the
    // commit (a pending save timer, an arrow recompute) sees the new tab.
    snap.current = { ...snap.current, sheets: saved, activeSheetIdx: idx };
    setCellNonce((n) => n + 1);
    persist({ sheets: saved });
  }

  // Sheet-level ops (add/delete/rename below) go through undo history like any
  // cell edit — deleting a tab full of arguments used to be unrecoverable.
  // `snap.current` normally catches up in a post-render effect, so each op
  // updates it by hand before recordHistory() — otherwise the snapshot taken
  // here would still hold the PRE-op sheets and undo would appear to do nothing.

  function addSheet() {
    rememberScroll();
    const saved = flushAndGetSheets();
    const neo: SheetData = { id: crypto.randomUUID(), name: `Sheet ${saved.length + 1}`, cells: {} };
    const next = [...saved, neo];
    setSheets(next); cellsRef.current = {}; cellsOwnerId.current = neo.id; setActiveSheetIdx(next.length - 1);
    snap.current = { ...snap.current, sheets: next, activeSheetIdx: next.length - 1 };
    persist({ sheets: next });
    recordHistory();
  }

  /**
   * Copy a tab and everything on it — cells, arrows, and the Auto Flow marks —
   * inserting the copy directly after the original. Arrows are cell-to-cell by
   * key, so they survive the copy untouched; only the sheet's id changes, and
   * it must, or the two tabs would be the same sheet as far as live sync and
   * the cell buffer are concerned.
   */
  function duplicateSheet(idx: number) {
    const saved = flushAndGetSheets();
    const src = saved[idx];
    if (!src) return;
    const copy: SheetData = {
      ...src,
      id: crypto.randomUUID(),
      name: `${src.name} copy`.slice(0, 40),
      cells: { ...src.cells },
      arrows: (src.arrows ?? []).map((a) => ({ ...a })),
      aiCells: src.aiCells ? [...src.aiCells] : undefined,
      // The summary describes the original's contents, and re-deriving it costs
      // an API call — but leaving it attached would show a stale summary for a
      // tab the user is about to edit. Drop it and let it regenerate on hover.
      aiSummary: undefined,
      aiSummarySource: undefined,
    };
    const next = [...saved.slice(0, idx + 1), copy, ...saved.slice(idx + 1)];
    const newIdx = idx + 1;
    setSheets(next);
    cellsRef.current = { ...copy.cells };
    cellsOwnerId.current = copy.id;
    setActiveSheetIdx(newIdx);
    snap.current = { ...snap.current, sheets: next, activeSheetIdx: newIdx };
    persist({ sheets: next });
    recordHistory();
    setCellNonce((n) => n + 1);
  }

  function deleteSheet(idx: number) {
    if (sheets.length <= 1) return;
    rememberScroll();
    const saved = flushAndGetSheets();
    const goneName = saved[idx]?.name;
    const gone = saved[idx]?.id;
    if (gone) delete sheetScroll.current[gone];
    const next = saved.filter((_, i) => i !== idx);
    // Keep pointing at the SAME sheet after removal: deleting a tab before the
    // active one shifts everything down by one, so decrement in that case.
    // (Previously `min(activeSheetIdx, len-1)` left the index unchanged, jumping
    // the view forward to a different sheet.)
    const shifted = idx < activeSheetIdx ? activeSheetIdx - 1 : activeSheetIdx;
    const newIdx = Math.max(0, Math.min(shifted, next.length - 1));
    setSheets(next); cellsRef.current = next[newIdx]?.cells ?? {}; cellsOwnerId.current = next[newIdx]?.id ?? null; setActiveSheetIdx(newIdx);
    snap.current = { ...snap.current, sheets: next, activeSheetIdx: newIdx };
    persist({ sheets: next });
    recordHistory();
    // Reuses the sheet op's own undo-history entry (see the comment above this
    // function) rather than a separate snapshot — deleteSheet already records one.
    if (goneName) pushUndoToast(`Deleted "${goneName}"`, () => undo());
  }

  // Drag-to-reorder tabs. Flush the live sheet first so no in-progress typing is
  // lost, move the sheet from `from` to `to`, and keep the view on the SAME sheet
  // by id (its index shifts when tabs move around it). Undoable like the other
  // sheet ops — snap.current is updated by hand before recordHistory for the same
  // reason (the post-render effect hasn't run yet).
  function reorderSheet(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    const saved = flushAndGetSheets();
    if (from >= saved.length || to >= saved.length) return;
    const activeId = saved[activeSheetIdx]?.id;
    const next = [...saved];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const newActive = Math.max(0, next.findIndex((s) => s.id === activeId));
    setSheets(next);
    cellsRef.current = next[newActive]?.cells ?? {}; cellsOwnerId.current = next[newActive]?.id ?? null;
    setActiveSheetIdx(newActive);
    snap.current = { ...snap.current, sheets: next, activeSheetIdx: newActive };
    persist({ sheets: next });
    recordHistory();
  }

  // Sheet ids currently generating a fresh AI tab summary — drives the
  // "Warroom AI is summarizing…" line in the tooltip below and prevents two
  // overlapping hovers from firing the same request twice.
  const [generatingSummary, setGeneratingSummary] = useState<Set<string>>(new Set());

  // Called when a tab is hovered. Genuinely generates the tab's AI summary via
  // Warroom AI the first time it's hovered after its content has changed —
  // NOT preloaded, since regenerating on every keystroke across every tab
  // would be wasteful API spend for a summary most hovers never look at; a
  // hover is exactly the signal that this summary is about to be read. Once
  // generated it's cached (`aiSummary` + the content signature it was built
  // from) and reused on every later hover until the sheet's content actually
  // changes again. Auto Flow's opt-in per-card summary mode can also populate
  // `aiSummary` directly at write time (folded from summaries already
  // generated then, no extra call) — either way this function treats it the
  // same: fresh if the signature still matches, stale (and worth
  // regenerating) if not.
  async function ensureSheetSummary(idx: number) {
    // Settings → AI → "Summarise a tab when I hover it". Off = never call the model
    // from a hover, full stop — the tooltip just falls back to its free local
    // tag preview (see sheetSummary below). A previously-cached aiSummary from
    // before the toggle was flipped off still displays; this only stops NEW
    // generation, since showing a summary that already exists costs nothing.
    if (!readFlowPrefs().aiTabSummaries) return;
    const cur = snap.current;
    const sheet = cur.sheets[idx];
    if (!sheet) return;
    // Only tabs Auto Flow built. A tab the debater typed themselves is already
    // in their own words — summarizing it back to them is an API call that buys
    // nothing, and on a hand-built flow that's one call per tab hovered.
    if (!wasAutoFlowed(sheet)) return;
    // Give up for the rest of the session once the quota/API is clearly unhappy,
    // and back off per-sheet after a failure. Without this, a FAILED summary
    // never caches a signature, so every single hover started a brand-new
    // 4-attempt retry ladder — which is what turned one dead API key or an
    // exhausted quota into an endless stream of toasts while flowing.
    if (summaryDisabled.current) return;
    const until = summaryCooldown.current.get(sheet.id) ?? 0;
    if (Date.now() < until) return;

    const cells = sheet.id === cellsOwnerId.current ? cellsRef.current : sheet.cells;
    // Read only the speech that INTRODUCED the position — the 1AC for an
    // advantage, the 1NC for an off-case. A tab also holds every answer to that
    // position, and feeding those in summarized the argument's whole history
    // instead of the argument.
    const col = summaryColumnFor(sheet.autoFlowRole, columns, flowEvent);
    const entries = summaryEntries(cells, col, htmlToText);
    if (entries.length === 0) return; // nothing in that column to summarize
    // Signed over the entries actually sent, so answers typed into a later
    // column don't invalidate a summary they can't change.
    const sig = summarySignature(entries);
    if (sheet.aiSummary && sheet.aiSummarySource === sig) return; // already fresh
    if (generatingSummary.has(sheet.id)) return; // already in flight

    setGeneratingSummary((g) => new Set(g).add(sheet.id));
    try {
      const res = await summarizeFlowSheet({ sheetName: sheet.name, event: flowEvent, entries });
      if (res?.ok && typeof res.summary === 'string' && res.summary.trim()) {
        const updated = snap.current.sheets.map((sh) =>
          sh.id === sheet.id ? { ...sh, aiSummary: res.summary.trim(), aiSummarySource: sig } : sh
        );
        setSheets(updated);
        snap.current = { ...snap.current, sheets: updated };
        persist(); // no `sheets` override — flushInto() matches by owner id, so this can't clobber live typing
      }
      // The provider's own error text is surfaced by the global AI-error toast;
      // here we only record that it failed so we stop asking on every hover.
    } catch (e: any) { noteSummaryFailure(sheet.id, e?.message); }
    finally {
      setGeneratingSummary((g) => { const next = new Set(g); next.delete(sheet.id); return next; });
    }
  }

  /**
   * Record a failed tab-summary attempt so hovering doesn't keep re-firing it.
   * A quota/rate-limit/auth failure won't fix itself by being asked again mid-
   * round, so those switch the whole feature off for the session (the tooltip
   * silently falls back to its local, non-AI tag preview — nothing breaks).
   * Anything else just backs that one sheet off for 10 minutes.
   */
  function noteSummaryFailure(sheetId: string, message?: string) {
    const m = String(message ?? '').toLowerCase();
    // Anything the provider REJECTED (as opposed to failed to answer) will be
    // rejected again on the next hover: a bad key, no quota, a region Gemini
    // won't serve ("User location is not supported" — a 400 FAILED_PRECONDITION),
    // a model that doesn't exist, a prompt over the context limit. One of those
    // used to only back off the one tab for 10 minutes, so every OTHER tab the
    // user hovered mid-round fired the same doomed call and the same toast.
    if (/\b(400|401|403|404|429)\b/.test(m)
      || m.includes('resource_exhausted') || m.includes('quota') || m.includes('rate limit')
      || m.includes('api key') || m.includes('permission') || m.includes('no_key')
      || m.includes('failed_precondition') || m.includes('invalid_argument') || m.includes('unauthenticated')
      || m.includes('location') || m.includes('not supported') || m.includes('not found')
      || m.includes('context') || m.includes('too large') || m.includes('rejected the request')) {
      summaryDisabled.current = true;
      return;
    }
    summaryCooldown.current.set(sheetId, Date.now() + 10 * 60_000);
  }

  // Short, wide summary of a tab's content for its hover tooltip. `sheet.aiSummary`
  // — whether folded from Auto Flow's per-card summaries or generated live by
  // ensureSheetSummary above — leads the tooltip when present, marked so it
  // reads as AI content. While a fresh one is being generated, that's shown
  // instead of stale/no content. Otherwise this falls back to a cheap local
  // read of the cells (first line of each = the tag) — fires on every hover,
  // no AI involved. For the ACTIVE tab the live edits live in cellsRef, not
  // the (stale-until-save) sheet.cells.
  function sheetSummary(idx: number): string {
    const s = snap.current;
    const sheet = s.sheets[idx];
    if (!sheet) return '';
    const cells = sheet.id === cellsOwnerId.current ? cellsRef.current : sheet.cells;
    const entries = Object.entries(cells)
      .map(([key, html]) => {
        const [r, c] = key.split('-').map(Number);
        return { r, c, text: htmlToText(String(html ?? '')).split('\n')[0].trim() };
      })
      .filter((e) => e.text)
      .sort((a, b) => a.c - b.c || a.r - b.r);
    // The AI line only ever belongs to an auto-flowed tab. Gating the DISPLAY
    // too (not just generation) is what clears a stale summary off a hand-typed
    // tab that got one before this rule existed — otherwise it would sit there
    // forever, since nothing would ever regenerate it.
    const eligible = wasAutoFlowed(sheet);
    const generating = eligible && generatingSummary.has(sheet.id);
    const aiLine = generating
      ? '✨ Summarizing this tab…'
      : (eligible && sheet.aiSummary?.trim() ? `✨ ${sheet.aiSummary.trim()}` : '');
    if (entries.length === 0) return aiLine || 'Empty';
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const e of entries) {
      const k = e.text.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      tags.push(e.text.length > 54 ? e.text.slice(0, 53) + '…' : e.text);
      if (tags.length >= (aiLine ? 2 : 3)) break; // leave room for the AI line + tab name
    }
    const more = entries.length - tags.length;
    const rest = tags.join('\n') + (more > 0 ? `\n+${more} more` : '');
    return aiLine ? `${aiLine}\n${rest}` : rest;
  }

  function startRenameSheet(idx: number) { setRenamingSheet(idx); setRenameValue(sheets[idx]?.name ?? ''); }

  /**
   * Rename the still-default advantage tabs to the stock issues and flip the
   * flow's layout, in one click.
   *
   * Deliberately NOT `changeVariant`: that rebuilds the sheet list from the
   * layout defaults and so refuses to run once the flow has any content. This
   * only ever *renames* tabs that still carry a default name, so cells, arrows,
   * off-case tabs, and anything the user named themselves all survive — which
   * means it is safe on a flow already part-way through a round.
   */
  function applyStockIssuePlan(plan: StockIssuePlan) {
    // Closing the rename input can fire its onBlur on the way out, and that
    // handler still closes over the OLD renamingSheet/renameValue — so it would
    // write the half-typed "inh" straight back over the "Inherency" this just
    // set. One-shot flag, cleared by the commit it suppresses.
    skipNextRenameCommit.current = true;
    const saved = flushAndGetSheets();
    const next = saved.map((sh, i) => ({ ...sh, name: plan.names[i] ?? sh.name }));
    setSheets(next);
    setVariant('stock-issues');
    setRenamingSheet(null);
    snap.current = { ...snap.current, sheets: next, variant: 'stock-issues' };
    persist({ sheets: next, variant: 'stock-issues' });
    recordHistory();
  }

  function commitRenameSheet() {
    if (skipNextRenameCommit.current) { skipNextRenameCommit.current = false; return; }
    if (renamingSheet === null) return;
    const saved = flushAndGetSheets();
    const next = saved.map((s, i) => i === renamingSheet ? { ...s, name: renameValue.trim() || s.name } : s);
    setSheets(next); setRenamingSheet(null);
    snap.current = { ...snap.current, sheets: next };
    persist({ sheets: next });
    recordHistory();
  }

  // ── Font / zoom ───────────────────────────────────────────────────────────

  function changeFontSize(delta: number) {
    const next = Math.min(20, Math.max(9, fontSize + delta));
    setFontSize(next); persist({ fontSize: next });
  }

  function changeZoom(next: number) {
    const clamped = Math.max(20, Math.min(200, next));
    setZoom(clamped); persist({ zoom: clamped });
  }

  function fitZoom() {
    if (!containerRef.current) return;
    const cw = containerRef.current.clientWidth;
    const totalLogical = snap.current.columnWidths.reduce((a, b) => a + b, 0);
    if (totalLogical === 0) return;
    const proposed = Math.round((cw / totalLogical) * 100);
    // Skip a no-op (or near-no-op) update — the auto-fit ResizeObserver below
    // calls this on every container resize, and applying a zoom change can
    // itself toggle a scrollbar and resize the container again. A >=1pt
    // threshold means that settles instead of jittering indefinitely.
    if (Math.abs(proposed - snap.current.zoom) < 1) return;
    changeZoom(proposed);
  }

  // Fit columns to the window on open.
  // Gated on `loaded` so it runs *after* the async data load — otherwise it reads
  // empty column widths (total 0) and bails, leaving the flow stuck at 100% zoom.
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(fitZoom, 60);
    return () => clearTimeout(t);
  }, [loaded, reloadNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Columns always fill the available width, keeping their sizes relative to
  // each other — collapsing the sidebar, resizing the window, or the chat panel
  // opening/closing all free up (or eat) horizontal space, and this keeps the
  // sheet stretched to meet the new edge instead of leaving a dead gap (or
  // overflowing) until the next manual "Fit to window". A ResizeObserver on the
  // grid container catches every cause at once — no need to separately listen
  // for sidebar toggles or window resize. Debounced (150ms trailing) so a
  // dragged window edge or an animated sidebar collapse doesn't fire fitZoom
  // (which persists — and, when live, broadcasts — a zoom change) once per
  // frame.
  useEffect(() => {
    if (!loaded) return;
    const el = containerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      // Read live, not once at mount — Settings → Appearance's "Auto-fit columns"
      // toggle should take effect on the very next resize, not just for flows
      // opened after the change.
      if (!readFlowPrefs().autoFitColumns) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(fitZoom, 150);
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Variant / PF order ────────────────────────────────────────────────────

  // Is there any text anywhere in the flow? (active sheet reads live cellsRef,
  // other sheets read their saved cells.) Used to hide the variant switcher once
  // there's content, since switching variant rebuilds sheets from defaults.
  function flowHasAnyContent(): boolean {
    const s = snap.current;
    return s.sheets.some((sh) => {
      const cells = sh.id === cellsOwnerId.current ? cellsRef.current : (sh.cells ?? {});
      return Object.values(cells).some((v) => typeof v === 'string' && v.trim() !== '');
    });
  }

  function changeVariant(v: PolicyVariant) {
    // Refuse once there's content — switching rebuilds sheets from the default
    // names for the variant, which would drop extra/renamed tabs. The toolbar
    // hides the switcher in this case; this is the safety net for the brief
    // window before a re-render catches up.
    if (flowHasAnyContent()) return;
    // Flush the active sheet's live edits into the sheets array first
    const flushedSheets = flushAndGetSheets();
    // Rebuild with new tab names but carry cell content forward by position
    const newSheets = makeSheets('policy', v).map((newSheet, i) => ({
      ...newSheet,
      cells: flushedSheets[i]?.cells ?? {},
    }));
    setVariant(v);
    setSheets(newSheets);
    // Keep the same active position; update cellsRef to that sheet's content
    cellsRef.current = newSheets[snap.current.activeSheetIdx]?.cells ?? {}; cellsOwnerId.current = newSheets[snap.current.activeSheetIdx]?.id ?? null;
    snap.current = { ...snap.current, sheets: newSheets, variant: v };
    persist({ variant: v, sheets: newSheets });
    recordHistory();
  }

  // ── Flow meta (name/event) ────────────────────────────────────────────────

  function updateFlowMeta(updates: Partial<FlowMeta>) {
    const newIndex = flowsIndex.map((f) => f.id === flowId ? { ...f, ...updates } : f);
    setFlowsIndex(newIndex);
    writeKey('flows_index', newIndex);
  }

  function commitFlowRename() {
    const trimmed = renameValue.trim();
    if (trimmed) updateFlowMeta({ name: trimmed });
    setRenamingFlow(false);
  }

  // ── xlsx export ───────────────────────────────────────────────────────────

  async function buildXlsxBase64(): Promise<string> {
    const allSheets = flushAndGetSheets();
    return flowDataToXlsxBase64({
      event: flowEvent,
      variant, pfOrder, customColumns, columnWidths, columnColors, fontSize, zoom,
      sheets: allSheets,
    });
  }

  // A page can't choose where a file lands, so export is a download. Warroom's
  // "open in Excel" and "send to Google Sheets" needed a desktop shell and an
  // OAuth session respectively, and neither survives the move to a tab — the
  // .xlsx this writes opens in both.
  async function exportXlsx() {
    const base64 = await buildXlsxBase64();
    const flowName = (flowMeta?.name ?? 'flow').replace(/[\\/:*?[\]]/g, '_');
    saveBase64(base64, `${flowName}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  // ── Empty state ───────────────────────────────────────────────────────────

  if (!flowId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
        <div className="text-sm font-medium text-ink/60">No flow selected</div>
        <div className="text-xs text-ink/35 text-center max-w-xs">
          Press the <span className="font-bold">+</span> next to <span className="font-bold">Flow</span> in the sidebar to create your first flow sheet.
        </div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm" style={{ color: 'var(--placeholder)' }}>
        Loading flow…
      </div>
    );
  }

  /**
   * Grow the grid. Rows are only ever added at the BOTTOM, so nothing already
   * on the flow moves — no cell key changes, and no arrow needs remapping,
   * which is what makes this safe to do mid-round.
   */
  function addRows(count: number) {
    const n = Math.floor(Number(count));
    if (!Number.isFinite(n) || n < 1) return;
    const next = Math.min(MAX_ROWS, numRows + n);
    if (next === numRows) return;
    setNumRows(next);
    // snap.current is refreshed by a layout effect, i.e. after this returns —
    // so update it by hand before recording, exactly as changeVariant and
    // insertRowBetween do. recordHistory() goes LAST: this file's convention is
    // to snapshot the state AFTER a change, and recording before it instead
    // makes undo land a step off (adding 5 twice, then undoing once, jumped
    // straight past the intermediate count).
    snap.current = { ...snap.current, numRows: next };
    persist({ numRows: next });
    recordHistory();
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const flowHasContent = flowHasAnyContent();

  // Live while a tab rename is open: does what's being typed look like a stock
  // issue, on a flow still using the advantage layout? Null the rest of the time.
  const stockIssuePlan: StockIssuePlan | null =
    (!stockIssueDismissed && flowEvent === 'policy' && variant === 'advantage' && renamingSheet !== null)
      ? planStockIssueConversion(sheets.map((sh) => sh.name), renamingSheet, renameValue)
      : null;

  return (
    <div className="flex flex-col h-full relative" style={{ background: 'var(--bg-main)' }}>

      {/* ── Top bar ── */}
      <div
        className="flex items-center gap-1 px-2.5 py-1 flex-shrink-0 flex-wrap"
        style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', minHeight: 38 }}
      >
        {/* Home. This row is now the app's only chrome — the separate bar above
            it held nothing but a wordmark and a Settings link, and cost 52px of
            vertical space on every screen. */}
        <Tooltip text="Your flows">
          <button
            className="btn-icon flex items-center shrink-0 pr-1"
            onClick={() => setView({ kind: 'home' })}
            aria-label="Your flows"
          >
            <Logo size={20} />
          </button>
        </Tooltip>

        {/* Flow name */}
        {renamingFlow ? (
          <input
            ref={flowNameInputRef}
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitFlowRename}
            onKeyDown={(e) => { if (e.key === 'Enter') commitFlowRename(); if (e.key === 'Escape') setRenamingFlow(false); }}
            className="input text-sm font-semibold w-40"
          />
        ) : (
          <Tooltip text="Double-click to rename">
            <button
              className="text-sm font-semibold text-ink hover:opacity-70 transition-opacity truncate max-w-[140px]"
              onDoubleClick={() => { setRenamingFlow(true); setRenameValue(flowMeta?.name ?? 'Untitled Flow'); }}
            >
              {flowMeta?.name ?? 'Untitled Flow'}
            </button>
          </Tooltip>
        )}


        <div className="flex-1" />

        {/* Emphasis */}
        {/* Emphasis — each lights up while the caret sits in text that has it,
            so what the next keystroke will look like is readable at a glance. */}
        <ToolBtn onMouseDown={(e) => { e.preventDefault(); applyFormat('bold'); }} title="Bold (⌘B)" active={fmt.bold}>
          <span style={{ fontWeight: 800, fontSize: 13 }}>B</span>
        </ToolBtn>
        <ToolBtn onMouseDown={(e) => { e.preventDefault(); applyFormat('italic'); }} title="Italic (⌘I)" active={fmt.italic}>
          <span style={{ fontStyle: 'italic', fontFamily: 'Georgia, serif', fontSize: 13 }}>I</span>
        </ToolBtn>
        <ToolBtn onMouseDown={(e) => { e.preventDefault(); applyFormat('underline'); }} title="Underline (⌘U)" active={fmt.underline}>
          <span style={{ textDecoration: 'underline', fontSize: 13 }}>U</span>
        </ToolBtn>
        <ToolBtn onMouseDown={(e) => { e.preventDefault(); applyFormat('strikeThrough'); }} title="Strikethrough (⌘⇧X)" active={fmt.strike}>
          <span style={{ textDecoration: 'line-through', fontSize: 13 }}>S</span>
        </ToolBtn>

        {customColumns && (
          <ToolBtn onClick={resetColumns} title="Reset columns"><IcoResetCols /></ToolBtn>
        )}

        <ToolDivider />

        {/* Undo / Redo */}
        <ToolBtn onClick={undo} title="Undo (⌘Z)" disabled={!canUndo}><IcoUndo /></ToolBtn>
        <ToolBtn onClick={redo} title="Redo (⌘⇧Z)" disabled={!canRedo}><IcoRedo /></ToolBtn>

        <ToolDivider />

        {/* Find */}
        <ToolBtn onClick={() => { setFindOpen(true); setTimeout(() => findInputRef.current?.focus(), 0); }} active={findOpen} title="Find (⌘F)"><IcoFind /></ToolBtn>

        {/* Draw arrow */}
        <ToolBtn
          onClick={() => { if (drawMode) cancelDrawMode(); else startDrawMode(); }}
          active={drawMode}
          title={drawMode ? 'Click the start, then the end — Esc to cancel' : 'Draw an arrow (⌘L)'}
        >
          <IcoArrow />
        </ToolBtn>

        {/* Share — also where going live now starts (was a separate button; both
            led to the same panel, so they're one button now). */}
        <div className="relative shrink-0">
          <ToolBtn onClick={() => setShareOpen(true)} title="Share / Collaborate"><ShareIcon /></ToolBtn>
          {flowMeta?.shared && (
            <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full pointer-events-none" style={{ background: 'var(--accent)' }} />
          )}
        </div>

      </div>

      {/* Find bar */}
      {findOpen && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)' }}
        >
          <IcoFind />
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey ? -1 : 1); }
              if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
            }}
            placeholder="Find across all tabs…"
            className="input text-sm flex-1 max-w-xs"
            autoFocus
          />
          <span className="text-xs tabular-nums shrink-0" style={{ color: 'var(--label-color)' }}>
            {findMatches.length ? `${findIdx + 1} / ${findMatches.length}` : (findQuery ? 'No matches' : '')}
          </span>
          <button className="btn px-2 py-0.5 text-sm" onClick={() => findNext(-1)} title="Previous (⇧⏎)" disabled={!findMatches.length}>↑</button>
          <button className="btn px-2 py-0.5 text-sm" onClick={() => findNext(1)} title="Next (⏎)" disabled={!findMatches.length}>↓</button>
          <button className="btn px-2 py-0.5 text-sm" onClick={closeFind} title="Close (Esc)">✕</button>
        </div>
      )}

      {/* Share panel */}
      {shareOpen && flowId && (
        <SharePanel
          name={flowMeta?.name ?? 'Untitled Flow'}
          live={live}
          shareToken={flowMeta?.shareToken}
          starting={liveStarting}
          onGoLive={startLiveCollab}
          onExportXlsx={exportXlsx}
          onClose={() => setShareOpen(false)}
        />
      )}

      {/* ── Grid ── */}
      {/* The wrapper exists so the draw-mode pill can float OVER the grid. It
          used to be a banner row above the grid, which pushed the whole flow
          down the moment ⌘L was pressed and back up on the second click —
          the flow jumping twice per arrow. */}
      <div className="relative flex-1 min-h-0 flex flex-col">
      {drawMode && (
        <div
          className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1 text-xs rounded-full shadow-lg glass-elevated pointer-events-auto"
          style={{ top: 8, zIndex: 30, color: 'var(--nav-active-color)', border: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}
        >
          <IcoArrow />
          {drawStart ? 'Now click where it should end' : 'Click where the arrow should start'}
          <span style={{ opacity: 0.6 }}>· Esc to cancel</span>
          <Tooltip text="Cancel (Esc)">
            <button className="btn px-1.5 py-0 text-[11px] leading-5" onMouseDown={(e) => e.preventDefault()} onClick={cancelDrawMode}>✕</button>
          </Tooltip>
        </div>
      )}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto scroll-thin"
        style={{ background: 'var(--bg-main)' }}
        onScroll={() => { rememberScroll(); requestAnimationFrame(recomputeArrows); }}
      >
        <div ref={gridContentRef} className="relative" style={{ minWidth: totalWidth + 'px' }}>

          {/* Arrow overlay — also carries the rubber-band preview while drawing */}
          {(arrowGeo.length > 0 || (drawMode && !!drawStart)) && (
            <svg
              className="absolute inset-0"
              style={{ width: '100%', height: '100%', pointerEvents: 'none', zIndex: 15, overflow: 'visible' }}
            >
              <defs>
                <marker id="wr-arrowhead" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="var(--nav-active-color)" />
                </marker>
              </defs>
              {arrowGeo.map((g) => {
                const hov = hoveredArrow === g.id;
                return (
                  <g key={g.id}>
                    {/* Visible arrow — fades when hovered so content underneath is readable */}
                    <path
                      d={g.d} fill="none" stroke="var(--nav-active-color)" strokeWidth={2}
                      markerEnd="url(#wr-arrowhead)" opacity={hov ? 0.35 : 0.85}
                      style={{ pointerEvents: 'none', transition: 'opacity 0.12s' }}
                    />
                    {/* Invisible hit area for the hover fade. A click here goes
                        THROUGH to the cell underneath (see clickThroughArrow);
                        only the × deletes. */}
                    <path
                      d={g.d} fill="none" stroke="transparent" strokeWidth={12}
                      style={{ pointerEvents: 'stroke', cursor: 'text' }}
                      onMouseEnter={() => setHoveredArrow(g.id)}
                      onMouseLeave={() => setHoveredArrow((cur) => (cur === g.id ? null : cur))}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={clickThroughArrow}
                    />
                    {/* Delete affordance — only while hovering the arrow */}
                    {hov && (
                      <g
                        style={{ pointerEvents: 'all', cursor: 'pointer' }}
                        onMouseEnter={() => setHoveredArrow(g.id)}
                        onMouseLeave={() => setHoveredArrow((cur) => (cur === g.id ? null : cur))}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => { e.stopPropagation(); deleteArrow(g.id); }}
                      >
                        <title>Remove arrow</title>
                        <circle cx={g.mx} cy={g.my} r={9} fill="var(--bg-elevated)" stroke="var(--nav-active-color)" strokeWidth={1.2} />
                        <text x={g.mx} y={g.my + 3.5} textAnchor="middle" fontSize={11} fill="var(--nav-active-color)" style={{ pointerEvents: 'none' }}>×</text>
                      </g>
                    )}
                  </g>
                );
              })}

              {/* Rubber band — where the arrow would land if you clicked now. */}
              {drawMode && drawStart && drawCursor && (
                <path
                  d={straightPath(
                    fromFraction(drawStart.fx, gridContentRef.current?.getBoundingClientRect().width ?? 0),
                    fromFraction(drawStart.fy, gridContentRef.current?.getBoundingClientRect().height ?? 0),
                    drawCursor.x, drawCursor.y,
                  )}
                  fill="none" stroke="var(--nav-active-color)" strokeWidth={2}
                  strokeDasharray="5 4" opacity={0.6}
                  markerEnd="url(#wr-arrowhead)"
                  style={{ pointerEvents: 'none' }}
                />
              )}
            </svg>
          )}

          {/* Draw layer — swallows every click while ⌘L is armed, so an endpoint
              comes from the pointer alone. Above the cells (which is what stops
              a click landing in a cell) and above the arrow overlay (so an
              existing arrow's delete hit-area can't eat the click either). */}
          {drawMode && (
            <div
              className="absolute inset-0"
              style={{ zIndex: 25, cursor: 'crosshair' }}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={handleDrawClick}
              onMouseMove={(e) => {
                const base = gridContentRef.current?.getBoundingClientRect();
                if (base) setDrawCursor({ x: e.clientX - base.left, y: e.clientY - base.top });
              }}
              onMouseLeave={() => setDrawCursor(null)}
            />
          )}

          {/* Sticky header */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: gridTemplate,
              position: 'sticky',
              top: 0,
              zIndex: 20,
              // Backstop under the header cells: their widths are fractional at
              // most zoom levels, so a hairline seam between two of them would
              // otherwise be a window onto the scrolling content behind.
              background: 'var(--bg-main)',
              borderBottom: '2px solid var(--border-med)',
            }}
          >
            {columns.map((col, ci) => {
              return (
                <div
                  key={ci}
                  className="relative flex items-center justify-center"
                  onContextMenu={(e) => { e.preventDefault(); setColMenu(ci); }}
                  style={{
                    background: colBg(colColor(ci), dark, true),
                    borderRight: ci < columns.length - 1 ? '1px solid var(--border-med)' : 'none',
                    height: 36,
                    userSelect: 'none',
                  }}
                >
                  {renamingCol === ci ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={commitRenameCol}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRenameCol();
                        if (e.key === 'Escape') setRenamingCol(null);
                      }}
                      className="w-full text-center text-xs font-bold bg-transparent px-2"
                      // outline:none inline, because the app-wide :focus-visible
                      // ring is a 2px accent outline and this input sits flush
                      // inside a 36px header — the ring's top and bottom edges
                      // get clipped, leaving two purple bars either side of the
                      // field. The caret and the field itself show focus here.
                      style={{ color: 'var(--nav-active-color)', outline: 'none' }}
                    />
                  ) : (
                    <Tooltip text="Double-click to rename">
                      <span
                        className="text-xs font-bold truncate px-5"
                        style={{ color: 'var(--nav-active-color)', cursor: 'default' }}
                        onDoubleClick={() => startRenameCol(ci)}
                      >
                        {col}
                      </span>
                    </Tooltip>
                  )}

                  {colMenu === ci && (
                    <div
                      data-col-menu
                      className="absolute z-50 py-1 rounded-lg shadow-xl text-xs"
                      style={{
                        top: '100%', left: '50%', transform: 'translateX(-50%)',
                        minWidth: 168, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                      }}
                    >
                      <DropBtn onClick={() => startRenameCol(ci)}>Rename column</DropBtn>
                      <DropBtn onClick={() => insertColumn(ci)}>Insert column left</DropBtn>
                      <DropBtn onClick={() => insertColumn(ci + 1)}>Insert column right</DropBtn>
                      {columns.length > 2 && <DropBtn onClick={() => deleteColumn(ci)} danger>Delete column</DropBtn>}
                      <div className="my-1 mx-2" style={{ borderTop: '1px solid var(--border-subtle)' }} />
                      <div className="px-3 pt-1 pb-0.5 uppercase tracking-wide" style={{ color: 'var(--label-color)', fontSize: 9 }}>Column color</div>
                      <div className="flex items-center gap-1.5 px-3 py-1.5 flex-wrap" style={{ maxWidth: 168 }}>
                        {COLOR_SWATCHES.map((c) => (
                          <button
                            key={c}
                            onClick={() => setColumnColor(ci, c)}
                            title={c}
                            className="rounded-full transition hover:scale-110"
                            style={{
                              width: 16, height: 16, background: c, cursor: 'pointer',
                              border: columnColors[ci] === c ? '2px solid var(--nav-active-color)' : '1px solid var(--border-med)',
                            }}
                          />
                        ))}
                        <label
                          className="rounded-full flex items-center justify-center cursor-pointer relative overflow-hidden"
                          title="Custom color"
                          style={{ width: 16, height: 16, border: '1px dashed var(--border-med)', fontSize: 9, color: 'var(--label-color)' }}
                        >
                          +
                          <input
                            type="color"
                            value={columnColors[ci] ?? colColor(ci)}
                            onChange={(e) => setColumnColor(ci, e.target.value)}
                            className="absolute inset-0 opacity-0 cursor-pointer"
                          />
                        </label>
                      </div>
                      <DropBtn onClick={() => setColumnColor(ci, null)}>Reset to default</DropBtn>
                    </div>
                  )}

                  {/* Resize handle */}
                  {ci < columns.length - 1 && (
                    <div
                      className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize"
                      style={{ zIndex: 2 }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        resizing.current = { idx: ci, startX: e.clientX, startW: snap.current.columnWidths[ci] };
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* Data rows */}
          {Array.from({ length: numRows }, (_, ri) => (
            <div key={ri} style={{ display: 'grid', gridTemplateColumns: gridTemplate }}>
              {columns.map((_, ci) => {
                const cellKey = `${ri}-${ci}`;
                const isHovered = hoveredCell?.ri === ri && hoveredCell?.ci === ci;
                const remoteCur = remoteCursorMap.get(cellKey);
                const picked = selHas(selection, ri, ci);
                const isDropTarget = selHas(dropAt, ri, ci);
                return (
                  <div
                    key={ci}
                    // data-ri/ci make the cell findable by hit-test during a drag
                    // (elementsFromPoint), which is how the drop target and the
                    // click-through-an-arrow path both locate a cell.
                    data-ri={ri}
                    data-ci={ci}
                    className={`relative${picked ? ' flow-cell-selected' : ''}${isDropTarget ? ' flow-cell-drop' : ''}`}
                    style={{
                      background: colBg(colColor(ci), dark, false),
                      borderRight: ci < columns.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                      borderBottom: '1px solid var(--border-subtle)',
                      boxShadow: remoteCur ? `inset 0 0 0 2px ${remoteCur.user.color}` : undefined,
                      cursor: drawMode ? 'crosshair' : (picked ? 'grab' : undefined),
                    }}
                    onMouseDown={(e) => handleCellMouseDown(ri, ci, e)}
                    onMouseEnter={() => setHoveredCell({ ri, ci })}
                    onMouseLeave={() => setHoveredCell(null)}
                  >
                    {/* A peer in this cell shows as the coloured ring below and
                        nothing else. There is no name to put on a label: presence
                        here is colours only, and the chip that used to sit here
                        rendered as an empty coloured box. */}
                    <div
                      key={`${activeSheet?.id ?? 'sheet'}-${cellKey}-${reloadNonce}-${cellNonce}`}
                      ref={(el) => {
                        cellEls.current[cellKey] = el;
                        if (el && el.dataset.init !== '1') { el.innerHTML = cellToHtml(cellsRef.current[cellKey] ?? ''); el.dataset.init = '1'; }
                      }}
                      // Not editable while this cell is part of a group: the group
                      // is being pointed at as a unit, and a stray caret in one of
                      // its cells would make the next keystroke edit that cell
                      // instead of moving the group.
                      contentEditable={!drawMode && !picked}
                      suppressContentEditableWarning
                      onFocus={() => { focusedCell.current = cellKey; syncRef.current?.setActiveCell(cellKey); }}
                      onBlur={(e) => { if (liveRef.current) { pushLiveCell(cellKey, e.currentTarget.innerHTML); syncRef.current?.setActiveCell(null); } }}
                      onInput={(e) => handleInput(ri, ci, e)}
                      onPaste={(e) => handlePaste(ri, ci, e)}
                      onKeyDown={(e) => handleKeyDown(ri, ci, e)}
                      className="flow-cell w-full outline-none bg-transparent leading-snug whitespace-pre-wrap break-words"
                      style={{
                        fontSize: effectiveFontSize + 'px',
                        fontFamily: cellFont === 'mono' ? 'var(--font-mono)' : 'var(--font-text)',
                        color: 'rgb(var(--ink-rgb))',
                        minHeight: Math.round(rowHeight * zoom / 100) + 'px',
                        padding: `${Math.round(6 * zoom / 100)}px ${Math.round(8 * zoom / 100)}px`,
                        caretColor: 'rgb(var(--ink-rgb))',
                      }}
                      spellCheck={false}
                    />
                    {/* Cell move buttons — top-right corner on hover */}
                    {isHovered && !drawMode && (
                      <div
                        className="absolute flex flex-col"
                        style={{ top: 2, right: 2, gap: 1, zIndex: 5, pointerEvents: 'auto' }}
                      >
                        {ri > 0 && (
                          <Tooltip text="Move up (⌘↑)" up>
                            <button
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => moveCell(ri, ci, 'up')}
                              className="flex items-center justify-center rounded transition"
                              style={{
                                width: 14, height: 14, fontSize: 8, lineHeight: 1,
                                background: 'var(--bg-elevated)', border: '1px solid var(--border-med)',
                                color: 'var(--label-color)', cursor: 'pointer',
                              }}
                            >▲</button>
                          </Tooltip>
                        )}
                        {ri < numRows - 1 && (
                          <Tooltip text="Move down (⌘↓)">
                            <button
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => moveCell(ri, ci, 'down')}
                              className="flex items-center justify-center rounded transition"
                              style={{
                                width: 14, height: 14, fontSize: 8, lineHeight: 1,
                                background: 'var(--bg-elevated)', border: '1px solid var(--border-med)',
                                color: 'var(--label-color)', cursor: 'pointer',
                              }}
                            >▼</button>
                          </Tooltip>
                        )}
                      </div>
                    )}
                    {/* Insert-row "+" — thin hover strip straddling the bottom border line itself,
                        independent of the cell's own hover state (which drives the move buttons above). */}
                    {!drawMode && ri < numRows - 1 && (
                      <div
                        className="absolute left-0 right-0"
                        style={{ bottom: -6, height: 12, zIndex: 6, pointerEvents: 'auto' }}
                        onMouseEnter={() => setHoveredGap({ ri, ci })}
                        onMouseLeave={() => setHoveredGap((g) => (g && g.ri === ri && g.ci === ci ? null : g))}
                      >
                        {hoveredGap?.ri === ri && hoveredGap?.ci === ci && (
                          <div
                            className="absolute left-1/2"
                            style={{ top: '50%', transform: 'translate(-50%, -50%)' }}
                          >
                            <Tooltip text="Insert row below">
                              <button
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => insertRowBetween(ri, ci)}
                                className="flex items-center justify-center rounded-full transition"
                                style={{
                                  width: 13, height: 13, fontSize: 11, lineHeight: 1,
                                  background: 'var(--nav-active-bg)', border: '1px solid var(--border-med)',
                                  color: 'var(--nav-active-color)', cursor: 'pointer',
                                }}
                              >+</button>
                            </Tooltip>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {/* Grow the grid, the way a spreadsheet does — pinned under the last
              row and scrolling with the content, not floating over it. */}
          <div
            className="flex items-center gap-2 px-3 text-xs sticky left-0"
            style={{ height: 34, color: 'var(--ink-muted)', width: 'fit-content' }}
          >
            <button
              className="btn-icon font-semibold px-1"
              style={{ color: 'var(--accent)' }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => addRows(Number(addRowsCount) || 0)}
              disabled={numRows >= MAX_ROWS}
            >
              Add
            </button>
            <input
              className="input text-xs text-center"
              style={{ width: 62, padding: '2px 6px' }}
              value={addRowsCount}
              inputMode="numeric"
              aria-label="How many rows to add"
              onChange={(e) => setAddRowsCount(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                addRows(Number(addRowsCount) || 0);
              }}
            />
            <span>
              {numRows >= MAX_ROWS
                ? `more rows at the bottom — ${MAX_ROWS.toLocaleString()} is the limit`
                : 'more rows at the bottom'}
            </span>
          </div>
        </div>
      </div>
      </div>

      {/* Right-click menu for a sheet tab. Rendered here, not inside the tab:
          the tab strip clips its overflow, so a menu drawn in the tab would be
          cut off at the 36px strip. */}
      {tabMenu && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setTabMenu(null)} onContextMenu={(e) => { e.preventDefault(); setTabMenu(null); }} />
          <div
            className="fixed z-50 py-1 rounded-lg shadow-xl text-xs"
            style={{
              left: Math.min(tabMenu.x, window.innerWidth - 190),
              top: Math.max(8, tabMenu.y - 132),
              minWidth: 176, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
            }}
          >
            <DropBtn onClick={() => { setTabMenu(null); startRenameSheet(tabMenu.idx); }}>Rename tab</DropBtn>
            <DropBtn onClick={() => { setTabMenu(null); duplicateSheet(tabMenu.idx); }}>Duplicate tab</DropBtn>
            <DropBtn onClick={() => { setTabMenu(null); addSheet(); }}>New tab</DropBtn>
            {sheets.length > 1 && (
              <>
                <div className="my-1 mx-2" style={{ borderTop: '1px solid var(--border-subtle)' }} />
                <DropBtn danger onClick={() => { const i = tabMenu.idx; setTabMenu(null); deleteSheet(i); }}>Delete tab</DropBtn>
              </>
            )}
          </div>
        </>
      )}

      {/* Ghost following the cursor while a group of cells is being dragged.
          Pointer-events off so the hit-test underneath still finds cells/tabs. */}
      {dragging && dragPos && drag.current && (
        <div
          className="fixed rounded-md px-2 py-1 text-[11px] font-semibold shadow-xl glass-elevated"
          style={{
            left: dragPos.x + 12, top: dragPos.y + 12, zIndex: 9999, pointerEvents: 'none',
            color: 'var(--nav-active-color)', border: '1px solid var(--border-subtle)',
          }}
        >
          {drag.current.rows.length} cell{drag.current.rows.length === 1 ? '' : 's'}
          {dropTab !== null && ' · hold to open this tab'}
        </div>
      )}

      {/* ── Sheet tabs ── */}
      {/* ── "That looks like a stock issue" ── */}
      {stockIssuePlan && (
        <div
          className="absolute left-3 z-30 rounded-md shadow-xl px-3 py-2.5 glass-elevated"
          style={{ bottom: 44, maxWidth: 320, border: '1px solid var(--border-subtle)' }}
          // The rename input commits on blur, so anything clickable in here must
          // not steal focus — same guard the tab's delete button uses.
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="text-xs font-medium mb-1" style={{ color: 'var(--nav-active-color)' }}>
            Switch to a stock-issues flow?
          </div>
          <div className="text-[11px] leading-relaxed mb-2" style={{ color: 'var(--label-color)' }}>
            {stockIssuePlan.renames.map((r) => r.to).join(', ')} — renames{' '}
            {stockIssuePlan.renames.length} unused tab
            {stockIssuePlan.renames.length === 1 ? '' : 's'}. Your other tabs and everything
            already on the flow stay as they are.
          </div>
          <div className="flex items-center gap-1.5">
            <Tooltip text="Rename the tabs">
              <button
                className="btn-primary text-[11px] px-2 py-0.5"
                onClick={() => applyStockIssuePlan(stockIssuePlan)}
              >
                Switch
              </button>
            </Tooltip>
            <Tooltip text="Keep the advantage layout">
              <button
                className="btn text-[11px] px-2 py-0.5"
                onClick={() => setStockIssueDismissed(true)}
              >
                No thanks
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      {/* The OUTER row must not scroll — it used to also be overflow-x-auto, which
          put a second scrollbar across the full 36px strip, drawn on top of the
          tab labels. Only the sheet list scrolls, and it hides its bar: a 15px
          scrollbar inside a 36px row covers the bottom of every tab name. */}
      <div
        className="flex items-center flex-shrink-0 overflow-hidden"
        style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-sidebar)', height: 36 }}
      >
        {/* Sheets (scrollable, bar hidden) */}
        <div className="flex items-center flex-1 overflow-x-auto min-w-0 scroll-none">
          {sheets.map((sheet, idx) => (
            <SheetTab
              key={sheet.id}
              idx={idx}
              dropTarget={dropTab === idx}
              name={sheet.name}
              active={idx === activeSheetIdx}
              renaming={renamingSheet === idx}
              renameValue={renameValue}
              onRenameChange={setRenameValue}
              onCommitRename={commitRenameSheet}
              onCancelRename={() => setRenamingSheet(null)}
              onClick={() => switchSheet(idx)}
              onDoubleClick={() => startRenameSheet(idx)}
              onDelete={sheets.length > 1 ? () => deleteSheet(idx) : undefined}
              onContextMenu={(x, y) => setTabMenu({ idx, x, y })}
              getSummary={() => sheetSummary(idx)}
              onEnsureSummary={() => ensureSheetSummary(idx)}
              dragging={dragTabIdx === idx}
              dropBefore={dropTabIdx === idx && dragTabIdx !== null && dragTabIdx !== idx}
              onDragStart={() => setDragTabIdx(idx)}
              onDragOverTab={() => { if (dragTabIdx !== null && dragTabIdx !== idx) setDropTabIdx(idx); }}
              onDropTab={() => {
                if (dragTabIdx !== null && dragTabIdx !== idx) reorderSheet(dragTabIdx, idx);
                setDragTabIdx(null); setDropTabIdx(null);
              }}
              onDragEnd={() => { setDragTabIdx(null); setDropTabIdx(null); }}
            />
          ))}
        </div>

        {/* Add sheet — RIGHT side */}
        <div className="w-px h-4 shrink-0" style={{ background: 'var(--border-subtle)' }} />
        <Tooltip text="Add sheet (⌘T)">
          <button
            className="flex items-center justify-center w-8 h-8 shrink-0 text-lg font-light transition"
            style={{ color: 'var(--label-color)' }}
            onClick={addSheet}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--nav-active-color)')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--label-color)')}
          >+</button>
        </Tooltip>
      </div>

      {/* ── First-flow onboarding tip ────────────────────────────────────────
          Shown only on a user's very first flow (flowsIndex has exactly one
          entry) until they dismiss it. Disappears forever once closed. */}
      {!tipDismissed && flowsIndex.length <= 1 && (
        <div
          className="fixed bottom-5 right-5 z-50 rounded-2xl shadow-2xl px-5 py-4"
          style={{
            maxWidth: 300,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.18), 0 1.5px 6px rgba(0,0,0,0.10)',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-[13px] font-semibold" style={{ color: 'var(--nav-active-color)' }}>
              Quick tips
            </span>
            <button
              className="btn-icon w-5 h-5 flex items-center justify-center rounded-full text-xs"
              style={{ color: 'var(--ink-muted)' }}
              aria-label="Dismiss tips"
              onClick={() => { localStorage.setItem('pf-tips-dismissed', '1'); setTipDismissed(true); }}
            >✕</button>
          </div>

          {/* Tips list */}
          <div className="w-full" style={{ height: 1, background: 'var(--border-subtle)', margin: '2px 0 10px' }} />
          <div className="flex flex-col gap-3">
            {([
              {
                keys: [`${mod}`, `↑↓←→`],
                desc: 'Move a cell (with its contents) in any direction',
              },
              {
                keys: [`${mod}`, 'click'],
                desc: 'Select multiple cells to move or emphasize them as a group',
              },
              {
                keys: [`${mod}`, 'L'],
                desc: 'Draw a connecting line between two cells',
              },
            ] as { keys: string[]; desc: string }[]).map(({ keys, desc }, i) => (
              <div key={i} className="flex items-start gap-2.5">
                {/* Key chips */}
                <div className="flex items-center gap-1 shrink-0 mt-0.5">
                  {keys.map((k, ki) => (
                    <React.Fragment key={ki}>
                      {ki > 0 && <span className="text-[10px]" style={{ color: 'var(--ink-muted)' }}>+</span>}
                      <kbd
                        className="inline-flex items-center justify-center rounded-md text-[11px] font-semibold px-1.5"
                        style={{
                          minWidth: 22, height: 20,
                          background: 'var(--bg-nest)',
                          border: '1px solid var(--border-med)',
                          color: 'var(--nav-active-color)',
                          fontFamily: 'var(--font-mono)',
                          boxShadow: '0 1px 0 var(--border-med)',
                        }}
                      >{k}</kbd>
                    </React.Fragment>
                  ))}
                </div>
                <span className="text-[12px] leading-snug" style={{ color: 'var(--ink-muted)' }}>
                  {desc}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

// Two people / live-collab glyph.
function ShareIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
      <path d="M12 10a2 2 0 0 0-1.6.8L5.9 8.4A2 2 0 0 0 6 8a2 2 0 0 0-.1-.4l4.5-2.3A2 2 0 1 0 9.9 3.4L5.4 5.7A2 2 0 1 0 5.4 10.3l4.5 2.3A2 2 0 1 0 12 10z"/>
    </svg>
  );
}

function IcoUndo() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 4.5H8.5a3 3 0 0 1 0 6H4" />
      <path d="M4.5 2.5L2.5 4.5l2 2" />
    </svg>
  );
}
function IcoRedo() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 4.5H5.5a3 3 0 0 0 0 6H10" />
      <path d="M9.5 2.5l2 2-2 2" />
    </svg>
  );
}
function IcoFind() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="4" />
      <path d="M9 9L12 12" />
    </svg>
  );
}
function IcoArrow() {
  // A dot joined by a STRAIGHT diagonal to an arrowhead — the glyph draws what
  // the tool draws. (It used to be a curve, which is what made people expect a
  // curved line.)
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4.5" cy="4.5" r="1.7" fill="currentColor" stroke="none" />
      <path d="M6 6L15 15" />
      <path d="M10.5 15.2H15.2V10.5" />
    </svg>
  );
}

function IcoFit() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 2.5H2.5v2M11.5 4.5v-2h-2M9.5 11.5h2v-2M2.5 9.5v2h2" />
    </svg>
  );
}
function IcoResetCols() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1" />
      <path d="M5.5 2.5v9M8.5 2.5v9" />
    </svg>
  );
}
// A magnifying glass over a small spark — reads as "AI-inspect the round".
function IcoSettings() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}


// Shared compact toolbar icon button with a consistent hover background.
function ToolBtn({ children, onClick, onMouseDown, title, active, disabled, className }: {
  children: React.ReactNode; onClick?: () => void; onMouseDown?: (e: React.MouseEvent) => void;
  title?: string; active?: boolean; disabled?: boolean; className?: string;
}) {
  return (
    <Tooltip text={title} disabled={disabled}>
      <button
        onClick={onClick}
        onMouseDown={onMouseDown}
        disabled={disabled}
        className={`flex items-center justify-center rounded-md transition shrink-0${className ? ` ${className}` : ''}`}
        style={{
          width: 26, height: 26,
          background: active ? 'var(--nav-active-bg)' : 'transparent',
          color: active ? 'var(--nav-active-color)' : 'var(--nav-inactive-color)',
          opacity: disabled ? 0.4 : 1,
          cursor: disabled ? 'default' : 'pointer',
        }}
        onMouseEnter={(e) => { if (!active && !disabled) (e.currentTarget as HTMLElement).style.background = 'var(--nav-hover-bg)'; }}
        onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function ToolDivider() {
  return <div className="w-px h-4 shrink-0" style={{ background: 'var(--border-subtle)' }} />;
}

function SmallBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-2.5 py-0.5 text-[10px] uppercase tracking-wider rounded-md transition font-bold"
      style={
        active
          ? { background: 'var(--bg-card)', color: 'var(--nav-active-color)', boxShadow: 'var(--nav-active-shadow)' }
          : { background: 'transparent', color: 'var(--nav-inactive-color)' }
      }
    >
      {label}
    </button>
  );
}

function DropBtn({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className="w-full text-left px-3 py-1.5 text-xs transition"
      style={{ color: danger ? 'var(--danger)' : 'var(--nav-active-color)' }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--nav-hover-bg)')}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SheetTab({
  idx, dropTarget,
  name, active, renaming, renameValue, onRenameChange, onCommitRename, onCancelRename,
  onClick, onDoubleClick, onDelete, onContextMenu, getSummary, onEnsureSummary,
  dragging, dropBefore, onDragStart, onDragOverTab, onDropTab, onDragEnd,
}: {
  /** Position in the tab strip — published as `data-sheet-idx` so a cell drag
   *  can hit-test the strip and open this tab without letting go. */
  idx: number;
  /** A dragged group of cells is hovering here, about to open this tab. */
  dropTarget?: boolean;
  name: string; active: boolean; renaming: boolean;
  renameValue: string; onRenameChange: (v: string) => void;
  onCommitRename: () => void; onCancelRename: () => void;
  onClick: () => void; onDoubleClick: () => void; onDelete?: () => void;
  /** Right-click anywhere on the tab — the parent draws the menu. */
  onContextMenu?: (x: number, y: number) => void;
  getSummary?: () => string;
  /** Kicks off (or reuses the cache for) this tab's AI summary. Fire-and-forget — the
   * result lands via `getSummary` once generation resolves and re-renders the parent. */
  onEnsureSummary?: () => void;
  /** Drag-to-reorder: `dragging` = this tab is the one being dragged (dimmed),
   * `dropBefore` = a dragged tab is hovering here (show an insertion marker on the
   * left edge). The parent owns the actual reorder (reorderSheet). */
  dragging?: boolean; dropBefore?: boolean;
  onDragStart?: () => void; onDragOverTab?: () => void; onDropTab?: () => void; onDragEnd?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  // Computed on hover (not every render) since it reads every cell on the tab.
  const [summary, setSummary] = useState<string | null>(null);
  const summaryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (summaryTimer.current) clearTimeout(summaryTimer.current); }, []);
  // Re-reads the summary on every parent re-render while hovered — a fresh
  // `getSummary` closure comes down on every FlowView render, so this also
  // catches ensureSheetSummary's async result (and the "summarizing…" state in
  // between) landing without any extra plumbing.
  useEffect(() => {
    if (hovered && getSummary) setSummary(getSummary());
  }, [hovered, getSummary]);
  return (
    <div
      data-sheet-idx={idx}
      className={`flex items-center shrink-0 relative${dropTarget ? ' flow-tab-drop' : ''}`}
      // Not draggable while inline-renaming, so text selection in the input works.
      draggable={!renaming}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart?.(); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; onDragOverTab?.(); }}
      onDrop={(e) => { e.preventDefault(); onDropTab?.(); }}
      onDragEnd={() => onDragEnd?.()}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu?.(e.clientX, e.clientY); }}
      style={{
        height: '100%',
        borderRight: '1px solid var(--border-subtle)',
        background: active ? 'var(--bg-card)' : 'transparent',
        minWidth: 72, maxWidth: 130,
        opacity: dragging ? 0.4 : 1,
        boxShadow: dropBefore ? 'inset 2px 0 0 0 var(--nav-active-color)' : undefined,
        cursor: renaming ? undefined : 'grab',
      }}
      // The AI summary only fires after a deliberate dwell (matching the
      // tooltip's own show-delay) — sweeping the cursor across a row of tabs to
      // get somewhere shouldn't spend an API call on every tab it crosses.
      onMouseEnter={() => {
        setHovered(true);
        if (getSummary) setSummary(getSummary());
        if (summaryTimer.current) clearTimeout(summaryTimer.current);
        summaryTimer.current = setTimeout(() => onEnsureSummary?.(), 400);
      }}
      onMouseLeave={() => {
        setHovered(false);
        if (summaryTimer.current) { clearTimeout(summaryTimer.current); summaryTimer.current = null; }
      }}
    >
      {renaming ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(e) => { if (e.key === 'Enter') onCommitRename(); if (e.key === 'Escape') onCancelRename(); }}
          className="flex-1 bg-transparent text-xs font-medium px-3"
          // See the column-header rename for why the focus ring is killed here:
          // the 2px accent outline is clipped by the 36px tab strip, so only its
          // vertical edges survive as two stray purple bars beside the field.
          style={{ color: 'var(--nav-active-color)', outline: 'none' }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <Tooltip text={summary ? `${name}\n${summary}` : name} up wide className="flex-1 min-w-0">
          <button
            className="w-full text-left truncate text-xs font-medium px-3"
            style={{ color: active ? 'var(--nav-active-color)' : 'var(--nav-inactive-color)' }}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
          >
            {name}
          </button>
        </Tooltip>
      )}
      {onDelete && !renaming && (
        <Tooltip text="Delete sheet">
          <button
            className="shrink-0 mr-1.5 w-4 h-4 flex items-center justify-center rounded text-xs transition"
            style={{
              color: 'var(--nav-inactive-color)',
              opacity: (hovered || active) ? 0.5 : 0,
              pointerEvents: (hovered || active) ? 'auto' : 'none',
            }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = (hovered || active) ? '0.5' : '0')}
          >×</button>
        </Tooltip>
      )}
    </div>
  );
}
