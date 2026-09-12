import React, { useEffect, useRef, useState } from 'react';
import { useApp, FlowMeta } from '../store/appStore';
import { readKey, writeKey } from '../platform/storage';
import { openFiles, resolveDroppedFiles } from '../platform/files';
import { importFlowFile } from '../utils/flowImport';
import { makeDefaultData } from './FlowView';
import { readFlowPrefs } from '../lib/flowPrefs';
import { listFlows, deleteFlow as cloudDeleteFlow, leaveFlow } from '../platform/cloud';
import { useDragActive } from '../hooks/useDragActive';
import Tooltip from './Tooltip';
import { LoadingState } from './Spinner';
import AnalyzeRound from './AnalyzeRound';
import { POLICY_COLS } from './FlowView';
import type { SheetData } from './FlowView';
import { readSettings } from '../platform/settings';

/**
 * The flow library. Everything starts here: a new flow is one click, and the
 * list is whatever this browser owns plus whatever share links it has opened.
 */
type SortMode = 'modified' | 'viewed' | 'created' | 'name' | 'cells';
const SORT_LABELS: Record<SortMode, string> = {
  modified: 'Last modified',
  viewed: 'Last viewed',
  created: 'Date created',
  name: 'Name',
  cells: 'Most cells written',
};
const SORT_MODES: SortMode[] = ['modified', 'viewed', 'created', 'name', 'cells'];
const SORT_STORAGE_KEY = 'pf-home-sort';

/** Non-empty cells across every sheet — how "worked" a flow is, for the
 * "most cells written" sort. Tag markup doesn't count as content. */
function countCells(sheets: { cells?: Record<string, string> }[] | undefined): number {
  let n = 0;
  for (const sheet of sheets ?? []) {
    for (const key in sheet?.cells ?? {}) {
      const v = sheet.cells![key];
      if (v && v.replace(/<[^>]*>/g, '').trim()) n++;
    }
  }
  return n;
}

function compareFlows(a: FlowMeta, b: FlowMeta, mode: SortMode, cellCounts: Record<string, number>): number {
  switch (mode) {
    case 'modified':
      return (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '');
    case 'viewed':
      return (b.viewedAt ?? '').localeCompare(a.viewedAt ?? '');
    case 'created':
      return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
    case 'name':
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    case 'cells':
      return (cellCounts[b.id] ?? 0) - (cellCounts[a.id] ?? 0);
  }
}

export default function Home({ onAutoFlow }: { onAutoFlow: () => void }) {
  const { flowsIndex, setFlowsIndex, setView, identityId } = useApp();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const { dragActive, setDragActive, dragHandlers } = useDragActive();
  const merged = useRef(false);
  // Analyze Round lives here rather than in the flow toolbar: it reads the whole
  // round at once, which is a thing you do about a flow, not inside one.
  const [analyzing, setAnalyzing] = useState<{ flowId: string; sheets: SheetData[]; columns: string[] } | null>(null);
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>(
    () => (localStorage.getItem(SORT_STORAGE_KEY) as SortMode) || 'modified'
  );
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [cellCounts, setCellCounts] = useState<Record<string, number>>({});
  // Right-click card menu (Rename / Duplicate / Delete) and the rename trigger
  // it fires into the target card — the card owns its own inline-edit state
  // (same as the existing double-click rename), this just flips it on from
  // outside. `token` just needs to change to re-arm the effect on a second
  // right-click-Rename of the same card in a row.
  const [cardMenu, setCardMenu] = useState<{ flowId: string; x: number; y: number } | null>(null);
  const [renameRequest, setRenameRequest] = useState<{ flowId: string; token: number } | null>(null);

  function chooseSort(mode: SortMode) {
    setSortMode(mode);
    setSortMenuOpen(false);
    localStorage.setItem(SORT_STORAGE_KEY, mode);
  }

  // Cell counts are only worth reading off disk when they'll actually be
  // shown — recomputed whenever that sort is active or the flow list changes.
  useEffect(() => {
    if (sortMode !== 'cells') return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(flowsIndex.map(async (f) => {
        const data = await readKey<any>(`flow_data_${f.id}`);
        return [f.id, countCells(data?.sheets)] as const;
      }));
      if (!cancelled) setCellCounts(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortMode, flowsIndex.map((f) => f.id).join(',')]);

  // Close the sort menu on an outside click, same pattern as FlowView's
  // right-click menus.
  useEffect(() => {
    if (!sortMenuOpen) return;
    function h(e: MouseEvent) { if (!(e.target as HTMLElement).closest('[data-sort-menu]')) setSortMenuOpen(false); }
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [sortMenuOpen]);

  async function openAnalyze(flow: FlowMeta) {
    const data = await readKey<any>(`flow_data_${flow.id}`);
    if (!data?.sheets?.length) { setError('That flow has nothing on it to analyze yet.'); return; }
    setAnalyzing({ flowId: flow.id, sheets: data.sheets, columns: data.customColumns ?? POLICY_COLS });
  }

  // Reconcile the local list against the cloud once the identity resolves, so
  // a flow made on another device (or handed over by a transfer code) shows up
  // without the user doing anything. Local entries always win on name — they
  // are what this browser last saw the user type.
  useEffect(() => {
    if (!identityId || merged.current) return;
    merged.current = true;
    (async () => {
      const res = await listFlows();
      if (!res.ok) return; // offline: the local list is still correct
      const local = new Map(flowsIndex.map((f) => [f.id, f]));
      const next: FlowMeta[] = [...flowsIndex];
      for (const row of res.data) {
        const existing = local.get(row.id);
        if (existing) {
          existing.cloud = true;
          existing.shared = !row.owned;
          if (row.shareToken) existing.shareToken = row.shareToken;
        } else {
          next.push({
            id: row.id, name: row.name, event: 'policy',
            cloud: true, shared: !row.owned, shareToken: row.shareToken,
            live: !row.owned, createdAt: row.updatedAt,
          });
        }
      }
      setFlowsIndex(next);
      await writeKey('flows_index', next);
    })();
  }, [identityId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function newFlow() {
    const prefs = readFlowPrefs();
    const id = crypto.randomUUID();
    const data = makeDefaultData('policy', prefs.defaultVariant, prefs.defaultPfOrder);
    await writeKey(`flow_data_${id}`, data);
    const meta: FlowMeta = {
      id,
      name: new Date().toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' }),
      event: 'policy',
      createdAt: new Date().toISOString(),
    };
    const next = [...flowsIndex, meta];
    setFlowsIndex(next);
    await writeKey('flows_index', next);
    setView({ kind: 'flow', flowId: id });
  }

  async function importHandles(handles: string[]) {
    if (!handles.length) return;
    setImporting(true);
    setError('');
    const added: FlowMeta[] = [];
    const failed: string[] = [];
    for (const h of handles) {
      try {
        const { name, data } = await importFlowFile(h);
        const id = crypto.randomUUID();
        await writeKey(`flow_data_${id}`, data);
        added.push({ id, name, event: 'policy', createdAt: new Date().toISOString() });
      } catch (e: any) {
        failed.push(e?.message || 'Could not read that spreadsheet.');
      }
    }
    if (added.length) {
      const next = [...flowsIndex, ...added];
      setFlowsIndex(next);
      await writeKey('flows_index', next);
    }
    // Report the shortfall rather than letting a partial import look complete.
    if (failed.length) {
      setError(added.length
        ? `Imported ${added.length} of ${handles.length}. ${failed[0]}`
        : failed[0]);
    }
    setImporting(false);
    if (added.length === 1 && !failed.length) setView({ kind: 'flow', flowId: added[0].id });
  }

  async function saveFlowName(flow: FlowMeta, name: string) {
    const trimmed = name.trim() || flow.name;
    const next = flowsIndex.map((f) => (f.id === flow.id ? { ...f, name: trimmed } : f));
    setFlowsIndex(next);
    await writeKey('flows_index', next);
  }

  async function saveNotes(flow: FlowMeta, notes: string) {
    const next = flowsIndex.map((f) => (f.id === flow.id ? { ...f, notes: notes || undefined } : f));
    setFlowsIndex(next);
    await writeKey('flows_index', next);
  }

  async function removeFlow(flow: FlowMeta) {
    const next = flowsIndex.filter((f) => f.id !== flow.id);
    setFlowsIndex(next);
    await writeKey('flows_index', next);
    await writeKey(`flow_data_${flow.id}`, null);
    // A flow someone else owns is only removed from YOUR list — deleting it for
    // everyone in the room is not yours to do.
    //
    // Deliberately NOT gated on flow.cloud: every flow syncs from the moment
    // it is opened, and a stale/absent flag here means the server row is never
    // deleted and lingers forever. Deleting a row that was never created is a
    // no-op, so attempting it unconditionally is the safe direction to be wrong in.
    await (flow.shared ? leaveFlow(flow.id) : cloudDeleteFlow(flow.id));
  }

  /**
   * A brand-new flow, independent of the original: its own id, its own future
   * cloud row (created lazily the first time it's opened, same as any other
   * flow). Sharing/live state is deliberately NOT copied — duplicating a flow
   * makes a private copy, not a second seat in the same room.
   */
  async function duplicateFlow(flow: FlowMeta) {
    const data = await readKey<any>(`flow_data_${flow.id}`);
    const id = crypto.randomUUID();
    await writeKey(`flow_data_${id}`, data ?? null);
    const now = new Date().toISOString();
    const meta: FlowMeta = {
      id,
      name: `${flow.name} copy`.slice(0, 60),
      event: flow.event,
      createdAt: now,
      updatedAt: now,
      notes: flow.notes,
    };
    const next = [...flowsIndex, meta];
    setFlowsIndex(next);
    await writeKey('flows_index', next);
  }

  const filtered = search.trim()
    ? flowsIndex.filter((f) => f.name.toLowerCase().includes(search.trim().toLowerCase()))
    : flowsIndex;
  const sorted = [...filtered].sort((a, b) => compareFlows(a, b, sortMode, cellCounts));

  return (
    <div
      className="flex-1 overflow-auto"
      {...dragHandlers}
      onDrop={async (e) => {
        e.preventDefault();
        setDragActive(false);
        const handles = resolveDroppedFiles(e.dataTransfer.files, ['xlsx']);
        if (handles.length) await importHandles(handles);
        else setError('Drop a .xlsx spreadsheet to import it as a flow.');
      }}
    >
      <div className="mx-auto px-8 py-9" style={{ maxWidth: 1120 }}>
        <header className="flex items-start justify-between gap-8 mb-6">
          <div>
            <h1 className="text-[25px] font-semibold tracking-[-0.018em] leading-none mb-1.5">Your flows</h1>
            <p className="text-[13px] mb-3" style={{ color: 'var(--label-color)' }}>
              Saved on this device and synced privately. No account, no sign-in.
            </p>
            <div className="relative w-full max-w-[280px]">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--label-color)' }}>
                <IcoSearch />
              </span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search flows by title…"
                className="input text-xs w-full h-8 pl-8 pr-2.5"
              />
            </div>
          </div>
          {/* Three actions in priority order rather than three identical chips:
              the primary is filled, Auto Flow carries the app-wide AI ring, and
              import is quiet because it is the rarest of the three. */}
          <div className="flex flex-col items-end gap-2 shrink-0">
            <div className="flex items-center gap-2 shrink-0">
              <Tooltip text="Import a spreadsheet">
                <button
                  className="btn-icon inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[9px] text-xs font-medium transition-colors"
                  style={{ color: 'var(--ink-muted)' }}
                  onClick={async () => importHandles(await openFiles(['xlsx']))}
                >
                  <IcoImport />
                  Import .xlsx
                </button>
              </Tooltip>
              <Tooltip text="Sort a speech doc into a flow">
                <button className="btn ai-glow-ring h-8 px-3 gap-1.5" onClick={onAutoFlow}>
                  <IcoSparkle />
                  Auto Flow
                </button>
              </Tooltip>
              <button className="btn-primary h-8 px-3.5 gap-1.5" onClick={newFlow}>
                <IcoPlus />
                New flow
              </button>
            </div>
            <div className="relative" data-sort-menu>
              <button
                className="btn-icon inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[8px] text-xs font-medium"
                style={{ color: 'var(--label-color)' }}
                onClick={() => setSortMenuOpen((o) => !o)}
              >
                Sort: {SORT_LABELS[sortMode]}
                <IcoChevronDown />
              </button>
              {sortMenuOpen && (
                <div
                  className="absolute z-50 py-1 rounded-lg shadow-xl text-xs"
                  style={{
                    top: '100%', right: 0, marginTop: 4,
                    minWidth: 180, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                  }}
                >
                  {SORT_MODES.map((mode) => (
                    <button
                      key={mode}
                      className="w-full text-left px-3 py-1.5 flex items-center gap-2 transition"
                      style={{ color: mode === sortMode ? 'var(--nav-active-color)' : 'var(--ink)' }}
                      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--nav-hover-bg)')}
                      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
                      onClick={() => chooseSort(mode)}
                    >
                      <span style={{ width: 12, flexShrink: 0 }}>{mode === sortMode ? '✓' : ''}</span>
                      {SORT_LABELS[mode]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </header>

        {error && (
          <p className="mb-4 text-sm" style={{ color: 'var(--danger)' }} role="alert">{error}</p>
        )}

        {importing ? (
          <div className="py-16"><LoadingState messages={['Reading your spreadsheet…']} /></div>
        ) : flowsIndex.length === 0 ? (
          <div
            className="rounded-[13px] border border-dashed py-14 px-6 text-center transition-colors"
            style={{
              borderColor: dragActive ? 'var(--accent)' : 'var(--border-med)',
              background: dragActive ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            <p className="text-sm font-semibold">No flows yet</p>
            <p className="text-xs mt-1.5" style={{ color: 'var(--label-color)' }}>
              Start a new one, or drop a .xlsx here to import it.
            </p>
          </div>
        ) : sorted.length === 0 ? (
          <p className="text-sm py-10 text-center" style={{ color: 'var(--label-color)' }}>
            No flows match "{search.trim()}".
          </p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sorted.map((f) => (
              <li key={f.id}>
                <FlowCard
                  flow={f}
                  onOpen={() => setView({ kind: 'flow', flowId: f.id })}
                  onRemove={() => void removeFlow(f)}
                  onAnalyze={() => void openAnalyze(f)}
                  onRename={(name) => void saveFlowName(f, name)}
                  onNotes={(notes) => void saveNotes(f, notes)}
                  onContextMenu={(x, y) => setCardMenu({ flowId: f.id, x, y })}
                  renameSignal={renameRequest?.flowId === f.id ? renameRequest.token : undefined}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Right-click menu for a flow card. */}
      {cardMenu && (() => {
        const flow = flowsIndex.find((f) => f.id === cardMenu.flowId);
        if (!flow) return null;
        return (
          <>
            <div className="fixed inset-0 z-40" onMouseDown={() => setCardMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCardMenu(null); }} />
            <div
              className="fixed z-50 py-1 rounded-lg shadow-xl text-xs"
              style={{
                left: Math.min(cardMenu.x, window.innerWidth - 180),
                top: Math.min(cardMenu.y, window.innerHeight - 140),
                minWidth: 168, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
              }}
            >
              <DropBtn onClick={() => { setCardMenu(null); setRenameRequest({ flowId: flow.id, token: Date.now() }); }}>Rename</DropBtn>
              <DropBtn onClick={() => { setCardMenu(null); void duplicateFlow(flow); }}>Duplicate</DropBtn>
              <div className="my-1 mx-2" style={{ borderTop: '1px solid var(--border-subtle)' }} />
              <DropBtn danger onClick={() => { setCardMenu(null); void removeFlow(flow); }}>
                {flow.shared ? 'Remove from your list' : 'Delete'}
              </DropBtn>
            </div>
          </>
        );
      })()}

      {analyzing && (
        <AnalyzeRound
          sheets={analyzing.sheets}
          columns={analyzing.columns}
          event="policy"
          flowId={analyzing.flowId}
          onClose={() => setAnalyzing(null)}
        />
      )}
    </div>
  );
}

/**
 * One flow in the grid. The strip across the top is a real read on the flow
 * rather than decoration: seven speech columns, each ticked once per row that
 * actually holds a cell, so how far into the round a flow got is legible
 * without opening it.
 */
function FlowCard({ flow, onOpen, onRemove, onAnalyze, onNotes, onRename, onContextMenu, renameSignal }: {
  flow: FlowMeta; onOpen: () => void; onRemove: () => void; onAnalyze: () => void;
  onNotes: (notes: string) => void; onRename: (name: string) => void;
  onContextMenu: (x: number, y: number) => void;
  /** Changes to trigger inline rename from outside (the right-click menu) —
   * the card owns its own edit state, same as the existing double-click path. */
  renameSignal?: number;
}) {
  const [fill, setFill] = useState<number[]>([]);
  const [editingNotes, setEditingNotes] = useState(false);
  const [draft, setDraft] = useState(flow.notes ?? '');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(flow.name);
  // The same two colours the grid paints its columns with, so the strip reads
  // as a miniature of the actual flow rather than a differently-coloured chart.
  const { affColor, negColor } = readSettings();

  useEffect(() => {
    let cancelled = false;
    readKey<any>(`flow_data_${flow.id}`).then((data) => {
      if (cancelled) return;
      setFill(columnFill(data?.sheets));
    });
    return () => { cancelled = true; };
  }, [flow.id]);

  useEffect(() => {
    if (renameSignal === undefined) return;
    setNameDraft(flow.name);
    setEditingName(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameSignal]);

  return (
    <div
      className="group relative rounded-[13px] border transition-colors"
      style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', boxShadow: 'var(--shadow-card)' }}
      onContextMenu={(e) => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      <div
        className="h-[74px] px-4 pt-3.5 flex items-start gap-[5px] border-b overflow-hidden cursor-pointer"
        style={{
          background: 'var(--bg-nest)',
          borderColor: 'var(--border-subtle)',
          borderTopLeftRadius: 12, borderTopRightRadius: 12,
        }}
        onClick={onOpen}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
        aria-label={`Open flow: ${flow.name}`}
      >
        {fill.map((rows, ci) => (
          <div key={ci} className="flex flex-col gap-[3px] flex-1">
            {rows === 0 ? (
              <span className="h-[5px] rounded-sm" style={{ background: 'var(--border-subtle)' }} />
            ) : (
              Array.from({ length: rows }, (_, ri) => (
                <span
                  key={ri}
                  className="h-[5px] rounded-sm"
                  style={{
                    // Aff speeches are the even columns of the policy layout.
                    background: ci % 2 === 0 ? affColor : negColor,
                    opacity: Math.max(0.3, 0.85 - ri * 0.16),
                  }}
                />
              ))
            )}
          </div>
        ))}
      </div>

      <div className="px-4 pt-3 pb-3.5">
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            className="text-sm font-semibold tracking-[-0.005em] w-full bg-transparent outline-none border-b"
            style={{ borderColor: 'var(--accent)', color: 'rgb(var(--ink-rgb))' }}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => { setEditingName(false); onRename(nameDraft); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { setEditingName(false); onRename(nameDraft.trim() || flow.name); }
              if (e.key === 'Escape') { setEditingName(false); setNameDraft(flow.name); }
            }}
          />
        ) : (
          <div
            className="text-sm font-semibold tracking-[-0.005em] line-clamp-1 cursor-text"
            onDoubleClick={() => { setNameDraft(flow.name); setEditingName(true); }}
            title="Double-click to rename"
          >{flow.name}</div>
        )}

        {/* Scratch notes. Double-click to edit, exactly like renaming a tab —
            click alone has to stay "open the flow", which is what the whole card
            does. */}
        {editingNotes ? (
          <textarea
            autoFocus
            rows={2}
            maxLength={280}
            value={draft}
            placeholder="Opponent, judge, what to fix next time…"
            className="w-full mt-1.5 mb-2 text-xs rounded-[7px] px-2 py-1.5 resize-none"
            style={{
              background: 'var(--bg-nest)',
              border: '1px solid var(--accent)',
              color: 'rgb(var(--ink-rgb))',
              outline: 'none',
            }}
            onBlur={() => { setEditingNotes(false); onNotes(draft.trim()); }}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') { setDraft(flow.notes ?? ''); setEditingNotes(false); }
              // Enter saves; Shift+Enter keeps a second line, since these run to
              // two lines often enough to be worth it.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.currentTarget as HTMLTextAreaElement).blur(); }
            }}
          />
        ) : (
          <div
            className="text-xs mt-1 mb-2 line-clamp-2 min-h-[16px]"
            style={{ color: flow.notes ? 'var(--ink-muted)' : 'var(--placeholder)' }}
            onDoubleClick={() => { setDraft(flow.notes ?? ''); setEditingNotes(true); }}
            title="Double-click to write a note"
          >
            {flow.notes || 'Double-click to add a note'}
          </div>
        )}

        <div className="flex items-center gap-2">
          {flow.live ? (
            <span className="pill pill-live"><span className="w-[5px] h-[5px] rounded-full bg-current" />Live</span>
          ) : flow.shared ? (
            <span className="pill pill-shared"><IcoShare />Shared with you</span>
          ) : flow.cloud ? (
            <span className="pill pill-muted"><IcoCloud />Synced</span>
          ) : (
            <span className="pill pill-muted"><IcoDevice />This device</span>
          )}
          {flow.createdAt && (
            <span className="text-[11.5px]" style={{ color: 'var(--label-color)' }}>
              {new Date(flow.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
          )}
        </div>
      </div>

      <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <Tooltip text="Read the whole round and say who's ahead">
          <button
            className="ai-glow-ring shrink-0 inline-flex items-center justify-center rounded-md text-[11px] font-semibold whitespace-nowrap"
            style={{
              height: 26, padding: '0 10px',
              background: 'var(--bg-elevated)', color: 'var(--ink)',
              border: '1px solid var(--border-subtle)',
            }}
            onClick={(e) => { e.stopPropagation(); onAnalyze(); }}
          >
            Analyze
          </button>
        </Tooltip>
        <Tooltip text={flow.shared ? 'Remove from your list' : 'Delete flow'}>
          <button
            className="shrink-0 inline-flex items-center justify-center rounded-md transition-colors"
            style={{
              width: 26, height: 26,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--danger)',
            }}
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            aria-label={flow.shared ? 'Remove from your list' : 'Delete flow'}
          >
            <IcoTrash />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * How full each of the seven speech columns is, averaged across every tab that
 * has anything on it — so the strip describes the whole flow, not whichever tab
 * happens to be first.
 *
 * Empty tabs are excluded rather than averaged in as zeroes: a flow with one
 * heavily-worked advantage and six untouched off-case tabs is a busy flow, and
 * counting the blanks would flatten it to almost nothing.
 *
 * Capped at four ticks. This is a shape to recognise at a glance, not a count
 * to read.
 */
function columnFill(sheets: { cells?: Record<string, string> }[] | undefined): number[] {
  const totals = new Array(7).fill(0);
  let tabsCounted = 0;

  for (const sheet of sheets ?? []) {
    const perColumn = new Array(7).fill(0);
    let anyContent = false;
    for (const key in sheet?.cells ?? {}) {
      const val = sheet.cells![key];
      if (!val || !val.replace(/<[^>]*>/g, '').trim()) continue;
      const ci = parseInt(key.split('-')[1] ?? '', 10);
      if (ci >= 0 && ci < 7) { perColumn[ci] += 1; anyContent = true; }
    }
    if (!anyContent) continue;
    tabsCounted++;
    for (let i = 0; i < 7; i++) totals[i] += perColumn[i];
  }

  if (tabsCounted === 0) return totals;
  // Round up, so a column that averages even a fraction of an argument still
  // shows one tick rather than disappearing.
  return totals.map((t) => Math.min(4, Math.ceil(t / tabsCounted)));
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
function IcoSearch() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>;
}
function IcoChevronDown() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>;
}
function IcoPlus() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
}
function IcoSparkle() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /></svg>;
}
function IcoImport() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>;
}
function IcoShare() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><polyline points="16 6 12 2 8 6" /><line x1="12" y1="2" x2="12" y2="15" /></svg>;
}
function IcoCloud() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" /></svg>;
}
function IcoDevice() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="13" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /></svg>;
}
function IcoTrash() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}
