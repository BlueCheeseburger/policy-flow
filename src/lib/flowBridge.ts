// Reading and writing a flow from outside its editor (Auto Flow), in a way a
// live flow actually takes. When the flow is open, the edit is handed to it
// and goes through the same path as typing there, so the shared copy gets it
// too. Writing storage and asking the flow to reload does not work for a live
// flow: it ignores the reload, and the shared copy wins on the next open.
// Storage is only written directly when the flow isn't open anywhere here.

import type { SheetData, StoredFlowData } from '../components/FlowView';
import { readKey, writeKey } from '../platform/storage';

export interface FlowSnapshot { sheets: SheetData[]; numRows?: number; activeSheetIdx?: number }

/** What the open flow has on screen, or the saved copy when it isn't open. */
export async function readFlow(flowId: string): Promise<FlowSnapshot | null> {
  let got: FlowSnapshot | null = null;
  window.dispatchEvent(new CustomEvent('warroom-flow-get', {
    detail: { flowId, reply: (d: FlowSnapshot) => { got = d; } },
  }));
  if (got) return got;
  const stored: StoredFlowData | null = await readKey(`flow_data_${flowId}`);
  return stored ? { sheets: stored.sheets, numRows: stored.numRows, activeSheetIdx: stored.activeSheetIdx } : null;
}

/**
 * Replace the flow's tabs. `full` re-sends every cell to a live flow's shared
 * copy (for a write whose cells only reached the screen as animation frames).
 */
export async function writeFlow(
  flowId: string,
  next: FlowSnapshot,
  opts: { full?: boolean } = {},
): Promise<void> {
  const detail: Record<string, unknown> = { flowId, ...next, full: !!opts.full, handled: false };
  window.dispatchEvent(new CustomEvent('warroom-flow-apply', { detail }));
  if (detail.handled) return;
  const stored: StoredFlowData | null = await readKey(`flow_data_${flowId}`);
  if (!stored) throw new Error('That flow is gone — it may have been deleted.');
  await writeKey(`flow_data_${flowId}`, {
    ...stored,
    sheets: next.sheets,
    numRows: next.numRows ?? stored.numRows,
    activeSheetIdx: next.activeSheetIdx ?? stored.activeSheetIdx,
  });
}
