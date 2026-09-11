// flowSync — binds a Y.Doc to a Supabase Realtime broadcast channel.
//
// Warroom ran this through the Electron main process, which held the Supabase
// client and relayed everything over IPC. In the browser the page IS the
// client, so the same responsibilities collapse into one file:
//
//   • load the durable snapshot from pf_flows on join
//   • relay local Yjs updates out over broadcast; apply remote ones in
//   • awareness (who is editing which cell) for live remote cursors
//   • late-join convergence: when a new peer appears, re-broadcast full state
//     so anyone who joined after the last snapshot still ends up consistent
//   • debounced snapshot persistence back to pf_flows
//
// The channel is keyed on the flow's uuid. Anyone who can reach that channel
// can read the room, which is the same reachability the share link grants — a
// v4 uuid is not guessable, and there is no listing of live channels.

import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { u8ToB64, b64ToU8, REMOTE_ORIGIN } from './flowDoc';
import { supabase } from '../platform/supabase';
import { loadSnapshot, saveSnapshot } from '../platform/cloud';

export interface PresenceUser { id: string; name: string; color: string }
export interface RemoteCursor { user: PresenceUser; sheetId: string | null; cell: string | null }

// SUBSCRIBED = actively syncing. CHANNEL_ERROR/TIMED_OUT/CLOSED = not currently
// synced — edits still save locally (this doc keeps working offline), they just
// aren't reaching anyone until it reconnects.
export type FlowSyncStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED' | 'CONNECTING';

export interface FlowSyncHandle {
  doc: Y.Doc;
  awareness: Awareness;
  setActiveCell: (sheetId: string | null, cell: string | null) => void;
  onCursors: (cb: (cursors: RemoteCursor[]) => void) => () => void;
  /** Current + future connection status. Fires immediately with what's known. */
  onStatus: (cb: (status: FlowSyncStatus) => void) => () => void;
  saveSnapshotNow: () => void;
  destroy: () => Promise<void>;
}

const SNAPSHOT_DEBOUNCE = 4000;

export async function createFlowSync(
  flowId: string,
  flowName: string,
  me: PresenceUser,
): Promise<FlowSyncHandle> {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalState({ user: me, sheetId: null, cell: null });

  const statusSubs = new Set<(s: FlowSyncStatus) => void>();
  let currentStatus: FlowSyncStatus = 'CONNECTING';
  function emitStatus(s: FlowSyncStatus) {
    currentStatus = s;
    statusSubs.forEach((cb) => cb(s));
  }

  // 1) Hydrate from the durable snapshot before we go live.
  try {
    const snap = await loadSnapshot(flowId);
    if (snap.ok && snap.data.content) Y.applyUpdate(doc, b64ToU8(snap.data.content), REMOTE_ORIGIN);
  } catch { /* fall through — broadcast convergence will catch us up */ }

  // 2) Subscribe to the broadcast channel.
  let channel: RealtimeChannel | null = null;
  if (supabase) {
    channel = supabase.channel(`pf-flow-${flowId}`, {
      config: { broadcast: { self: false }, presence: { key: me.id } },
    });

    channel.on('broadcast', { event: 'y-update' }, ({ payload }) => {
      if (!payload?.update) return;
      Y.applyUpdate(doc, b64ToU8(payload.update), REMOTE_ORIGIN);
    });

    channel.on('broadcast', { event: 'y-awareness' }, ({ payload }) => {
      if (!payload?.awareness) return;
      applyAwarenessUpdate(awareness, b64ToU8(payload.awareness), REMOTE_ORIGIN);
    });

    // 5) Presence: when the peer set GROWS, re-broadcast full state + awareness
    //    so late joiners converge even if they missed the deltas.
    let lastPeerCount = 0;
    channel.on('presence', { event: 'sync' }, () => {
      const count = Object.keys(channel!.presenceState()).length;
      if (count > lastPeerCount) {
        send('y-update', { update: u8ToB64(Y.encodeStateAsUpdate(doc)) });
        const ids = Array.from(awareness.getStates().keys());
        send('y-awareness', { awareness: u8ToB64(encodeAwarenessUpdate(awareness, ids)) });
      }
      lastPeerCount = count;
    });

    channel.subscribe((status) => {
      emitStatus(status as FlowSyncStatus);
      if (status === 'SUBSCRIBED') channel!.track({ id: me.id, color: me.color });
    });
  } else {
    emitStatus('CLOSED');
  }

  function send(event: string, payload: Record<string, unknown>) {
    if (!channel || currentStatus !== 'SUBSCRIBED') return;
    // Fire-and-forget: a dropped frame is recovered by the late-join full-state
    // re-broadcast, so awaiting each one would only add latency to typing.
    void channel.send({ type: 'broadcast', event, payload });
  }

  // 3) Local doc edits → broadcast (skip anything we applied from remote).
  const onDocUpdate = (update: Uint8Array, origin: any) => {
    if (origin === REMOTE_ORIGIN) return;
    send('y-update', { update: u8ToB64(update) });
    scheduleSnapshot();
  };
  doc.on('update', onDocUpdate);

  // 4) Awareness (cursor presence) over the same channel.
  const onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: any,
  ) => {
    if (origin === REMOTE_ORIGIN) return;
    const changed = added.concat(updated, removed);
    send('y-awareness', { awareness: u8ToB64(encodeAwarenessUpdate(awareness, changed)) });
  };
  awareness.on('update', onAwarenessUpdate);

  // 6) Debounced snapshot persistence.
  let snapTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleSnapshot() {
    if (snapTimer) clearTimeout(snapTimer);
    snapTimer = setTimeout(saveSnapshotNow, SNAPSHOT_DEBOUNCE);
  }
  function saveSnapshotNow() {
    if (snapTimer) { clearTimeout(snapTimer); snapTimer = null; }
    void saveSnapshot(flowId, flowName, u8ToB64(Y.encodeStateAsUpdate(doc))).catch(() => undefined);
  }

  // 7) Cursor fan-out to the UI.
  const cursorSubs = new Set<(c: RemoteCursor[]) => void>();
  function emitCursors() {
    const out: RemoteCursor[] = [];
    awareness.getStates().forEach((st: any, clientId: number) => {
      if (clientId === doc.clientID) return;          // skip self
      if (!st?.user) return;
      out.push({ user: st.user, sheetId: st.sheetId ?? null, cell: st.cell ?? null });
    });
    cursorSubs.forEach((cb) => cb(out));
  }
  awareness.on('change', emitCursors);

  return {
    doc,
    awareness,
    setActiveCell(sheetId, cell) {
      awareness.setLocalStateField('sheetId', sheetId);
      awareness.setLocalStateField('cell', cell);
    },
    onCursors(cb) {
      cursorSubs.add(cb);
      cb([]);
      return () => { cursorSubs.delete(cb); };
    },
    onStatus(cb) {
      statusSubs.add(cb);
      cb(currentStatus);
      return () => { statusSubs.delete(cb); };
    },
    saveSnapshotNow,
    async destroy() {
      saveSnapshotNow();
      doc.off('update', onDocUpdate);
      awareness.off('update', onAwarenessUpdate);
      awareness.off('change', emitCursors);
      removeAwarenessStates(awareness, [doc.clientID], 'local');
      if (channel) { try { await supabase?.removeChannel(channel); } catch { /* already gone */ } }
      awareness.destroy();
      doc.destroy();
      cursorSubs.clear();
      statusSubs.clear();
    },
  };
}
