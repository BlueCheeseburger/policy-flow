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
export default function Home({ onAutoFlow }: { onAutoFlow: () => void }) {
  const { flowsIndex, setFlowsIndex, setView, identityId } = useApp();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const { dragActive, setDragActive, dragHandlers } = useDragActive();
  const merged = useRef(false);
  // Analyze Round lives here rather than in the flow toolbar: it reads the whole
  // round at once, which is a thing you do about a flow, not inside one.
  const [analyzing, setAnalyzing] = useState<{ flowId: string; sheets: SheetData[]; columns: string[] } | null>(null);

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

  async function removeFlow(flow: FlowMeta) {
    const next = flowsIndex.filter((f) => f.id !== flow.id);
    setFlowsIndex(next);
    await writeKey('flows_index', next);
    await writeKey(`flow_data_${flow.id}`, null);
    // A flow someone else owns is only removed from YOUR list — deleting it
    // for everyone in the room is not yours to do.
    if (flow.cloud) await (flow.shared ? leaveFlow(flow.id) : cloudDeleteFlow(flow.id));
  }

  const sorted = [...flowsIndex].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

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
        <header className="flex items-end justify-between gap-8 mb-6">
          <div>
            <h1 className="text-[25px] font-semibold tracking-[-0.018em] leading-none mb-1.5">Your flows</h1>
            <p className="text-[13px]" style={{ color: 'var(--label-color)' }}>
              Saved on this device and synced privately. No account, no sign-in.
            </p>
          </div>
          {/* Three actions in priority order rather than three identical chips:
              the primary is filled, Auto Flow carries the app-wide AI ring, and
              import is quiet because it is the rarest of the three. */}
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
        </header>

        {error && (
          <p className="mb-4 text-sm" style={{ color: 'var(--danger)' }} role="alert">{error}</p>
        )}

        {importing ? (
          <div className="py-16"><LoadingState messages={['Reading your spreadsheet…']} /></div>
        ) : sorted.length === 0 ? (
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
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sorted.map((f) => (
              <li key={f.id}>
                <FlowCard
                  flow={f}
                  onOpen={() => setView({ kind: 'flow', flowId: f.id })}
                  onRemove={() => void removeFlow(f)}
                  onAnalyze={() => void openAnalyze(f)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

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
function FlowCard({ flow, onOpen, onRemove, onAnalyze }: {
  flow: FlowMeta; onOpen: () => void; onRemove: () => void; onAnalyze: () => void;
}) {
  const [fill, setFill] = useState<number[]>([]);
  // The same two colours the grid paints its columns with, so the strip reads
  // as a miniature of the actual flow rather than a differently-coloured chart.
  const { affColor, negColor } = readSettings();

  useEffect(() => {
    let cancelled = false;
    readKey<any>(`flow_data_${flow.id}`).then((data) => {
      if (cancelled) return;
      setFill(columnFill(data?.sheets?.[0]?.cells));
    });
    return () => { cancelled = true; };
  }, [flow.id]);

  return (
    <div
      className="group relative rounded-[13px] border overflow-hidden cursor-pointer transition-colors"
      style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', boxShadow: 'var(--shadow-card)' }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
    >
      <div
        className="h-[74px] px-4 pt-3.5 flex items-start gap-[5px] border-b"
        style={{ background: 'var(--bg-nest)', borderColor: 'var(--border-subtle)' }}
        aria-hidden="true"
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
        <div className="text-sm font-semibold tracking-[-0.005em] line-clamp-1 mb-2">{flow.name}</div>
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

      <div className="absolute top-2.5 right-2.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <Tooltip text="Analyze this round" up>
          <button
            className="btn-icon ai-glow-ring h-6 px-2 rounded-md text-[11px] font-semibold"
            style={{ background: 'var(--bg-elevated)', color: 'var(--ink)' }}
            onClick={(e) => { e.stopPropagation(); onAnalyze(); }}
          >
            Analyze
          </button>
        </Tooltip>
        <Tooltip text={flow.shared ? 'Remove from your list' : 'Delete flow'} up>
          <button
            className="btn-icon w-6 h-6 rounded-md"
            style={{ background: 'var(--bg-elevated)', color: 'var(--ink-muted)' }}
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
          >
            <IcoClose />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * How many rows each of the seven speech columns holds, capped at four ticks —
 * the strip is a shape to recognise, not a count to read.
 */
function columnFill(cells: Record<string, string> | undefined): number[] {
  const counts = new Array(7).fill(0);
  for (const key in cells ?? {}) {
    const val = cells![key];
    if (!val || !val.replace(/<[^>]*>/g, '').trim()) continue;
    const ci = parseInt(key.split('-')[1] ?? '', 10);
    if (ci >= 0 && ci < 7) counts[ci] = Math.min(4, counts[ci] + 1);
  }
  return counts;
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
function IcoClose() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>;
}
