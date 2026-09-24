import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { readKey, writeKey } from '../platform/storage';
import { setYText, LOCAL_ORIGIN } from '../lib/flowDoc';
import type { FlowSyncHandle } from '../lib/flowSync';

/**
 * A flow's free-standing notes — the cross-ex outline and the RFD — as one
 * shared string. Kept out of the flow's grid data on purpose: grid undo never
 * touches a note. Stored locally under `flow_<name>_<flowId>`; in a live room
 * it's the doc's `<name>` Y.Text, so partners see each other's typing and it
 * rides along in the cloud snapshot.
 *
 * `ref` mirrors `text` for code that runs outside a render (seeding the live
 * doc, snapshots).
 */
export function useLiveNote(
  name: 'cx' | 'rfd',
  flowId: string | null | undefined,
  syncRef: React.MutableRefObject<FlowSyncHandle | null>,
  liveRef: React.MutableRefObject<boolean>,
  liveReady: boolean,
) {
  const [text, setText] = useState('');
  const ref = useRef('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function saveLocal(next: string) {
    if (!flowId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const id = flowId;
    saveTimer.current = setTimeout(() => { void writeKey(`flow_${name}_${id}`, next); }, 400);
  }

  // Load this flow's copy. The live doc, if it already has the note, wins.
  useEffect(() => {
    if (!flowId) return;
    ref.current = ''; setText('');
    let cancelled = false;
    void readKey(`flow_${name}_${flowId}`).then((v) => {
      if (cancelled || typeof v !== 'string') return;
      if (syncRef.current?.doc.getText(name).toString()) return;
      ref.current = v; setText(v);
      const yt = syncRef.current?.doc.getText(name);
      if (yt && liveRef.current) setYText(yt, v, LOCAL_ORIGIN);
    });
    return () => { cancelled = true; };
  }, [flowId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Join the room's copy: adopt it, or contribute ours if the room has none.
  useEffect(() => {
    const handle = syncRef.current;
    if (!liveReady || !handle) return;
    const yt = handle.doc.getText(name);
    const shared = yt.toString();
    if (!shared && ref.current) setYText(yt, ref.current, LOCAL_ORIGIN);
    else if (shared !== ref.current) { ref.current = shared; setText(shared); saveLocal(shared); }
    const onChange = (_e: unknown, tr: Y.Transaction) => {
      if (tr.origin === LOCAL_ORIGIN) return;
      const v = yt.toString();
      if (v === ref.current) return;
      ref.current = v; setText(v); saveLocal(v);
    };
    yt.observe(onChange);
    return () => yt.unobserve(onChange);
  }, [liveReady]); // eslint-disable-line react-hooks/exhaustive-deps

  function update(next: string) {
    if (next === ref.current) return;
    ref.current = next; setText(next);
    saveLocal(next);
    const yt = liveRef.current ? syncRef.current?.doc.getText(name) : null;
    if (yt) setYText(yt, next, LOCAL_ORIGIN);
  }

  return { text, ref, update };
}
