// Pure batching helpers for Auto Flow's classify step.
//
// These exist as their own module (rather than inline in main.ts) so they can be
// unit-tested without booting Electron — same reason docxFlowCards.ts is split
// out. main.ts owns the AI calls and the retry/split control flow; everything
// here is deterministic and side-effect free.
//
// WHY BATCHING EXISTS AT ALL: the classify handler used to send every card in
// one prompt, hard-truncated with `JSON.stringify(docs).slice(0, 60000)`. On a
// real case packet (a 1AC can carry 700+ cards) that cut the JSON mid-object, so
// most cards were never sent and what was sent was malformed. The reply then hit
// the output-token cap and came back cut off, failed to parse, and got laundered
// into `{ ok: true, placements: [] }` — a multi-minute wait ending in "Warroom
// AI didn't propose any placements" with no error shown anywhere.
//
// Run the tests:  npx tsx scripts/test-auto-flow-batch.ts

import type { ExtractedFlowCard } from './docxFlowCards';
// Shared with the renderer's parser-only Auto Flow path (src/lib/autoFlowParse.ts),
// so a cite is shortened the same way whichever engine produced the placement.
import { shortCite } from './citeShort';

/**
 * One (fileName, card) pair, flattened out of the per-doc grouping so batches can
 * be cut at any point while still preserving DOCUMENT ORDER across the whole run.
 * That order is load-bearing: the classify prompt numbers the aff's advantages by
 * first appearance in the 1AC, and the write step lays tabs out in the order the
 * placements come back.
 */
export type FlatFlowCard = { fileName: string; card: ExtractedFlowCard };

export interface DocGroup {
  fileName: string;
  cards: (ExtractedFlowCard & { i?: number })[];
}

export function flattenDocs(docs: DocGroup[]): FlatFlowCard[] {
  const out: FlatFlowCard[] = [];
  for (const d of docs ?? []) {
    for (const card of d.cards ?? []) out.push({ fileName: d.fileName, card });
  }
  return out;
}

/**
 * Regroup a flat slice back into the `[{ fileName, cards }]` shape the prompt
 * expects. Files appear in the order they're first seen in the slice, and each
 * file's cards keep their relative order, so a batch reads as a contiguous chunk
 * of the original documents rather than a reshuffle.
 *
 * Every card carries an `i` — its index within THIS batch. The model answers
 * with that number instead of echoing the tagline back, which is the difference
 * between ~130 output tokens per card and ~25. It also removes a whole class of
 * failure: a tagline the model retyped slightly differently used to break
 * `respondsTo` matching silently, and could fail the placement filter outright.
 * We already hold the exact text — there is no reason to make it repeat it.
 */
export function regroupBatch(batch: FlatFlowCard[]): DocGroup[] {
  const order: string[] = [];
  const byFile = new Map<string, (ExtractedFlowCard & { i: number })[]>();
  batch.forEach(({ fileName, card }, i) => {
    if (!byFile.has(fileName)) { byFile.set(fileName, []); order.push(fileName); }
    byFile.get(fileName)!.push({ ...card, i });
  });
  return order.map((fileName) => ({ fileName, cards: byFile.get(fileName)! }));
}

/** Split a flat card list into fixed-size batches, preserving order. */
export function chunkCards(flat: FlatFlowCard[], size: number): FlatFlowCard[][] {
  const step = Math.max(1, Math.floor(size));
  const out: FlatFlowCard[][] = [];
  for (let i = 0; i < flat.length; i += step) out.push(flat.slice(i, i + step));
  return out;
}

/**
 * Fold the sheet names a batch proposed into the known-sheet list,
 * case-insensitively and preserving first-seen order.
 *
 * This is what keeps a chunked run coherent: batch 2 is told about the tabs
 * batch 1 invented, so the same position can't come back named "Heg Adv" once
 * and "Hegemony" the next time and end up as two tabs.
 */
export function mergeSheetNames(known: string[], placements: { sheetName?: unknown }[]): string[] {
  const seen = new Set((known ?? []).map((s) => String(s).trim().toLowerCase()));
  const out = [...(known ?? [])];
  for (const p of placements ?? []) {
    const name = String(p?.sheetName ?? '').trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export interface NormalizedPlacement {
  fileName: string;
  tag: string;
  cite: string;
  column: string;
  sheetName: string;
  isNewSheet: boolean;
  respondsTo: string | null;
  isPlan: boolean;
  sheetRole: 'advantage' | 'offcase' | null;
}

/**
 * Turn the model's index-keyed answers back into full placements, using `batch`
 * as the source of truth for every piece of text the model was never asked to
 * repeat (fileName, tag, and the tagline a `respondsTo` index points at).
 *
 * A row is dropped only when its `i` doesn't identify a real card in this batch,
 * or it names no column/sheet — the three things a card genuinely cannot be
 * placed without. The dropped count is reported to the user, never hidden.
 */
export function normalizePlacements(rawList: any[], batch: FlatFlowCard[]): NormalizedPlacement[] {
  const cards = batch ?? [];
  const at = (n: unknown): FlatFlowCard | undefined => {
    const idx = typeof n === 'number' ? n : Number(n);
    return Number.isInteger(idx) && idx >= 0 && idx < cards.length ? cards[idx] : undefined;
  };
  const out: NormalizedPlacement[] = [];
  for (const p of (Array.isArray(rawList) ? rawList : [])) {
    if (!p) continue;
    const src = at(p.i);
    const column = String(p.column ?? '').trim();
    const sheetName = String(p.sheetName ?? '').trim();
    if (!src || !column || !sheetName) continue;
    // An index pointing at a card outside this batch just means "no target" —
    // the write step already places an unresolved answer normally.
    const answered = p.respondsTo === null || p.respondsTo === undefined ? undefined : at(p.respondsTo);
    out.push({
      fileName: src.fileName,
      tag: String(src.card.tag ?? '').trim(),
      // The model's short cite when it gave one; otherwise PARSE one out of the
      // full cite. The old fallback was the raw cite paragraph — the exact wall
      // of quals, job titles, and dates the prompt tells it to strip, dumped
      // into a flow cell. `shortCite` handles 95% of real cites; the rest are
      // `<<FOR REFERENCE>>` markers, which correctly yield nothing.
      cite: String(p.cite ?? '').trim() || shortCite(src.card.cite ?? ''),
      column,
      sheetName,
      isNewSheet: !!p.isNewSheet,
      // Resolved back to the ACTUAL tagline text, so the write step's
      // tag-keyed same-row/arrow lookup matches exactly instead of relying on
      // the model having retyped it character for character.
      respondsTo: answered && answered !== src ? String(answered.card.tag ?? '').trim() || null : null,
      isPlan: !!p.isPlan,
      // Which family of sheet this card's position belongs to, so the write step
      // can order tabs — aff advantages first (in 1AC order), then off-case.
      // 'advantage' = a 1AC aff case position (advantage/contention), 'offcase' =
      // a neg off-case position (DA/CP/K/T…), null = an existing/structural match.
      sheetRole: p.sheetRole === 'advantage' || p.sheetRole === 'offcase' ? p.sheetRole : null,
    });
  }
  return out;
}
