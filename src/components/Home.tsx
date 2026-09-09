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
      className="flex-1 overflow-auto p-8"
      {...dragHandlers}
      onDrop={async (e) => {
        e.preventDefault();
        setDragActive(false);
        const handles = resolveDroppedFiles(e.dataTransfer.files, ['xlsx']);
        if (handles.length) await importHandles(handles);
        else setError('Drop a .xlsx spreadsheet to import it as a flow.');
      }}
    >
      <div className="max-w-4xl mx-auto">
        <header className="flex items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-semibold">Your flows</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--label-color)' }}>
              Saved on this device and synced privately. No account, no sign-in.
            </p>
          </div>
          <div className="flex gap-2">
            <Tooltip text="Sort a speech doc into a flow">
              <button className="btn ai-glow-ring px-3 py-1.5" onClick={onAutoFlow}>Auto Flow</button>
            </Tooltip>
            <Tooltip text="Import a spreadsheet">
              <button className="btn px-3 py-1.5" onClick={async () => importHandles(await openFiles(['xlsx']))}>
                Import .xlsx
              </button>
            </Tooltip>
            <button className="btn btn-primary px-3 py-1.5" onClick={newFlow}>New flow</button>
          </div>
        </header>

        {error && (
          <p className="mb-4 text-sm" style={{ color: 'var(--danger)' }} role="alert">{error}</p>
        )}

        {importing ? (
          <div className="py-16"><LoadingState messages={['Reading your spreadsheet…']} /></div>
        ) : sorted.length === 0 ? (
          <div
            className="rounded-xl border border-dashed py-20 text-center"
            style={{ borderColor: dragActive ? 'var(--accent)' : 'var(--border-color)' }}
          >
            <p className="text-sm font-medium">No flows yet</p>
            <p className="text-xs mt-1" style={{ color: 'var(--label-color)' }}>
              Start a new one, or drop a .xlsx here to import it.
            </p>
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sorted.map((f) => (
              <li key={f.id}>
                <div
                  className="group relative rounded-xl border p-4 h-28 flex flex-col justify-between cursor-pointer transition-colors"
                  style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}
                  onClick={() => setView({ kind: 'flow', flowId: f.id })}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView({ kind: 'flow', flowId: f.id }); } }}
                >
                  <span className="font-medium text-sm line-clamp-2">{f.name}</span>
                  <span className="text-xs flex items-center gap-2" style={{ color: 'var(--label-color)' }}>
                    {f.live && <span title="Live room">● Live</span>}
                    {f.shared && <span>Shared with you</span>}
                    {!f.live && !f.shared && f.cloud && <span>Synced</span>}
                    {!f.cloud && <span>On this device</span>}
                  </span>
                  <Tooltip text={f.shared ? 'Remove from your list' : 'Delete flow'} up>
                    <button
                      className="btn-icon absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 px-1.5 text-xs"
                      onClick={(e) => { e.stopPropagation(); void removeFlow(f); }}
                    >
                      ✕
                    </button>
                  </Tooltip>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
