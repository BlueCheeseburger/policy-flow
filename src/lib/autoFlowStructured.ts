// Auto Flow's parse mode: a speech doc's outline (lib/docOutline.ts) placed
// row by row, with no AI.
//
//   Column — the speech, from the pocket, else the file name, else a speech
//            label on a hat or block ("T---Multipayer---2AC").
//   Tab    — the POCKET, when it names a position ("Stocks", "Econ Adv").
//            When it's a speech or file label instead ("1NC", "NSU Single
//            Payer 1AC v3.2"), the next heading down that names one: an
//            "Advantage N---X" block, the hat, then the block. When every
//            heading is generic ("1NC---OFF"), the first tagline under it
//            names the tab — that's where a 1NC writes "ECON DA."
//   Rows   — every tagline and analytic, in order, plus each hat and block
//            that isn't the tab's own name. Styling and spacing are applied at
//            write time (lib/flowRowStyle.ts), so the rules match sends from
//            CardMirror exactly.
//
// Run the tests:  npx tsx scripts/test-auto-flow-structured.ts

import type { OutlineItem } from './docOutline';
import type { RowKind } from './flowRowStyle';
import {
  advantageName, columnForSpeech, detectSpeech, isGenericHeader, pocketTabName,
  roleForSpeech, sheetAliasKey, stripSpeechMarkers,
} from './autoFlowParse';

export interface StructuredPlacement {
  fileName: string;
  /** The row's text: a tagline, an analytic, or a heading. */
  tag: string;
  cite: string;
  column: string;
  sheetName: string;
  isNewSheet: boolean;
  respondsTo: null;
  isPlan: boolean;
  sheetRole: 'advantage' | 'offcase' | null;
  rowKind: Exclude<RowKind, 'pocket'>;
  /** The headings this row sat under in its doc, as written there. */
  context: OutlineContext;
  /**
   * True when no heading named the position, so the tab is only a guess from
   * a tagline. Auto Flow holds these back and asks the user where they go.
   */
  unresolved: boolean;
  /** Rows under the same heading instance share this; lets them be placed together. */
  group: string;
}

export interface OutlineContext { pocket: string | null; hat: string | null; block: string | null }

/** A row with no column to go in (no speech anywhere on its doc). */
export interface StructuredSkip {
  fileName: string;
  tag: string;
  cite: string;
  reason: string;
  rowKind: 'card' | 'analytic';
  context: OutlineContext;
  group: string;
}

export interface StructuredResult {
  placements: StructuredPlacement[];
  flowName?: string;
  /** Rows on a tab named from a tagline because no heading named the position. */
  unresolved: number;
  unresolvedDocs: { fileName: string; sheetName: string; count: number }[];
  skipped: StructuredSkip[];
}

export interface StructuredInput {
  docs: { fileName: string; outline: OutlineItem[] }[];
  columns: string[];
  existingSheets: string[];
  event: 'policy' | 'pf';
}

const PLAN_HEADER = /^\s*(the\s+)?plan(\s+text)?\s*[:.]?\s*$/i;
const PLAN_TEXT = /\b(the\s+)?(united\s+states\s+federal\s+government|usfg|the\s+united\s+states)\b[\s\S]{0,40}\bshould\b/i;

/** A heading's text as it should read on a flow: no speech label, tidy dashes. */
function cleanHeading(s: string): string {
  return stripSpeechMarkers(s);
}

/** Does this heading name a position (rather than "OFF", "1NC", "Plan")? */
function names(s: string | null): string | null {
  if (!s) return null;
  const adv = advantageName(s);
  if (adv) return adv;
  const t = cleanHeading(s);
  if (!t || isGenericHeader(t) || PLAN_HEADER.test(t)) return null;
  return t;
}

/** A tagline as a tab name: "ECON DA." → "ECON DA". */
function tabFromTag(tag: string): string {
  return tag.replace(/[.:;,\s]+$/, '').slice(0, 40).trim() || 'Unsorted';
}

export function parseStructuredFlow(input: StructuredInput): StructuredResult {
  const { docs, columns, existingSheets, event } = input;
  const placements: StructuredPlacement[] = [];
  const skipped: StructuredResult['skipped'] = [];
  const unresolvedDocs = new Map<string, { fileName: string; sheetName: string; count: number }>();
  let unresolved = 0;
  let flowName: string | undefined;
  const known = new Map<string, string>((existingSheets ?? []).map((s) => [sheetAliasKey(s), s]));

  for (const doc of docs ?? []) {
    let pocket: string | null = null;
    let hat: string | null = null;
    let block: string | null = null;
    // Each heading instance, so a tab chosen from a tagline sticks to every
    // row under that same "1NC---OFF", and each heading is written once.
    let headingId = 0;
    let groupTab = new Map<number, string>();
    let written = new Set<string>();
    let hatId = -1;
    let blockId = -1;

    for (const it of doc.outline ?? []) {
      if (it.kind === 'pocket') { pocket = it.text; hat = null; block = null; hatId = -1; blockId = -1; headingId++; continue; }
      if (it.kind === 'hat') { hat = it.text; block = null; hatId = ++headingId; blockId = -1; continue; }
      if (it.kind === 'block') { block = it.text; blockId = ++headingId; continue; }

      const speech = detectSpeech(pocket, doc.fileName, event)
        ?? detectSpeech(hat, '', event) ?? detectSpeech(block, '', event);
      const column = speech ? columnForSpeech(speech, columns) : null;
      const context: OutlineContext = { pocket, hat, block };
      const rowKind = it.kind === 'analytic' ? 'analytic' as const : 'card' as const;
      const group = `${doc.fileName}\u0000${blockId >= 0 ? blockId : hatId >= 0 ? hatId : headingId}`;
      if (!column) {
        skipped.push({
          fileName: doc.fileName, tag: it.text, cite: it.cite ?? '', rowKind, context, group,
          reason: speech ? `no "${speech}" column in this flow` : 'no speech label on the doc or its file name',
        });
        continue;
      }

      const isPlan = speech === '1AC' && it.kind === 'tag' &&
        (PLAN_TEXT.test(it.text) || PLAN_HEADER.test(hat ?? '') || PLAN_HEADER.test(block ?? ''));
      if (isPlan) {
        // The plan goes in the first cell of the first tab (the write step's
        // job), never on a tab of its own.
        placements.push({
          fileName: doc.fileName, column, sheetName: '', isNewSheet: false, respondsTo: null,
          isPlan: true, sheetRole: 'advantage', tag: it.text, cite: it.cite ?? '', rowKind: 'card',
          context, unresolved: false, group,
        });
        continue;
      }

      // Which heading names the tab, if any — and so isn't written as a row.
      let tab: string | null = pocketTabName(pocket);
      let used: 'pocket' | 'hat' | 'block' | 'tag' = 'pocket';
      if (!tab) {
        const blockAdv = advantageName(block);
        if (blockAdv) { tab = blockAdv; used = 'block'; }
        else if (names(hat)) { tab = names(hat); used = 'hat'; }
        else if (names(block)) { tab = names(block); used = 'block'; }
      }
      let generic = false;
      if (!tab) {
        const gid = blockId >= 0 ? blockId : hatId >= 0 ? hatId : headingId;
        tab = groupTab.get(gid) ?? tabFromTag(it.text);
        groupTab.set(gid, tab);
        used = 'tag';
        generic = true;
      }

      const existing = known.get(sheetAliasKey(tab));
      const sheetName = existing ?? tab;
      const isNewSheet = !existing && !placements.some((p) => p.sheetName === sheetName);
      if (!existing) known.set(sheetAliasKey(sheetName), sheetName);
      const sheetRole = roleForSpeech(speech);
      const base = { fileName: doc.fileName, column, sheetName, isNewSheet, respondsTo: null, isPlan: false, sheetRole, context, unresolved: generic, group } as const;

      // The headings above this row that haven't been written yet and aren't
      // the tab's own name. A plan heading never is: the plan text says it.
      const heads: [number, string | null, 'hat' | 'block'][] = [[hatId, hat, 'hat'], [blockId, block, 'block']];
      for (const [id, text, kind] of heads) {
        if (id < 0 || !text || written.has(`${sheetName}\u0000${id}`)) continue;
        written.add(`${sheetName}\u0000${id}`);
        if (used === kind) continue;
        const shown = names(text);
        if (!shown) continue;
        placements.push({ ...base, tag: shown, cite: '', rowKind: kind });
      }

      if (!flowName && speech === '1AC') {
        const h = names(hat);
        if (h && used !== 'hat' && !advantageName(hat)) flowName = h;
      }

      placements.push({ ...base, tag: it.text, cite: it.cite ?? '', rowKind });
      if (generic) {
        unresolved++;
        const k = `${doc.fileName}\u0000${sheetName}`;
        const hit = unresolvedDocs.get(k);
        if (hit) hit.count++;
        else unresolvedDocs.set(k, { fileName: doc.fileName, sheetName, count: 1 });
      }
    }
    groupTab = new Map();
    written = new Set();
  }

  return { placements, flowName, unresolved, unresolvedDocs: [...unresolvedDocs.values()], skipped };
}
