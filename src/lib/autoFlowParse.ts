// Auto Flow without the AI — placing cards from the document's own structure.
//
// A Verbatim doc already encodes both decisions Auto Flow asks a model to make.
// From DEBATE_DOC_STRUCTURE.md's heading mapping:
//
//   Pocket (H1) = the speech      → the COLUMN
//   Hat    (H2) = the position    → the SHEET
//   Block  (H3) = the card group  → sub-structure within the position
//   Tag    (H4) = the tagline     → the cell contents
//
// Measured across real speech docs: 100% of cards carry a pocket, and 97.9%
// carry a hat that names a real position. So the overwhelming majority of a run
// is a lookup, not a judgement — which means no batching, no context limit, no
// waiting, and no chance of the model mistyping a tagline.
//
// What this CANNOT do, and says so rather than guessing: a doc that labels every
// off-case block with the same generic header ("OFF", "1NC") gives the parser
// nothing to separate the positions with. Those cards are grouped under one tab
// and counted in `unresolved`, so the UI can tell the user to use AI mode for
// that doc. Fine-grained `respondsTo` (which specific card a perm answers) is
// also beyond it; answers are aligned by position instead.
//
// Run the tests:  npx tsx scripts/test-auto-flow-parse.ts

import { shortCite } from './citeShort';

export interface ParseCard {
  pocket: string | null;
  hat: string | null;
  block: string | null;
  tag: string;
  cite: string;
}

export interface ParsedPlacement {
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

export interface ParseResult {
  placements: ParsedPlacement[];
  /** The aff, read off the 1AC's hat or plan text. Undefined when not derivable. */
  flowName?: string;
  /** Cards placed on a tab named after a generic header because no position was named. */
  unresolved: number;
  /** The same cards, grouped so the UI can name the doc and the header responsible. */
  unresolvedDocs: { fileName: string; sheetName: string; count: number }[];
  /** Cards with no recognisable speech, which cannot be given a column. */
  skipped: { tag: string; reason: string }[];
}

// ── Speech detection ────────────────────────────────────────────────────────

/**
 * Headers that name a *section* rather than a *position*. A doc that hats every
 * off-case block "OFF" is telling the parser nothing about what those arguments
 * are — the position only exists in the taglines, which is exactly the case that
 * still needs a model.
 */
const GENERIC_HEADER =
  /^(off|off[\s-]*case|on[\s-]*case|case|neg|aff|blocks?|extra|misc|cards?|frontlines?|answers?|1ac|2ac|1nc|2nc|1nr|1ar|2nr|2ar|1ac[\s-]*off|1nc[\s-]*off)$/i;

export function isGenericHeader(s: string | null | undefined): boolean {
  const t = String(s ?? '').replace(/[-—–]{2,}/g, ' ').replace(/\s+/g, ' ').trim();
  return !t || GENERIC_HEADER.test(t);
}

/** Canonical policy speech tokens, longest first so "2NC" wins over "2N". */
const POLICY_SPEECHES = ['1AC', '2AC', '1NC', '2NC', '1NR', '1AR', '2NR', '2AR'];

const PF_SPEECHES: [RegExp, string][] = [
  [/\bpro\s*(case|constructive)\b/i, 'Pro Case'],
  [/\bcon\s*(case|constructive)\b/i, 'Con Case'],
  [/\bpro\s*(rebuttal|reb)\b/i, 'Pro Rebuttal'],
  [/\bcon\s*(rebuttal|reb)\b/i, 'Con Rebuttal'],
  [/\bpro\s*(summary|sum)\b/i, 'Pro Summary'],
  [/\bcon\s*(summary|sum)\b/i, 'Con Summary'],
  [/\bpro\s*(ff|final\s*focus)\b/i, 'Pro FF'],
  [/\bcon\s*(ff|final\s*focus)\b/i, 'Con FF'],
];

/**
 * "AT:" / "A2:" / "Answers To", immediately before a speech token.
 *
 * A speech named right after one of these is the speech being ANSWERED, not the
 * speech the card is in — `1NC---AT-1AC-Adv.docx` is a 1NC doc, and the "1AC" in
 * it names its target. Matched against the text *preceding* a hit, and anchored
 * to the end of it, so only an immediately-adjacent marker counts:
 * `AT: Solvency---1NC` still resolves to 1NC, because there the "AT:" belongs to
 * "Solvency", not to the speech.
 */
const ANSWERS_TO_BEFORE = /(^|[^A-Z0-9])(AT|A2|ANSWERS?\s*TO)\s*[:\-—–]?\s*$/i;

/**
 * Which speech a card belongs to, from its pocket — falling back to the FILE
 * NAME, because the label genuinely isn't always in the document. A real send
 * doc measured here (`SEND_2AC---PR.8.20.docx`) pockets all 29 of its cards
 * under "OFF"; the only place the words "2AC" appear is the filename.
 *
 * When a string names more than one speech, the EARLIEST one wins. It used to
 * return the first match in `POLICY_SPEECHES` array order, which is arbitrary —
 * a doc named `1NC---AT-1AC-Adv.docx` came back as 1AC purely because '1AC' is
 * listed before '1NC', putting a whole 1NC doc in the aff's first column. A
 * heading reads left to right: what it leads with is what it is, and what comes
 * after is context ("2AC vs 1NC Politics" is a 2AC block).
 */
export function detectSpeech(pocket: string | null, fileName: string, event: 'policy' | 'pf'): string | null {
  const from = (s: string): string | null => {
    const t = String(s ?? '');
    let bestAt = Infinity;
    let bestLabel: string | null = null;
    const take = (at: number, label: string) => {
      if (at >= 0 && at < bestAt) { bestAt = at; bestLabel = label; }
    };
    if (event === 'pf') {
      for (const [re, label] of PF_SPEECHES) take(t.search(re), label);
      return bestLabel;
    }
    const up = t.toUpperCase();
    for (const sp of POLICY_SPEECHES) {
      // Word-ish boundary: "2AC" in "SEND_2AC---PR" counts, "12AC" does not.
      const re = new RegExp(`(^|[^0-9A-Z])${sp}([^0-9A-Z]|$)`, 'g');
      for (const m of up.matchAll(re)) {
        // m[1] is the boundary char (empty at string start), so the token itself
        // starts just past it.
        const at = m.index! + (m[1] ? m[1].length : 0);
        if (ANSWERS_TO_BEFORE.test(up.slice(0, at))) continue;
        take(at, sp);
        break; // earliest occurrence of THIS speech is enough
      }
    }
    return bestLabel;
  };
  return from(pocket ?? '') ?? from(fileName);
}

/** The 2NC and 1NR share one column in this app's policy layout. */
export function columnForSpeech(speech: string, columns: string[]): string | null {
  const exact = columns.find((c) => c.trim().toUpperCase() === speech.toUpperCase());
  if (exact) return exact;
  // A merged column ("2NC/1NR") contains the speech as one of its parts.
  const merged = columns.find((c) =>
    c.split(/[\/,]/).some((part) => part.trim().toUpperCase() === speech.toUpperCase()));
  return merged ?? null;
}

/** Aff speeches build the case; neg speeches bring off-case. Drives tab order. */
export function roleForSpeech(speech: string | null): 'advantage' | 'offcase' | null {
  if (!speech) return null;
  const s = speech.toUpperCase();
  if (/^(1AC|2AC|1AR|2AR)$/.test(s) || /^PRO\b/.test(s)) return 'advantage';
  if (/^(1NC|2NC|1NR|2NR)$/.test(s) || /^CON\b/.test(s)) return 'offcase';
  return null;
}

/** The plan text: a 1AC card whose tag reads like a mandate. */
const PLAN_RE = /\b(the\s+)?(united\s+states\s+federal\s+government|usfg|the\s+united\s+states)\b[\s\S]{0,40}\bshould\b/i;

export function looksLikePlan(card: ParseCard, speech: string | null): boolean {
  if (speech !== '1AC') return false;
  const t = `${card.tag} ${card.block ?? ''}`;
  return PLAN_RE.test(t) || /^\s*(plan|the\s+plan)\s*[:.]?\s*$/i.test(card.block ?? '');
}

// ── Sheet naming ────────────────────────────────────────────────────────────

/**
 * Remove a speech marker from EITHER end, then tidy the dash runs Verbatim uses
 * as separators. Both ends matter and for different reasons:
 *
 *   "AT: Solvency---1NC"   → "AT: Solvency"   (trailing — the usual shape)
 *   "1NC---OFF"            → "OFF"            (leading — must reduce to the
 *                                              generic word so it is CAUGHT as
 *                                              generic rather than surviving as
 *                                              the position name "1NC — OFF")
 *   "1AC---Single Payer"   → "Single Payer"   (leading — this is also what makes
 *                                              a usable flow name)
 */
const SPEECH_MARKER = '(1AC|2AC|1NC|2NC|1NR|1AR|2NR|2AR)';

function stripSpeechMarkers(s: string): string {
  return String(s ?? '')
    .replace(new RegExp(`^\\s*${SPEECH_MARKER}\\s*[-—–:]{1,3}\\s*`, 'i'), '')
    .replace(new RegExp(`[-—–]{2,}\\s*${SPEECH_MARKER}\\s*$`, 'i'), '')
    .replace(/[-—–]{2,}/g, ' — ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The advantage's NAME out of an "Advantage N---X" heading.
 *
 * This is what makes an aff case file flow correctly, and it has to outrank the
 * hat. Measured on a real 1AC: every one of its 21 cards is hatted with the AFF
 * ("1AC---Single Payer") and blocked with the advantage ("1AC---Advantage
 * 1---Economy"). Reading the hat as the position — which is right for every neg
 * doc — collapses the whole case onto one tab called "Single Payer", and the
 * advantages, which are exactly what a flow tab is supposed to be, vanish.
 */
const ADVANTAGE_HEADING =
  /^(?:advantage|adv|contention|cont)\.?\s*(?:\d+|one|two|three|four|five|six)?\s*(?:[-—–:.]{1,3}|\s)\s*(.+)$/i;

export function advantageName(s: string | null | undefined): string | null {
  const m = stripSpeechMarkers(String(s ?? '')).match(ADVANTAGE_HEADING);
  const rest = (m?.[1] ?? '').replace(/^[\s—–:.-]+/, '').trim();
  // Must contain a LETTER. The number group is optional (some docs write a bare
  // "Advantage---Economy"), so without this a heading of just "Advantage 1"
  // captures the "1" and names a tab "1".
  return rest && /[a-z]/i.test(rest) && !isGenericHeader(rest) ? rest : null;
}

/** A heading that is nothing but a speech name — never a legal tab name. */
const BARE_SPEECH = new RegExp(`^\\s*${SPEECH_MARKER}\\s*$`, 'i');

/**
 * The key two tab names are considered THE SAME under.
 *
 * A position is written a different way in every doc it appears in — the 2AC
 * hats it "Midterms DA", the 2NC hats the kick block "Midterms". Matching on the
 * literal string gives you both as separate tabs, which is how a real run ended
 * up with a "Midterms DA" holding the 2AC and a "Midterms" holding the one 2NC
 * card that answers it.
 *
 * Only the position-TYPE suffix is dropped, never a word that carries meaning:
 * "Econ DA" → "econ" and "Economy" → "economy" stay distinct, which they must,
 * because in that round they are the neg's DA and the aff's advantage.
 */
const POSITION_SUFFIX = /\s+(da|das|cp|cps|k|ks|t|adv|advantage|contention|turn|turns|block|blocks)$/i;

export function sheetAliasKey(name: string): string {
  let t = String(name ?? '').toLowerCase()
    .replace(/^(at|a2|answers?\s+to)\s*[:\-—–]+\s*/i, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let prev = ''; prev !== t; ) { prev = t; t = t.replace(POSITION_SUFFIX, '').trim(); }
  return t || String(name ?? '').trim().toLowerCase();
}

/**
 * Which tab a card goes on, most specific naming wins:
 *
 *   1. the block's advantage name   "1AC---Advantage 1---Economy" → "Economy"
 *   2. the hat's advantage name     (some docs hat the advantage directly)
 *   3. the hat                      "Cap K", "States CP", "Midterms DA"
 *   4. the block                    when the hat said nothing
 *   5. "Unsorted", flagged generic
 *
 * A SPEECH is never a tab name, at any step. It used to be the last-resort
 * fallback, which produced a tab literally called "2NC" the moment a doc arrived
 * with no headings at all — a speech is a column in this app, and a tab is a
 * position, so that tab could never be right.
 */
export function sheetForCard(card: ParseCard, _speech: string | null): { name: string; generic: boolean } {
  const blockAdv = advantageName(card.block);
  if (blockAdv) return { name: blockAdv, generic: false };
  const hatAdv = advantageName(card.hat);
  if (hatAdv) return { name: hatAdv, generic: false };
  const hat = stripSpeechMarkers(card.hat ?? '');
  if (hat && !isGenericHeader(hat)) return { name: hat, generic: false };
  const block = stripSpeechMarkers(card.block ?? '');
  if (block && !isGenericHeader(block)) return { name: block, generic: false };
  // The POCKET, last. Usually it is just the speech ("1AC") and generic, but a
  // doc with only ONE ancestor heading level puts everything there — and what it
  // puts there is the position. Measured across 90 real docs, three of them are
  // shaped this way ("Miscalc. Adv.", "The Advantage", "1AC---Inhuman Matter"),
  // 35 aff cards in total, every one of which was landing on "Unsorted" with a
  // perfectly good tab name sitting in the heading right above it.
  const pocketAdv = advantageName(card.pocket);
  if (pocketAdv) return { name: pocketAdv, generic: false };
  const pocket = stripSpeechMarkers(card.pocket ?? '');
  if (pocket && !isGenericHeader(pocket) && !BARE_SPEECH.test(pocket)) return { name: pocket, generic: false };
  const fallback = (hat || block).trim();
  return { name: fallback && !BARE_SPEECH.test(fallback) ? fallback : 'Unsorted', generic: true };
}

/**
 * Match by alias key, returning the tab's ORIGINAL casing and wording.
 *
 * The lookup key is normalised but the value is not: returning the key would
 * rename "Heg Adv" to "heg adv" the moment a second card landed on it, and
 * "Midterms DA" to "midterms" the moment the 2NC's "Midterms" block merged in.
 */
function matchExistingSheet(name: string, existing: Map<string, string>): string | null {
  return existing.get(sheetAliasKey(name)) ?? null;
}

// ── The parse ───────────────────────────────────────────────────────────────

export interface ParseInput {
  docs: { fileName: string; cards: ParseCard[] }[];
  columns: string[];
  existingSheets: string[];
  event: 'policy' | 'pf';
}

export function parseAutoFlow(input: ParseInput): ParseResult {
  const { docs, columns, existingSheets, event } = input;
  const placements: ParsedPlacement[] = [];
  const skipped: ParseResult['skipped'] = [];
  let unresolved = 0;
  let flowName: string | undefined;

  // Sheets created during this run, so the second card of a position matches the
  // tab the first one made rather than being marked new again.
  const known = new Map<string, string>(
    (existingSheets ?? []).map((s) => [sheetAliasKey(s), s]));

  // Generic-header buckets, per doc, so the caller can say WHICH document and
  // WHICH header defeated it instead of a bare count the user can't act on.
  const unresolvedDocs = new Map<string, { fileName: string; sheetName: string; count: number }>();

  // The most recent card placed on each sheet, per role. An answer in a later
  // speech is aligned to the opposing side's last card on the same position —
  // coarser than knowing a perm answers one specific CP card, but it is what the
  // document structure actually supports.
  const lastOnSheet = new Map<string, { tag: string; role: string | null }>();

  for (const doc of docs ?? []) {
    for (const card of doc.cards ?? []) {
      const speech = detectSpeech(card.pocket, doc.fileName, event);
      const column = speech ? columnForSpeech(speech, columns) : null;
      if (!column) {
        skipped.push({ tag: card.tag, reason: speech ? `no "${speech}" column in this flow` : 'no speech label on the card or its file' });
        continue;
      }

      const sheet = sheetForCard(card, speech);
      if (sheet.generic) {
        unresolved++;
        const k = `${doc.fileName}\u0000${sheet.name}`;
        const hit = unresolvedDocs.get(k);
        if (hit) hit.count++;
        else unresolvedDocs.set(k, { fileName: doc.fileName, sheetName: sheet.name, count: 1 });
      }

      const existing = matchExistingSheet(sheet.name, known);
      const sheetName = existing ?? sheet.name;
      const isNewSheet = !existing;
      if (isNewSheet) known.set(sheetAliasKey(sheetName), sheetName);

      const role = roleForSpeech(speech);
      const prev = lastOnSheet.get(sheetAliasKey(sheetName));
      const respondsTo = prev && prev.role && role && prev.role !== role ? prev.tag : null;

      const isPlan = looksLikePlan(card, speech);
      // The flow's name is the AFF, and the aff's name is the 1AC's HAT — not
      // its tab, which is now (correctly) the advantage. "1AC---Single Payer"
      // names the round; "Economy" names one tab inside it.
      if (!flowName && speech === '1AC') {
        const h = stripSpeechMarkers(card.hat ?? '');
        if (h && !isGenericHeader(h) && !advantageName(h)) flowName = h;
      }

      placements.push({
        fileName: doc.fileName,
        tag: card.tag.trim(),
        cite: shortCite(card.cite ?? ''),
        column,
        sheetName,
        isNewSheet,
        respondsTo,
        isPlan,
        sheetRole: role,
      });
      lastOnSheet.set(sheetAliasKey(sheetName), { tag: card.tag.trim(), role });
    }
  }

  return { placements, flowName, unresolved, unresolvedDocs: [...unresolvedDocs.values()], skipped };
}
