// Undo in a shared flow.
//
// FlowView's undo history is a list of whole-flow snapshots of THIS user's
// edits. Restoring one wholesale is fine alone, but in a live room it also
// rolls back whatever partners did since — and undo is pushed to the room, so
// a partner's text would vanish for everyone. Two rules keep undo to your own
// work:
//
//   1. A step only reverts what that step changed. mergeUndoStep compares the
//      snapshot being left with the one being restored; anything the two agree
//      on keeps its CURRENT value, which includes partner edits.
//   2. Partner edits are written into every snapshot as they arrive
//      (rebaseCell / rebaseArrows), so going back several steps never treats
//      them as something to undo either.

export interface UndoSheet {
  id: string;
  name: string;
  cells: Record<string, string>;
  arrows?: readonly unknown[];
}

export interface UndoMergeResult<S extends UndoSheet> {
  sheets: S[];
  /**
   * Cell keys the step changed, per sheet id — the only cells that should be
   * written to the shared doc. `null` = the whole sheet (it came back from a
   * deleted tab, so the doc has none of its cells).
   */
  changed: Map<string, Set<string> | null>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function mergeUndoStep<S extends UndoSheet>(live: S[], from: S[], to: S[]): UndoMergeResult<S> {
  const liveById = new Map(live.map((s) => [s.id, s]));
  const fromById = new Map(from.map((s) => [s.id, s]));
  const toIds = new Set(to.map((s) => s.id));
  const changed = new Map<string, Set<string> | null>();

  const sheets = to.map((t) => {
    const f = fromById.get(t.id);
    const l = liveById.get(t.id);
    // A tab this step brings back (undoing a delete), or one that isn't here
    // any more: nothing current to preserve, so the saved copy is the answer.
    if (!f || !l) { changed.set(t.id, null); return t; }

    const cells = { ...l.cells };
    const keys = new Set<string>();
    for (const k of new Set([...Object.keys(f.cells ?? {}), ...Object.keys(t.cells ?? {})])) {
      const fv = f.cells?.[k] ?? '';
      const tv = t.cells?.[k] ?? '';
      if (fv === tv) continue;
      if (tv) cells[k] = tv; else delete cells[k];
      keys.add(k);
    }
    changed.set(t.id, keys);

    // Every other field (name, arrows, AI marks…): the step's version if the
    // step changed it, the current one otherwise.
    const fr = f as unknown as Record<string, unknown>;
    const tr = t as unknown as Record<string, unknown>;
    const lr = l as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = { ...lr };
    for (const field of new Set([...Object.keys(tr), ...Object.keys(lr)])) {
      if (field === 'id' || field === 'cells') continue;
      out[field] = same(fr[field], tr[field]) ? lr[field] : tr[field];
    }
    out.cells = cells;
    return out as unknown as S;
  });

  // Tabs a partner added since: in neither snapshot, so this step can't have
  // made them, and undo must not remove them.
  for (const l of live) {
    if (!toIds.has(l.id) && !fromById.has(l.id)) sheets.push(l);
  }
  return { sheets, changed };
}

/** Write a partner's cell edit into every snapshot, so undo leaves it alone. */
export function rebaseCell(history: readonly { sheets: readonly UndoSheet[] }[], sheetId: string, key: string, html: string): void {
  for (const snap of history) {
    const sh = snap.sheets.find((s) => s.id === sheetId);
    if (!sh) continue;
    if (html) sh.cells[key] = html; else delete sh.cells[key];
  }
}

/** Same, for a tab's arrows. */
export function rebaseArrows(history: readonly { sheets: readonly UndoSheet[] }[], sheetId: string, arrows: readonly unknown[]): void {
  for (const snap of history) {
    const sh = snap.sheets.find((s) => s.id === sheetId);
    if (sh) (sh as { arrows?: readonly unknown[] }).arrows = arrows.map((a) => ({ ...(a as object) }));
  }
}
