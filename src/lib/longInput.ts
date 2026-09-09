// Handling input that's too big for one prompt.
//
// Three strategies, chosen by the user in Settings → AI → Long inputs:
//
//   'ask'    — don't go past the limit. Cap and ask first (capForPrompt).
//              Whatever fits is sent in full; the rest is simply not sent.
//   'sample' — take a FAIR SHARE of every section instead of everything from the
//              front, and tell the model exactly what it's missing per section.
//   'passes' — read the whole thing across several calls, then a final call
//              writes the answer from those readings.
//
// The trade-off in one line: 'sample' keeps the real text but less of it;
// 'passes' covers everything but the final answer reasons over notes rather
// than the flow itself. See `LONG_INPUT_DILEMMA` below, which is the same text
// shown in Settings so the two can't drift.
//
// Run the tests:  npx tsx scripts/test-long-input.ts

export type LongInputMethod = 'sample' | 'passes';

/** Shown verbatim in Settings. Kept here so the code and the UI explain it the same way. */
export const LONG_INPUT_DILEMMA = {
  sample: {
    title: 'Even sampling',
    short: 'Real text, less of it.',
    body:
      'Takes a fair share from every sheet instead of everything from the first few, ' +
      'and tells Warroom AI exactly how many cards it is not seeing on each one. ' +
      'What it does read is your actual flow, word for word — but it still never sees ' +
      'the whole round, so a connection between two cards that both got trimmed is invisible.',
  },
  passes: {
    title: 'Read everything in passes',
    short: 'Everything covered, in less detail.',
    body:
      'Reads the round in several passes, then writes the analysis from those readings. ' +
      'Nothing is skipped — but the final answer is working from its own notes rather than ' +
      'your flow, so fine detail ("they conceded this exact warrant") can get smoothed away.',
  },
} as const;

// ── Sections ────────────────────────────────────────────────────────────────

export interface Section {
  label: string;
  text: string;
  /** Countable items in this section (cards on a sheet), for the coverage note. */
  items: number;
}

/**
 * Split a flow summary into one section per sheet.
 *
 * `buildFlowSummary` in AnalyzeRound.tsx emits `=== Sheet: <name> ===` headers
 * followed by `[<column>] <card text>` lines, so sheets are the natural unit —
 * and a "card" is one of those bracketed lines, which is the unit a debater
 * actually counts in ("12 of 31 cards on the Politics DA").
 */
export function splitFlowSummaryIntoSheets(summary: string): Section[] {
  const text = String(summary ?? '');
  if (!text.trim()) return [];
  const out: Section[] = [];
  const re = /^=== Sheet: (.*?) ===$/gm;
  const heads: { name: string; start: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) heads.push({ name: m[1], start: m.index, bodyStart: m.index + m[0].length });
  if (heads.length === 0) return [{ label: 'the flow', text, items: countCardLines(text) }];
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].start : text.length;
    const body = text.slice(heads[i].start, end);
    out.push({ label: heads[i].name, text: body, items: countCardLines(body) });
  }
  return out;
}

/** `[2AC] perm do both` counts; `[1AR] (empty)` and the sheet header do not. */
export function countCardLines(block: string): number {
  let n = 0;
  for (const line of String(block ?? '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('=== Sheet:')) continue;
    if (!/^\[[^\]]+\]\s*/.test(t)) continue;
    if (/^\[[^\]]+\]\s*\(empty\)$/.test(t)) continue;
    n++;
  }
  return n;
}

// ── Even sampling ───────────────────────────────────────────────────────────

export interface SampleResult {
  text: string;
  /** Per section: how many items survived out of how many there were. */
  coverage: { label: string; kept: number; total: number }[];
  /** True when nothing had to be dropped — the caller can skip the coverage note. */
  complete: boolean;
}

/**
 * Fit `sections` into `budget` characters by giving every section a share
 * proportional to its size, rather than filling from the front and truncating
 * whatever doesn't fit.
 *
 * The point is that a round has a *shape*: taking the whole 1AC and none of the
 * 2NR misrepresents it far worse than taking two-thirds of each. Sections that
 * already fit inside their share are kept whole, and the space they don't use is
 * redistributed — so a flow of many small sheets and one huge one still gets
 * every small sheet complete.
 *
 * Trimming is line-wise (never mid-card) and always keeps a section's header.
 */
export function sampleSections(sections: Section[], budget: number): SampleResult {
  const list = sections ?? [];
  const total = list.reduce((n, s) => n + s.text.length, 0);
  if (list.length === 0) return { text: '', coverage: [], complete: true };
  if (total <= budget) {
    return {
      text: list.map((s) => s.text).join('\n'),
      coverage: list.map((s) => ({ label: s.label, kept: s.items, total: s.items })),
      complete: true,
    };
  }

  // Water-filling: repeatedly hand out an equal share, let sections that need
  // less than their share take only what they need, and re-split the remainder
  // among the ones still over. Converges in at most `list.length` rounds.
  const need = list.map((s) => s.text.length);
  const alloc = new Array(list.length).fill(0);
  const settled = new Array(list.length).fill(false);
  let remaining = budget;
  for (let guard = 0; guard < list.length + 1; guard++) {
    const open = settled.reduce((n, s) => n + (s ? 0 : 1), 0);
    if (open === 0 || remaining <= 0) break;
    const share = Math.floor(remaining / open);
    let progressed = false;
    for (let i = 0; i < list.length; i++) {
      if (settled[i] || need[i] > share) continue;
      alloc[i] = need[i]; settled[i] = true; remaining -= need[i]; progressed = true;
    }
    if (!progressed) {
      for (let i = 0; i < list.length; i++) if (!settled[i]) { alloc[i] = share; remaining -= share; }
      break;
    }
  }

  const coverage: SampleResult['coverage'] = [];
  const parts: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (alloc[i] >= s.text.length) {
      parts.push(s.text);
      coverage.push({ label: s.label, kept: s.items, total: s.items });
    } else {
      const trimmed = trimToLines(s.text, alloc[i]);
      parts.push(trimmed);
      coverage.push({ label: s.label, kept: countCardLines(trimmed), total: s.items });
    }
  }
  return { text: parts.join('\n'), coverage, complete: false };
}

/** Cut to at most `max` characters on a line boundary, always keeping line one. */
export function trimToLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const lines = String(text ?? '').split('\n');
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (out.length > 0 && used + cost > max) break;
    out.push(line); used += cost;
  }
  return out.join('\n');
}

/** The block handed to the prompt so the model knows precisely what it is missing. */
export function buildCoverageNote(coverage: SampleResult['coverage']): string {
  const short = coverage.filter((c) => c.kept < c.total);
  if (short.length === 0) return 'You are seeing this round IN FULL. Nothing has been withheld.';
  const lines = short.map((c) => `- ${c.label}: you can see ${c.kept} of ${c.total} cards`);
  const missing = short.reduce((n, c) => n + (c.total - c.kept), 0);
  return [
    `PARTIAL FLOW — ${missing} card${missing === 1 ? '' : 's'} could not be included:`,
    ...lines,
    '',
    'Treat these as gaps in what you can see, NOT as arguments that were never made.',
    'Never call something dropped or unanswered if it sits on a sheet listed above —',
    'the answer may be in a card you were not shown. Say what you cannot see instead.',
  ].join('\n');
}

// ── Chunking for the multi-pass method ──────────────────────────────────────

/** Group whole sections into as few chunks as possible, each under `budget`. */
export function chunkSections(sections: Section[], budget: number): Section[][] {
  const out: Section[][] = [];
  let cur: Section[] = [];
  let used = 0;
  for (const s of sections ?? []) {
    // A single section bigger than the budget still goes in a chunk of its own —
    // splitting inside a sheet would cut a position in half, which is worse than
    // one oversized chunk that the provider's own limit check will catch.
    if (cur.length > 0 && used + s.text.length > budget) { out.push(cur); cur = []; used = 0; }
    cur.push(s); used += s.text.length;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// ── Context-window guard ────────────────────────────────────────────────────

/**
 * Rough characters-per-token. English prose is ~4; a flow is denser (short
 * bracketed lines, names, numbers) so this deliberately under-estimates the
 * ratio, making the token estimate conservative — it errs toward warning early
 * rather than letting a request through that the provider then rejects.
 */
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);
}

/**
 * `null` when the prompt fits, or when `limit` is null.
 *
 * WHY `limit` CAN BE NULL, AND WHY THAT MEANS "DON'T BLOCK":
 *
 * This used to consult a hard-coded table of context windows keyed by model-id
 * prefix, with a 100,000-token default for anything unrecognised. Both halves
 * were wrong in the same direction — they REFUSED requests that would have
 * worked. `claude-opus` was listed at 180,000 when an Opus model may carry a
 * million; every LM Studio model, and every model released after the table was
 * written, fell to the 100,000 default. And because this guard runs inside
 * `callAI`, a wrong entry silently broke every AI feature in the app, not just
 * the one being worked on.
 *
 * The costs here are asymmetric:
 *
 *   - Guess too LOW and a legitimate request is refused locally, with no
 *     override and no way for the user to tell the refusal is bogus.
 *   - Guess too HIGH and the provider returns a 400 that says exactly what the
 *     real limit is — which the `*HttpError` parsers already surface verbatim.
 *
 * So the rule is: **only block on a limit the provider actually told us.**
 * `resolveContextLimit` in main.ts asks Gemini and LM Studio, which report it;
 * for providers with no such endpoint it returns null and no pre-flight block
 * happens at all. Nothing is lost in that case — the request goes out and the
 * provider's own error is what the user sees, which is authoritative and always
 * current in a way a table in this file can never be.
 */
export function overContextLimit(prompt: string, limit: number | null): string | null {
  if (!limit || limit <= 0) return null;
  const tokens = estimateTokens(prompt);
  if (tokens <= limit) return null;
  return (
    `This is too big for Warroom AI to read at once — roughly ${tokens.toLocaleString()} tokens ` +
    `against this model's limit of ${limit.toLocaleString()}. Nothing was sent. ` +
    `Remove some documents, or turn on Settings → AI → "Work past the length limit" ` +
    `so it can be read in pieces.`
  );
}
