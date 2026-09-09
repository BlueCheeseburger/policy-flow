// Selecting several flow cells at once, and moving them as a group.
//
// A selection is always WITHIN ONE COLUMN. That isn't a simplification for its
// own sake: a column is a speech, and the whole point of grabbing a run of
// cells is "these arguments belong somewhere else" — either further down this
// speech, or over in the speech that answers it. A rectangle spanning columns
// has no honest answer for what ⌘← should do to it.
//
// Moving INSERTS. Cells go into the destination rows and whatever was already
// there slides down to the next free row, the way inserting a line into a list
// works — a move never destroys an argument. The cost is that a move can't step
// *past* occupied cells: nudging down shoves the neighbour along ahead of it
// rather than trading places with it.
//
// Everything here is pure so scripts/test-flow-selection.ts can exercise it
// without React or a DOM. FlowView.tsx owns the pointer/keyboard handling.

export interface CellSelection {
  /** Column index every selected cell sits in. */
  col: number;
  /** Row indices, ascending, no duplicates. */
  rows: number[];
}

export function cellKey(row: number, col: number): string { return `${row}-${col}`; }

export function isSelected(sel: CellSelection | null, row: number, col: number): boolean {
  return !!sel && sel.col === col && sel.rows.includes(row);
}

function normalize(col: number, rows: number[]): CellSelection | null {
  const uniq = [...new Set(rows)].filter((r) => r >= 0).sort((a, b) => a - b);
  return uniq.length ? { col, rows: uniq } : null;
}

/**
 * ⌘-click: add this cell, or drop it if it was already in. Clicking into a
 * different column starts over rather than silently abandoning the old column —
 * a selection that spanned two columns couldn't be moved sideways.
 */
export function toggleCell(sel: CellSelection | null, row: number, col: number): CellSelection | null {
  if (!sel || sel.col !== col) return { col, rows: [row] };
  return sel.rows.includes(row)
    ? normalize(col, sel.rows.filter((r) => r !== row))
    : normalize(col, [...sel.rows, row]);
}

/** Shift-click: every row between the anchor and here, inclusive. */
export function rangeTo(anchorRow: number, row: number, col: number): CellSelection {
  const lo = Math.min(anchorRow, row), hi = Math.max(anchorRow, row);
  return { col, rows: Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) };
}

export interface MovePlan {
  /** Source keys, in selection order. */
  from: string[];
  /** Destination keys, parallel to `from`. */
  to: string[];
  /** Where the selection ends up. */
  next: CellSelection;
  /** Every cell key the move disturbs — sources and destinations. Arrows
   *  touching any of these are dropped (see dropArrowsTouching). */
  touched: Set<string>;
}

/**
 * Where a move by (dRow, dCol) would land, or null if it can't happen.
 *
 * The group keeps its internal spacing — a selection of rows 3, 4 and 9 moved
 * down one is 4, 5 and 10, gap intact. `clamp` is for dragging, where the
 * pointer can wander past the end of the grid and the sane response is to stop
 * at the edge; a keyboard move refuses instead, so ⌘↓ at the bottom does
 * nothing rather than quietly collapsing the group against the last row.
 */
export function planMove(
  sel: CellSelection | null,
  dRow: number,
  dCol: number,
  numRows: number,
  numCols: number,
  opts: { clamp?: boolean } = {},
): MovePlan | null {
  if (!sel || sel.rows.length === 0) return null;
  const col = sel.col + dCol;
  if (col < 0 || col >= numCols) return null;

  let shift = dRow;
  const lo = sel.rows[0], hi = sel.rows[sel.rows.length - 1];
  if (lo + shift < 0 || hi + shift > numRows - 1) {
    if (!opts.clamp) return null;
    shift = Math.max(-lo, Math.min(shift, numRows - 1 - hi));
  }
  if (shift === 0 && dCol === 0) return null;

  const from = sel.rows.map((r) => cellKey(r, sel.col));
  const rows = sel.rows.map((r) => r + shift);
  const to = rows.map((r) => cellKey(r, col));
  return { from, to, next: { col, rows }, touched: new Set([...from, ...to]) };
}

/** The same thing, for a drop: put the grabbed cell on `targetRow`/`targetCol`. */
export function planDrop(
  sel: CellSelection | null,
  grabRow: number,
  targetRow: number,
  targetCol: number,
  numRows: number,
  numCols: number,
): MovePlan | null {
  if (!sel) return null;
  return planMove(sel, targetRow - grabRow, targetCol - sel.col, numRows, numCols, { clamp: true });
}

export interface InsertResult {
  cells: Record<string, string>;
  /** Cells the insert pushed out of the way: old key → new key. Their arrows
   *  follow them (the argument didn't change, only its row). */
  shifted: Map<string, string>;
}

/**
 * Put `payload` into `rows` of `col`, sliding whatever is already there down to
 * the next free row.
 *
 * The slide cascades: dropping onto a run of three filled rows pushes the whole
 * run down one, into the first gap under it. Only that run moves — content
 * further down, past a gap, stays exactly where it is, which is what makes this
 * feel like inserting a line rather than shunting the whole column.
 *
 * Returns null if there is no free row left below to absorb the displaced
 * content. Refusing is the only honest answer there: the alternative is pushing
 * an argument off the bottom of the sheet, and losing evidence to a keystroke is
 * not a trade anyone would take.
 *
 * A blank cell in the payload inserts nothing and pushes nothing — moving an
 * empty cell shouldn't disturb the column it lands in.
 */
export function insertCells(
  cells: Record<string, string>,
  col: number,
  rows: number[],
  payload: string[],
  numRows: number,
): InsertResult | null {
  const next = { ...cells };
  // Work on the destination column as slots that remember where they started,
  // so a cell pushed twice (once per inserted row) is still tracked back to its
  // original position for the arrow remap.
  const slots = new Map<number, { html: string; from: number | null }>();
  for (let r = 0; r < numRows; r++) {
    const v = next[cellKey(r, col)];
    if (v) slots.set(r, { html: v, from: r });
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!payload[i]) continue;
    if (slots.has(row)) {
      let free = row;
      while (free < numRows && slots.has(free)) free++;
      if (free >= numRows) return null;               // nowhere to put the displaced content
      for (let r = free; r > row; r--) slots.set(r, slots.get(r - 1)!);
      slots.delete(row);
    }
    slots.set(row, { html: payload[i], from: null });
  }

  for (let r = 0; r < numRows; r++) delete next[cellKey(r, col)];
  const shifted = new Map<string, string>();
  slots.forEach((slot, r) => {
    next[cellKey(r, col)] = slot.html;
    if (slot.from !== null && slot.from !== r) shifted.set(cellKey(slot.from, col), cellKey(r, col));
  });
  return { cells: next, shifted };
}

/**
 * Apply a plan: lift the selection out, then insert it at the destination.
 *
 * Lifting first is what makes a same-column nudge work — the rows the selection
 * vacates are free by the time the insert looks for room, so moving a block down
 * one doesn't push against itself.
 */
export function applyMove(cells: Record<string, string>, plan: MovePlan, numRows: number): InsertResult | null {
  const payload = plan.from.map((k) => cells[k] ?? '');
  const lifted = { ...cells };
  plan.from.forEach((k) => { delete lifted[k]; });
  return insertCells(lifted, plan.next.col, plan.next.rows, payload, numRows);
}

/** Drop a payload onto another sheet (a cross-tab drag) — same insert rule. */
export function applyPaste(
  cells: Record<string, string>,
  col: number,
  rows: number[],
  payload: string[],
  numRows: number,
): InsertResult | null {
  return insertCells(cells, col, rows, payload, numRows);
}

/** Empty every selected cell (Delete with a selection). */
export function clearCells(cells: Record<string, string>, keys: string[]): Record<string, string> {
  const next = { ...cells };
  keys.forEach((k) => delete next[k]);
  return next;
}

/** The keys a selection covers, ascending. */
export function selectionKeys(sel: CellSelection | null): string[] {
  return sel ? sel.rows.map((r) => cellKey(r, sel.col)) : [];
}
