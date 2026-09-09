// Arrow endpoints on a flow — the two shapes, and the maths that resolves them.
//
// An arrow used to be anchored to two CELLS ("3-1" → "3-2"), and its geometry was
// derived from those cells' rectangles. That is still how Auto Flow draws one: it
// knows an answer card responds to a specific card, so anchoring is exactly right
// and the line should follow if a row is inserted above it.
//
// A hand-drawn arrow is a different thing. The user clicks two arbitrary points,
// and snapping them to the nearest cell is precisely the behavior that made the
// tool feel like it was fighting them. So a free arrow carries its own endpoints
// and no cell reference at all.
//
// Both live in the same `arrows` array on a sheet, told apart by which fields are
// present. Pure so scripts/test-flow-arrow-geo.ts can exercise it without React.

export interface FlowArrowLike {
  id: string;
  from?: string;
  to?: string;
  fx1?: number; fy1?: number;
  fx2?: number; fy2?: number;
}

/**
 * Free endpoints are stored as FRACTIONS of the grid's content box, not pixels.
 *
 * The grid is not a fixed canvas: zoom, the auto-fit-columns preference, a
 * sidebar collapse, and a column drag all change its width. A pixel-anchored
 * line would sit still while the flow moved out from under it. A fraction keeps
 * the line where the user put it *relative to the flow*, which is what they
 * actually pointed at.
 */
export function isFreeArrow(a: FlowArrowLike): boolean {
  return typeof a.fx1 === 'number' && typeof a.fy1 === 'number'
      && typeof a.fx2 === 'number' && typeof a.fy2 === 'number';
}

/** Cell-anchored — Auto Flow's, and anything drawn before free arrows existed. */
export function isCellArrow(a: FlowArrowLike): boolean {
  return !isFreeArrow(a) && typeof a.from === 'string' && typeof a.to === 'string';
}

/** Fractions are clamped on the way IN, so a stray drag can't park a line off-flow. */
export function toFraction(px: number, size: number): number {
  if (!Number.isFinite(px) || !Number.isFinite(size) || size <= 0) return 0;
  return Math.min(1, Math.max(0, px / size));
}

export function fromFraction(f: number, size: number): number {
  return (Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0) * (size > 0 ? size : 0);
}

/** Always `M x1 y1 L x2 y2` — one straight segment, never a curve. */
export function straightPath(x1: number, y1: number, x2: number, y2: number): string {
  return `M ${x1} ${y1} L ${x2} ${y2}`;
}

/**
 * Row-insert remapping. Only a CELL arrow's endpoints shift when a row is pushed
 * down — a free arrow is anchored to the sheet, not to a row, so bumping its
 * (nonexistent) cell keys would be meaningless and stamping `from`/`to` onto it
 * would turn it into a cell arrow pointing at cells the user never chose.
 */
/**
 * Drop every CELL arrow with an end in `keys` — the cells a move or a delete is
 * about to change out from under it.
 *
 * An arrow means "this argument answers that one". Once either end has moved to
 * a different row or column, or been overwritten, the line no longer says
 * anything true: re-anchoring it would silently point at whatever now happens to
 * sit there, which is worse than losing it. Free (hand-drawn) arrows are
 * anchored to the sheet, not to a cell, so they are never touched here.
 */
export function dropArrowsTouching<T extends FlowArrowLike>(arrows: T[], keys: Set<string>): T[] {
  if (keys.size === 0) return arrows;
  return (arrows ?? []).filter((a) =>
    !isCellArrow(a) || (!keys.has(a.from as string) && !keys.has(a.to as string)));
}

export function bumpArrow<T extends FlowArrowLike>(a: T, bump: (key: string) => string): T {
  if (!isCellArrow(a)) return a;
  return { ...a, from: bump(a.from as string), to: bump(a.to as string) };
}
