// The four AI features the flow uses, ported from Warroom's main-process IPC
// handlers to run in the tab. The prompts, the batching, and — deliberately —
// the failure rules are unchanged:
//
//   • nothing is silently truncated: input is batched, or capped only after
//     asking the user (capForPrompt), never sliced behind their back
//   • a response the provider cut off THROWS rather than being parsed as a
//     bad answer; the fix is a smaller batch, not a retry
//   • an unparseable reply is never laundered into an empty-but-successful
//     result — zero placements out of a non-empty input is a failure
//   • a shortfall is counted and reported, so it can't look like the input
//     was simply smaller than it was

import { callAI, renderPrompt, parseJsonLoose, isTruncatedResponse } from './ai';
import { extractBlocksWithBodies } from './docx';
import { fileNameOf } from './files';
import { readSettings } from './settings';
import type { ExtractedFlowCard } from '../lib/docxFlowCards';
import {
  flattenDocs, regroupBatch, chunkCards, mergeSheetNames, normalizePlacements,
  type FlatFlowCard, type DocGroup,
} from '../lib/autoFlowBatch';
import {
  splitFlowSummaryIntoSheets, sampleSections, chunkSections, buildCoverageNote,
} from '../lib/longInput';
import { capForPrompt } from './longInputGate';

export interface AutoFlowProgress {
  phase: 'classifying' | 'summarizing';
  batchesDone: number;
  totalBatches: number;
  cardsDone: number;
  cardsTotal: number;
}

// Progress is a plain subscription rather than a window event, so a listener
// can't outlive its component and leak a half-finished run into the next one.
type ProgressSub = (p: AutoFlowProgress) => void;
const progressSubs = new Set<ProgressSub>();
export function onAutoFlowProgress(cb: ProgressSub): () => void {
  progressSubs.add(cb);
  return () => { progressSubs.delete(cb); };
}
function emitProgress(p: AutoFlowProgress) { progressSubs.forEach((cb) => cb(p)); }

// How many cards to send in one classify call. Deliberately optimistic rather
// than conservative: a real case packet is hundreds of cards, and a small batch
// would mean dozens of slow sequential calls. If a batch turns out to be too
// big, classifyBatch halves it and retries — so this is a starting guess the
// run self-corrects from, not a limit that has to be right up front.
const CLASSIFY_BATCH_SIZE = 120;

// Summaries carry the card BODY into the prompt, so a batch is far heavier than
// a classify batch of the same card count — hence the much smaller number.
const SUMMARIZE_BATCH_SIZE = 25;

interface ClassifyCtx {
  event: 'policy' | 'pf';
  variant: string;
  existingColumns: string[];
  clar: { question: string; answer: string }[];
  knownSheets: string[];
  customInstructions: string;
  allowQuestion: boolean;
}

interface ClassifyResult { question?: any; placements: any[]; dropped: number; flowName?: string }

async function classifyBatch(
  batch: FlatFlowCard[],
  ctx: ClassifyCtx,
  onSplit?: (extraBatchesAdded: number) => void,
): Promise<ClassifyResult> {
  const prompt = renderPrompt('auto_flow_classify', {
    EVENT: ctx.event,
    VARIANT: ctx.variant || '',
    EXISTING_COLUMNS_JSON: JSON.stringify(ctx.existingColumns ?? []),
    EXISTING_SHEETS_JSON: JSON.stringify(ctx.knownSheets ?? []),
    DOCS_JSON: JSON.stringify(regroupBatch(batch)),
    CUSTOM_INSTRUCTIONS: ctx.customInstructions || '(none — use your own defaults)',
    CLARIFICATIONS_JSON: ctx.clar.length ? JSON.stringify(ctx.clar) : '(none yet)',
    // The prompt only offers the clarifying question when this reads 0. Batches
    // after the first pass a non-zero count so a mid-run batch can't stop to ask
    // — by then the user has already answered (or declined) for this run.
    QUESTIONS_ASKED: String(ctx.allowQuestion ? ctx.clar.length : Math.max(1, ctx.clar.length)),
  });

  let raw: string;
  try {
    // No retry wrapper: Auto Flow puts the user back on step 2 with the "Sort"
    // button on failure, so they can retry themselves in one click rather than
    // sitting through invisible backoff.
    raw = await callAI(prompt, 'balanced', { maxOutputTokens: 32768 });
  } catch (e) {
    // Too big to answer in one response — halve it. One card that still can't
    // be answered is a genuine failure and propagates.
    if (isTruncatedResponse(e) && batch.length > 1) return splitAndClassify(batch, ctx, onSplit);
    throw e;
  }

  const parsed = parseJsonLoose(raw);
  if (!parsed) {
    // Unparseable but NOT flagged as truncated — most often a model that
    // trailed off or wrapped the JSON in prose. Halving usually fixes it.
    if (batch.length > 1) return splitAndClassify(batch, ctx, onSplit);
    throw new Error(
      `The model returned something that isn't valid JSON for "${batch[0]?.card?.tag ?? 'this card'}". ` +
      `First 300 characters: ${JSON.stringify(raw.slice(0, 300))}`,
    );
  }

  if (ctx.allowQuestion && parsed?.question?.question && Array.isArray(parsed.question.options)) {
    return { question: parsed.question, placements: [], dropped: 0 };
  }

  const rawList = Array.isArray(parsed.placements) ? parsed.placements : [];
  const placements = normalizePlacements(rawList, batch);
  const flowName = typeof parsed.flowName === 'string' && parsed.flowName.trim()
    ? parsed.flowName.trim().slice(0, 60)
    : undefined;
  return { placements, dropped: rawList.length - placements.length, flowName };
}

async function splitAndClassify(
  batch: FlatFlowCard[],
  ctx: ClassifyCtx,
  onSplit?: (extraBatchesAdded: number) => void,
): Promise<ClassifyResult> {
  const mid = Math.ceil(batch.length / 2);
  onSplit?.(1); // one batch became two — the caller bumps its own total
  const first = await classifyBatch(batch.slice(0, mid), ctx, onSplit);
  if (first.question) return first;
  // Sheets the first half invented are "existing" as far as the second half is
  // concerned, so the two halves can't name the same position two different ways.
  const nextCtx = { ...ctx, knownSheets: mergeSheetNames(ctx.knownSheets, first.placements), allowQuestion: false };
  const second = await classifyBatch(batch.slice(mid), nextCtx, onSplit);
  return {
    placements: [...first.placements, ...second.placements],
    dropped: first.dropped + second.dropped,
    // The first half saw the 1AC, so its read on the aff is the one to keep.
    flowName: first.flowName ?? second.flowName,
  };
}

export async function autoFlowClassify(params: {
  docs: DocGroup[];
  existingSheetNames: string[];
  existingColumns: string[];
  event: 'policy' | 'pf';
  variant: string;
  clarifications: { question: string; answer: string }[];
}): Promise<{ ok: true; question?: any; placements: any[]; flowName?: string; stats?: { cardsIn: number; placed: number; dropped: number; batches: number } }> {
  const { docs, existingSheetNames, existingColumns, event, variant } = params;
  const clar = params.clarifications ?? [];
  const customInstructions = readSettings().autoFlowInstructions.trim().slice(0, 300);

  const flat = flattenDocs(docs);
  if (flat.length === 0) return { ok: true, placements: [], stats: { cardsIn: 0, placed: 0, dropped: 0, batches: 0 } };

  const batches = chunkCards(flat, CLASSIFY_BATCH_SIZE);

  let knownSheets = [...(existingSheetNames ?? [])];
  const all: any[] = [];
  let dropped = 0;
  let flowName: string | undefined;
  let cardsDone = 0;
  // Not `batches.length` — a batch that gets halved adds to the total mid-run,
  // so the progress denominator has to be able to grow.
  let totalBatches = batches.length;
  let batchesDone = 0;

  const emit = () => emitProgress({ phase: 'classifying', batchesDone, totalBatches, cardsDone, cardsTotal: flat.length });
  emit();

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const res = await classifyBatch(batch, {
      event, variant: variant || '',
      existingColumns: existingColumns ?? [],
      clar, knownSheets, customInstructions,
      allowQuestion: i === 0,
    }, (added) => { totalBatches += added; emit(); });

    // A clarifying question aborts the whole run — the caller re-invokes this
    // from the top once the user answers, so partial work is discarded rather
    // than stitched onto placements made under a different assumption.
    if (res.question) return { ok: true, question: res.question, placements: [] };

    all.push(...res.placements);
    dropped += res.dropped;
    // Batch 1 carries the 1AC, so the first name offered is the best one.
    if (!flowName && res.flowName) flowName = res.flowName;
    knownSheets = mergeSheetNames(knownSheets, res.placements);
    cardsDone += batch.length;
    batchesDone += 1;
    emit();
  }

  // Zero placements out of a non-empty input is a FAILURE, not an empty result.
  if (all.length === 0) {
    throw new Error(
      dropped > 0
        ? `The model returned ${dropped} placement${dropped === 1 ? '' : 's'} for ${flat.length} cards, but every one was missing the sheet or column it belongs to, so none could be used.`
        : `The model did not return a placement for any of the ${flat.length} cards it was sent.`,
    );
  }

  return {
    ok: true,
    placements: all,
    flowName,
    // Surfaced wherever a run ends, so a silent shortfall is visible rather
    // than looking like the docs simply had fewer cards than they do.
    stats: { cardsIn: flat.length, placed: all.length, dropped, batches: totalBatches },
  };
}

/**
 * Opt-in Auto Flow summaries: for each card, an ultra-short summary built from
 * the tag AND the card body, capped to strictly fewer words than the tag.
 *
 * The bodies are re-read from the user's own files here in the tab, and only
 * the short summaries are kept — the same boundary the desktop app drew, where
 * bodies never left the main process.
 */
export async function autoFlowSummarize(params: {
  files: { fileName: string; path: string }[];
  cards: { fileName: string; tag: string; maxWords: number }[];
}): Promise<{ ok: true; summaries: { fileName: string; tag: string; summary: string }[] }> {
  const files = params.files ?? [];
  const cards = params.cards ?? [];
  if (cards.length === 0) return { ok: true, summaries: [] };

  const keyOf = (fileName: string, tag: string) => `${fileName} ${tag.trim().toLowerCase()}`;
  const bodyByKey = new Map<string, string>();
  for (const f of files) {
    try {
      const { cards: withBodies } = await extractBlocksWithBodies(f.path);
      for (const c of withBodies) bodyByKey.set(keyOf(f.fileName, c.tag), c.body ?? '');
    } catch { /* skip a file we can't re-read; its cards summarize from the tag alone */ }
  }

  const items = cards.map((c) => ({
    tag: c.tag,
    body: bodyByKey.get(keyOf(c.fileName, c.tag)) ?? '',
    maxWords: Math.max(2, Number(c.maxWords) || 2),
  }));

  // Batched rather than truncated. Summaries are independent per card, so a
  // failed batch only costs THOSE cards their summary (they fall back to
  // tag+cite) instead of failing the whole run.
  const byTag = new Map<string, string>();
  let summarizeDone = 0;
  for (let i = 0; i < items.length; i += SUMMARIZE_BATCH_SIZE) {
    const slice = items.slice(i, i + SUMMARIZE_BATCH_SIZE);
    try {
      const prompt = renderPrompt('auto_flow_summarize', { CARDS_JSON: JSON.stringify(slice) });
      const parsed = parseJsonLoose(await callAI(prompt, 'balanced', { maxOutputTokens: 32768 }));
      for (const s of (Array.isArray(parsed?.summaries) ? parsed.summaries : [])) {
        if (s && typeof s.tag === 'string' && typeof s.summary === 'string') {
          byTag.set(s.tag.trim().toLowerCase(), s.summary.trim());
        }
      }
    } catch { /* this batch keeps tag+cite; the rest still get summaries */ }
    summarizeDone += slice.length;
    emitProgress({
      phase: 'summarizing',
      batchesDone: Math.ceil(summarizeDone / SUMMARIZE_BATCH_SIZE),
      totalBatches: Math.ceil(items.length / SUMMARIZE_BATCH_SIZE),
      cardsDone: summarizeDone, cardsTotal: items.length,
    });
  }

  const summaries = cards.map((c) => {
    let summary = byTag.get(c.tag.trim().toLowerCase()) ?? '';
    // Enforce the word cap defensively (strictly fewer than the tag's words),
    // in case the model overshoots — hard-truncate rather than trust it.
    const cap = Math.max(1, (Number(c.maxWords) || 2) - 1);
    if (summary) {
      const words = summary.split(/\s+/).filter(Boolean);
      if (words.length > cap) summary = words.slice(0, cap).join(' ');
    }
    return { fileName: c.fileName, tag: c.tag, summary };
  });
  return { ok: true, summaries };
}

/**
 * A tab's hover-tooltip summary — one sentence describing the argument on that
 * sheet as a WHOLE, not a list of what's on it. Reads only tags and cites
 * already visible in the flow; never card bodies.
 *
 * This one has no retry affordance in the UI (it fires from a hover), so it is
 * the one call here that retries on its own. It fails fast on anything a retry
 * cannot fix — that invisible backoff on a permanently-rejected request is
 * exactly what turned this feature into "random popups" mid-round.
 */
export async function summarizeFlowSheet(params: {
  sheetName: string;
  event: 'policy' | 'pf';
  entries: string[];
}): Promise<{ ok: true; summary: string }> {
  const entries = (params.entries ?? []).filter((s) => typeof s === 'string' && s.trim());
  if (entries.length === 0) return { ok: true, summary: '' };
  const prompt = renderPrompt('summarize_flow_sheet', {
    EVENT: params.event === 'pf' ? 'Public Forum' : 'Policy',
    SHEET_NAME: params.sheetName || 'Untitled sheet',
    ENTRIES: entries.slice(0, 80).map((s) => `- ${s}`).join('\n'),
  });
  const raw = await withDelayedRetry(() => callAI(prompt, 'lite', { maxOutputTokens: 200 }));
  return { ok: true, summary: raw.trim().replace(/^["']|["']$/g, '') };
}

// Retry with backoff, but ONLY for a call the user has no way to retry
// themselves. A rejection is not an outage: waiting ~100s and asking again with
// the same key, the same unsupported region, or the same over-long prompt gets
// the same answer — it just delays the error until they've forgotten what
// triggered it.
async function withDelayedRetry<T>(fn: () => Promise<T>, delaysMs = [8_000, 30_000, 60_000]): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (isPermanentAiError(e)) throw e;
      if (attempt < delaysMs.length) await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
  throw lastErr;
}

/**
 * True for errors a retry cannot fix: the provider REJECTED the request (4xx
 * other than 429 — bad key, forbidden, model not found, unsupported region,
 * bad argument), there was no key to send, the prompt is over the context
 * limit, or the answer was cut off.
 */
function isPermanentAiError(e: unknown): boolean {
  const m = String((e as any)?.message ?? e ?? '');
  if ((e as any)?.name === 'NoKeyError' || isTruncatedResponse(e)) return true;
  return /\[(400|401|403|404)\b|\(HTTP (400|401|403|404)\)|FAILED_PRECONDITION|INVALID_ARGUMENT|PERMISSION_DENIED|UNAUTHENTICATED|NOT_FOUND|invalid_api_key|context window|context limit|too large/i.test(m);
}

// ── Analyze Round ────────────────────────────────────────────────────────────

export interface AnalyzeRoundResult {
  ok: true;
  question?: any;
  sideALabel?: string;
  sideBLabel?: string;
  verdict?: { leading: 'A' | 'B' | 'even'; reason: string };
  dropped?: { side: 'A' | 'B'; argument: string; sheet: string }[];
  clashes?: { topic: string; claimA: string | null; claimB: string | null; winner: 'A' | 'B' | 'even'; reasoning: string }[];
  nextSpeech?: { action: string; why: string }[];
  coverage?: string;
}

const FLOW_BUDGET = 60_000;

export async function analyzeRound(params: {
  flowSummary: string;
  notes: string;
  docs: { fileName: string; text: string }[];
  event: 'policy' | 'pf';
  clarifications: { question: string; answer: string }[];
  onPass?: (pass: number, total: number) => void;
}): Promise<AnalyzeRoundResult> {
  const summary = String(params.flowSummary ?? '').trim();
  if (!summary) throw new Error('No flow content to analyze.');
  const clar = params.clarifications ?? [];
  const docList = params.docs ?? [];
  const eventLabel = params.event === 'pf' ? 'Public Forum' : 'Policy';
  const notesText = params.notes?.trim() ? params.notes.trim() : '(none provided)';

  // Docs are capped the same way regardless of method — they're supplementary
  // context, not the round itself. capForPrompt ASKS before it cuts anything.
  const cappedDocs: string[] = [];
  for (const d of docList) {
    cappedDocs.push(`--- ${d.fileName} ---\n${await capForPrompt(String(d.text ?? ''), 20_000, d.fileName)}`);
  }
  const docsText = docList.length
    ? await capForPrompt(cappedDocs.join('\n\n'), 100_000, 'your uploaded docs')
    : '(none uploaded)';

  const s = readSettings();
  const sheets = splitFlowSummaryIntoSheets(summary);
  const tooBig = summary.length > FLOW_BUDGET;

  let flowSummaryText: string;
  let coverageNote: string;
  let inputKind: string;

  if (!tooBig) {
    flowSummaryText = summary;
    coverageNote = buildCoverageNote(sheets.map((sh) => ({ label: sh.label, kept: sh.items, total: sh.items })));
    inputKind = "The debater's own flow, in full.";
  } else if (!s.longInputAllowed) {
    // "Work past the length limit" is off — cap and ask. The model is still
    // told what it's missing, which a silent slice never does.
    flowSummaryText = await capForPrompt(summary, FLOW_BUDGET, 'your flow');
    const shown = splitFlowSummaryIntoSheets(flowSummaryText);
    const seen = new Map(shown.map((sh) => [sh.label, sh.items]));
    coverageNote = buildCoverageNote(sheets.map((sh) => ({ label: sh.label, kept: seen.get(sh.label) ?? 0, total: sh.items })));
    inputKind = "PART of the debater's flow — it was too long to send whole.";
  } else if (s.longInputMethod === 'sample') {
    const sampled = sampleSections(sheets, FLOW_BUDGET);
    flowSummaryText = sampled.text;
    coverageNote = buildCoverageNote(sampled.coverage);
    inputKind = "An even sample of the debater's flow — every sheet is represented, but not every card.";
  } else {
    // 'passes' — read the whole round in chunks, then analyze from those notes.
    const chunks = chunkSections(sheets, FLOW_BUDGET);
    const notesFromPasses: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      params.onPass?.(i + 1, chunks.length);
      const passPrompt = renderPrompt('analyze_round_pass', {
        EVENT: eventLabel,
        PART_NUMBER: String(i + 1),
        PART_TOTAL: String(chunks.length),
        SHEET_NAMES: chunks[i].map((sh) => `- ${sh.label} (${sh.items} cards)`).join('\n'),
        FLOW_PART: chunks[i].map((sh) => sh.text).join('\n'),
        NOTES: notesText,
      });
      notesFromPasses.push(`--- Notes from part ${i + 1} of ${chunks.length} ---\n${await callAI(passPrompt, 'balanced', { maxOutputTokens: 32768 })}`);
    }
    flowSummaryText = notesFromPasses.join('\n\n');
    coverageNote = `You are seeing the WHOLE round — every sheet was read across ${chunks.length} passes. Nothing was withheld.`;
    inputKind =
      `NOTES taken while reading the complete flow across ${chunks.length} passes — not the raw flow itself. ` +
      `Every card was read, but you are working from those readings, so prefer claims the notes state explicitly ` +
      `and avoid inventing detail they don't contain.`;
  }

  const prompt = renderPrompt('analyze_round', {
    EVENT: eventLabel,
    INPUT_KIND: inputKind,
    COVERAGE_NOTE: coverageNote,
    FLOW_SUMMARY: flowSummaryText,
    DOCS_TEXT: docsText,
    NOTES: notesText,
    CLARIFICATIONS_JSON: clar.length ? JSON.stringify(clar) : '(none yet)',
    QUESTIONS_ASKED: String(clar.length),
  });

  // The structured result runs long — the default 8192-token cap is enough for
  // prose but not for a full round's worth of JSON.
  const raw = await callAI(prompt, 'balanced', { maxOutputTokens: 32768 });
  const parsed = parseJsonLoose(raw);
  if (!parsed) {
    throw new Error(`The model's answer couldn't be read as an analysis. First 300 characters: ${JSON.stringify(raw.slice(0, 300))}`);
  }

  if (parsed?.question?.question && Array.isArray(parsed.question.options)) {
    return { ok: true, question: parsed.question };
  }

  // Coerce defensively: drop any entry missing its required fields rather than
  // letting a malformed one break the render.
  const side = (v: any): 'A' | 'B' | 'even' => (v === 'A' || v === 'B' ? v : 'even');
  const str = (v: any) => (typeof v === 'string' ? v.trim() : '');

  const verdict = { leading: side(parsed.verdict?.leading), reason: str(parsed.verdict?.reason) };
  if (!verdict.reason) {
    throw new Error('The model returned an analysis with no verdict in it. Try again, or shorten the round.');
  }

  return {
    ok: true,
    sideALabel: str(parsed.sideALabel) || (params.event === 'pf' ? 'Pro' : 'Aff'),
    sideBLabel: str(parsed.sideBLabel) || (params.event === 'pf' ? 'Con' : 'Neg'),
    verdict,
    // A dropped argument with no side attributed is not a usable finding, so
    // those are discarded rather than shown as "even".
    dropped: (Array.isArray(parsed.dropped) ? parsed.dropped : [])
      .map((d: any) => ({ side: d?.side === 'B' ? 'B' as const : 'A' as const, argument: str(d?.argument), sheet: str(d?.sheet) }))
      .filter((d: any) => d.argument),
    clashes: (Array.isArray(parsed.clashes) ? parsed.clashes : [])
      .map((c: any) => ({
        topic: str(c?.topic),
        claimA: str(c?.claimA) || null,
        claimB: str(c?.claimB) || null,
        winner: side(c?.winner),
        reasoning: str(c?.reasoning),
      }))
      .filter((c: any) => c.topic),
    nextSpeech: (Array.isArray(parsed.nextSpeech) ? parsed.nextSpeech : [])
      .map((n: any) => ({ action: str(n?.action), why: str(n?.why) }))
      .filter((n: any) => n.action),
    coverage: coverageNote,
  };
}

export type { ExtractedFlowCard };
