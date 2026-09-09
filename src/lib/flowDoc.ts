// flowDoc — the Yjs document model for a *live* (collaboratively edited) flow.
//
// A flow's editable state is mapped onto a Y.Doc so two teammates can type into
// it at once and have their edits merge character-by-character (CRDT). Layout
// stuff that changes rarely (columns, colors, variant) lives in a single `meta`
// Y.Map as last-write-wins values; the high-frequency stuff (cell text) lives in
// per-cell Y.Text so concurrent edits inside the grid merge cleanly.
//
//   doc.getMap('meta')              event, variant, pfOrder, fontSize, zoom,
//                                   customColumns, columnWidths, columnColors
//   doc.getArray('sheets')          one Y.Map per sheet:
//       { id, name, cells: Y.Map<cellKey, Y.Text>, arrows: Y.Array<arrow> }
//
// Each cell's Y.Text holds the cell's *HTML string* (the same value FlowView
// stores in localStorage), so character-level merge works on the raw markup.
// For the common plain-text cell, HTML === text and merges are clean; the only
// lossy case is two people editing the exact same cell across a formatting tag
// boundary at the same instant — rare, and recoverable.

import * as Y from 'yjs';

export const LOCAL_ORIGIN = 'local';
export const REMOTE_ORIGIN = 'remote';

// The arrow shape is shared, not re-declared: a narrower local copy would type-
// check while silently dropping a free arrow's fx/fy fields on the way through
// live sync, so a hand-drawn arrow would vanish for everyone but its author.
// flowArrowGeo imports nothing, so this creates no cycle.
import type { FlowArrowLike } from './flowArrowGeo';

// Mirrors StoredFlowData in FlowView (kept structural to avoid an import cycle).
export interface FlowDocData {
  event: 'policy' | 'pf';
  variant: 'stock-issues' | 'advantage';
  pfOrder: 'pro-first' | 'con-first';
  sheets: { id: string; name: string; cells: Record<string, string>; arrows?: FlowArrowLike[] }[];
  columnWidths: number[];
  customColumns: string[] | null;
  columnColors: (string | null)[];
  fontSize: number;
  zoom: number;
}

export function metaMap(doc: Y.Doc): Y.Map<any> { return doc.getMap('meta'); }
export function sheetsArr(doc: Y.Doc): Y.Array<Y.Map<any>> { return doc.getArray('sheets'); }

export function sheetCells(sheet: Y.Map<any>): Y.Map<Y.Text> {
  return sheet.get('cells') as Y.Map<Y.Text>;
}
export function sheetArrows(sheet: Y.Map<any>): Y.Array<any> {
  return sheet.get('arrows') as Y.Array<any>;
}

// Find a sheet Y.Map by its stable id.
export function findSheet(doc: Y.Doc, sheetId: string): Y.Map<any> | null {
  const arr = sheetsArr(doc);
  for (let i = 0; i < arr.length; i++) {
    const s = arr.get(i);
    if (s.get('id') === sheetId) return s;
  }
  return null;
}

// Get (creating if missing) the Y.Text backing one cell of one sheet.
export function cellText(doc: Y.Doc, sheetId: string, cellKey: string): Y.Text | null {
  const sheet = findSheet(doc, sheetId);
  if (!sheet) return null;
  const cells = sheetCells(sheet);
  let t = cells.get(cellKey);
  if (!t) { t = new Y.Text(); cells.set(cellKey, t); }
  return t;
}

// Apply a target string to a Y.Text as a single contiguous edit (the shape a
// keystroke or a paste-replace produces). Computes the common prefix/suffix and
// rewrites only the middle, so concurrent edits elsewhere in the cell survive.
export function setYText(ytext: Y.Text, next: string, origin: any = LOCAL_ORIGIN): void {
  const prev = ytext.toString();
  if (prev === next) return;
  let start = 0;
  const minLen = Math.min(prev.length, next.length);
  while (start < minLen && prev[start] === next[start]) start++;
  let endPrev = prev.length, endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) { endPrev--; endNext--; }
  const delCount = endPrev - start;
  const insStr = next.slice(start, endNext);
  const doc = ytext.doc;
  const run = () => {
    if (delCount > 0) ytext.delete(start, delCount);
    if (insStr) ytext.insert(start, insStr);
  };
  if (doc) doc.transact(run, origin); else run();
}

// ── Seeding / extraction ─────────────────────────────────────────────────────

// Populate an empty Y.Doc from a flow's plain stored data (used when a flow is
// first promoted to live). `cellToHtml` upgrades any legacy plain-text cells.
export function seedDoc(doc: Y.Doc, data: FlowDocData, cellToHtml: (v: string) => string): void {
  doc.transact(() => {
    const meta = metaMap(doc);
    meta.set('event', data.event);
    meta.set('variant', data.variant);
    meta.set('pfOrder', data.pfOrder);
    meta.set('fontSize', data.fontSize);
    meta.set('zoom', data.zoom);
    meta.set('customColumns', data.customColumns);
    meta.set('columnWidths', data.columnWidths);
    meta.set('columnColors', data.columnColors);

    const sheets = sheetsArr(doc);
    for (const sh of data.sheets) {
      const sm = new Y.Map();
      sm.set('id', sh.id);
      sm.set('name', sh.name);
      const cells = new Y.Map<Y.Text>();
      for (const [k, v] of Object.entries(sh.cells)) {
        if (!v) continue;
        const t = new Y.Text();
        t.insert(0, cellToHtml(v));
        cells.set(k, t);
      }
      sm.set('cells', cells);
      const arrows = new Y.Array();
      if (sh.arrows?.length) arrows.push(sh.arrows.map((a) => ({ ...a })));
      sm.set('arrows', arrows);
      sheets.push([sm]);
    }
  }, LOCAL_ORIGIN);
}

// Read the whole Y.Doc back into the plain stored shape (for localStorage mirror,
// export, and AI reads). Returns null if the doc hasn't been seeded yet.
export function docToData(doc: Y.Doc): FlowDocData | null {
  const meta = metaMap(doc);
  const sheets = sheetsArr(doc);
  if (sheets.length === 0 || !meta.get('event')) return null;
  const outSheets = [] as FlowDocData['sheets'];
  for (let i = 0; i < sheets.length; i++) {
    const sm = sheets.get(i);
    const cellsMap = sheetCells(sm);
    const cells: Record<string, string> = {};
    cellsMap.forEach((t, k) => { const v = t.toString(); if (v) cells[k] = v; });
    const arrows = (sheetArrows(sm)?.toArray() ?? []) as FlowArrowLike[];
    outSheets.push({ id: sm.get('id'), name: sm.get('name'), cells, arrows });
  }
  return {
    event: meta.get('event'),
    variant: meta.get('variant') ?? 'stock-issues',
    pfOrder: meta.get('pfOrder') ?? 'pro-first',
    sheets: outSheets,
    columnWidths: meta.get('columnWidths') ?? [],
    customColumns: meta.get('customColumns') ?? null,
    columnColors: meta.get('columnColors') ?? [],
    fontSize: meta.get('fontSize') ?? 13,
    zoom: meta.get('zoom') ?? 100,
  };
}

// ── base64 <-> Uint8Array (Yjs update transport) ─────────────────────────────
export function u8ToB64(u: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + chunk)) as any);
  }
  return btoa(s);
}
export function b64ToU8(b64: string): Uint8Array {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
