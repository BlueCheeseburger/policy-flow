// Put one or more rows into a column of a flow sheet, at a spot the user
// picked: an empty cell, or a gap between two cells. Used by Auto Flow's
// "place these cards" step for the cards the parser couldn't sort.
//
//   'cell'   — the first row goes in the picked (empty) cell; each following
//              row goes in the next cell down, and where that cell is already
//              taken, the column below opens up by one to make room.
//   'insert' — the column opens up at the picked row by as many rows as there
//              are to place, and they go in, in order.
//
// Opening a column moves its cells, and any arrow ends on them, down with it;
// other columns are untouched. Pure, so scripts/test-flow-place.ts can pin it.

export interface PlaceSheet<A extends { from?: string; to?: string } = { from?: string; to?: string }> {
  cells: Record<string, string>;
  arrows?: A[];
  aiCells?: string[];
}

export interface PlaceResult<T extends PlaceSheet> {
  sheet: T;
  /** Rows the written cells landed on, in order. */
  rows: number[];
  /** One past the deepest row now holding anything in this column. */
  depth: number;
}

const filled = (cells: Record<string, string>, r: number, c: number) => !!(cells[`${r}-${c}`] ?? '').trim();

/** Push column `ci` down by `n` from row `at`, carrying arrow ends and AI marks. */
function openGap<T extends PlaceSheet>(sheet: T, ci: number, at: number, n: number): T {
  const moved: Record<string, string> = {};
  for (const [key, html] of Object.entries(sheet.cells)) {
    const [rs, cs] = key.split('-');
    const r = Number(rs), c = Number(cs);
    moved[c === ci && r >= at ? `${r + n}-${c}` : key] = html;
  }
  const bump = (key?: string) => {
    if (!key) return key;
    const [rs, cs] = key.split('-');
    const r = Number(rs), c = Number(cs);
    return c === ci && r >= at ? `${r + n}-${c}` : key;
  };
  return {
    ...sheet,
    cells: moved,
    arrows: sheet.arrows?.map((a) => (a.from || a.to ? { ...a, from: bump(a.from), to: bump(a.to) } : a)),
    aiCells: sheet.aiCells?.map((k) => bump(k)!),
  };
}

export function placeRows<T extends PlaceSheet>(
  sheet: T, ci: number, ri: number, mode: 'cell' | 'insert', htmls: string[],
): PlaceResult<T> {
  let s: T = { ...sheet, cells: { ...sheet.cells } };
  const rows: number[] = [];
  if (mode === 'insert') {
    s = openGap(s, ci, ri, htmls.length);
    htmls.forEach((h, k) => { s.cells[`${ri + k}-${ci}`] = h; rows.push(ri + k); });
  } else {
    htmls.forEach((h, k) => {
      const r = ri + k;
      if (filled(s.cells, r, ci)) s = openGap(s, ci, r, 1);
      s.cells[`${r}-${ci}`] = h;
      rows.push(r);
    });
  }
  let depth = 0;
  for (const key of Object.keys(s.cells)) {
    const [rs, cs] = key.split('-');
    if (Number(cs) === ci && filled(s.cells, Number(rs), ci)) depth = Math.max(depth, Number(rs) + 1);
  }
  return { sheet: s, rows, depth };
}

/** The row after the last filled cell of a column (0 for an empty column). */
export function nextFreeRow(cells: Record<string, string>, ci: number): number {
  let next = 0;
  for (const key of Object.keys(cells)) {
    const [rs, cs] = key.split('-');
    if (Number(cs) === ci && filled(cells, Number(rs), ci)) next = Math.max(next, Number(rs) + 1);
  }
  return next;
}
