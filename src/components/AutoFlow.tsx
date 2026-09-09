import React, { useRef, useState, useEffect } from 'react';
import { useApp, FlowMeta } from '../store/appStore';
import { AIQuestion, AIClarification, ExtractedFlowCard } from '../types';
import AIQuestionPrompt from './AIQuestionPrompt';
import { LoadingState } from './Spinner';
import ProgressBar from './ProgressBar';
import { humanizeGeminiError } from '../utils/geminiError';
import { escapeHtml } from '../lib/cellHtml';
import { useDragActive } from '../hooks/useDragActive';
import { readAutoFlowTagStyle } from '../lib/autoFlowTagStyle';
import { pruneUnnamedEmptySheets } from '../lib/flowSheetNaming';
import { parseAutoFlow, sheetAliasKey } from '../lib/autoFlowParse';
import { findColumnIndex, firstEmptyRow, inferEventFromPockets, inferVariantFromHats } from '../lib/autoFlowPlacement';
import { summaryColumnFor } from '../lib/flowTabSummary';
import { readKey, writeKey } from '../platform/storage';
import { openFiles, resolveDroppedFiles, fileNameOf } from '../platform/files';
import { extractBlocks } from '../platform/docx';
import { autoFlowClassify, autoFlowSummarize, onAutoFlowProgress } from '../platform/aiFeatures';
import {
  StoredFlowData, SheetData, PolicyVariant, PFOrder,
  POLICY_COLS, PF_PRO_FIRST_COLS, PF_CON_FIRST_COLS,
  SHEETS_STOCK_ISSUES, SHEETS_ADVANTAGE, SHEETS_PF,
  NUM_ROWS, makeDefaultData,
} from './FlowView';

// Auto Flow: upload one or many speech docs, and Warroom AI sorts their tags into
// the right column/sheet of a flow — either a brand new one or an existing one.
// It only ever reads tags + cites + heading structure (via speechdoc:extractBlocks
// / ExtractedFlowCard), never card bodies. See DEBATE_DOC_STRUCTURE.md for the
// document model this is built against, and CardCutter.tsx for the AI
// question-pause-resume pattern this file copies (runClassify/answerQuestion
// mirror its runEmphasize/answerQuestion).

const ENGINE_KEY = 'warroom-autoflow-engine';

type Step = 'upload' | 'extracting' | 'target' | 'classifying' | 'review' | 'writing' | 'live' | 'done';

interface DocResult {
  fileName: string;
  path: string;
  cards: ExtractedFlowCard[];
  error?: string;
}

// Normalizes a tag for matching "respondsTo" against the tag it names — the AI is
// told to copy the target tag EXACTLY, but in practice it sometimes fixes a typo,
// drops trailing punctuation, or collapses whitespace, so an exact string compare
// silently drops most same-row alignments. Strip case/punctuation/spacing so
// those harmless variations still match.
function normTag(s: string): string {
  return s.trim().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Best-effort lookup of the card a placement answers. Tries an exact normalized
// match first, then a substring match either direction (the AI paraphrased or
// truncated it), then falls back to the entry with the highest word overlap —
// only accepted above a similarity floor, so an unrelated card is never chosen.
function resolveRespondsTo<T>(respondsTo: string, index: Map<string, T>): T | undefined {
  const key = normTag(respondsTo);
  if (!key) return undefined;
  const exact = index.get(key);
  if (exact) return exact;

  let best: T | undefined; let bestScore = 0;
  const keyWords = new Set(key.split(' ').filter(Boolean));
  for (const [k, v] of index) {
    if (k.includes(key) || key.includes(k)) return v; // substring match — good enough
    const kWords = new Set(k.split(' ').filter(Boolean));
    const overlap = [...keyWords].filter((w) => kWords.has(w)).length;
    const union = new Set([...keyWords, ...kWords]).size || 1;
    const score = overlap / union;
    if (score > bestScore) { bestScore = score; best = v; }
  }
  return bestScore >= 0.5 ? best : undefined;
}

// Word count of a tagline — the cap the AI summary must come in strictly under.
// Preloaded at extract time (see extractAll) so it's ready without recomputation
// the moment the user turns on summary mode. See CLAUDE.md's preload guidance.
function tagWordCount(tag: string): number {
  return tag.trim().split(/\s+/).filter(Boolean).length || 1;
}

interface Placement {
  id: string;
  fileName: string;
  tag: string;
  cite: string;
  column: string;
  sheetName: string;
  isNewSheet: boolean;
  // The tag text of the card this one directly answers (from the classify step),
  // or null. Drives same-row alignment + arrow drawing in the write step.
  respondsTo: string | null;
  // The plan text (policy) — forced to the first cell of the first sheet.
  isPlan: boolean;
  // Which family the card's sheet belongs to (from the classify step), driving
  // tab ORDER in the write step: 'advantage' = aff case position (advantages
  // first, in 1AC order), 'offcase' = neg off-case, null = existing/structural.
  sheetRole: 'advantage' | 'offcase' | null;
  // AI-generated short summary (only when summary mode is on). When present the
  // write step writes THIS instead of tag+cite, and marks the cell as an AI cell.
  summary?: string;
  removed: boolean;
}

type TargetCtx =
  | { kind: 'existing'; flowId: string }
  | { kind: 'new'; event: 'policy' | 'pf'; variant: PolicyVariant; pfOrder: PFOrder };

interface ClassifyCtx {
  docs: { fileName: string; cards: ExtractedFlowCard[] }[];
  existingColumns: string[];
  existingSheetNames: string[];
  event: 'policy' | 'pf';
  variantLabel: string;
  /**
   * Where the result is going. Carried here (rather than read from `targetCtx`
   * state) so the write can start in the same tick classification finishes,
   * before React has flushed — and so the clarifying-question resume path,
   * which replays a stored ClassifyCtx, still knows the destination.
   */
  target: TargetCtx;
}

interface AutoFlowProgress {
  phase: 'classifying' | 'summarizing';
  batchesDone: number;
  totalBatches: number;
  cardsDone: number;
  cardsTotal: number;
}

/** Returned by ai:autoFlowClassify — see the handler's `stats` field. */
interface ClassifyStats {
  cardsIn: number;
  placed: number;
  /** Placement objects the AI returned that were missing tag/column/sheetName. */
  dropped: number;
  batches: number;
}

interface SkippedPlacement {
  tag: string;
  sheetName: string;
  column: string;
  reason: string;
}

function columnsForEvent(event: 'policy' | 'pf', pfOrder: PFOrder): string[] {
  return event === 'policy' ? POLICY_COLS : (pfOrder === 'pro-first' ? PF_PRO_FIRST_COLS : PF_CON_FIRST_COLS);
}
function sheetsForVariant(event: 'policy' | 'pf', variant: PolicyVariant): string[] {
  return event === 'pf' ? SHEETS_PF : (variant === 'advantage' ? SHEETS_ADVANTAGE : SHEETS_STOCK_ISSUES);
}

// Builds the cell HTML for one card's tag+cite, honoring the user's Auto Flow tag
// style (Settings → Flow & Auto Flow → Auto Flow tag style). Only bold/italic/underline are applied
// — color and fontSize are NOT, because a flow cell can't carry them (see the
// comment in src/lib/autoFlowTagStyle.ts and src/lib/cellHtml.ts's
// ALLOWED_STYLE_PROPS: no per-run color or font-size support in a cell, so
// writing them would just be silently stripped the next time the flow renders).
function buildCellHtml(tag: string, cite: string, summary?: string): string {
  const style = readAutoFlowTagStyle();
  const useSummary = !!(summary && summary.trim());
  // A summary REPLACES tag + cite (that's the whole point of summary mode); it
  // still gets the user's tag emphasis, but no cite line underneath.
  let t = escapeHtml(useSummary ? summary!.trim() : tag);
  if (style.underline) t = `<u>${t}</u>`;
  if (style.italic) t = `<i>${t}</i>`;
  // Cells are bold by DEFAULT now (see `.flow-cell` in index.css), so bold is
  // the absence of markup and un-bold is what has to be stated. Writing <b>
  // here would be a no-op; writing nothing when the user asked for a plain tag
  // would silently give them a bold one.
  if (!style.bold) t = `<span style="font-weight: normal">${t}</span>`;
  // The cite is never bold — it's the line that has to read as subordinate to
  // the tag above it, and with a bold baseline it no longer does so for free.
  return useSummary ? t : `${t}<br><span style="font-weight: normal">${escapeHtml(cite)}</span>`;
}

// The stages of a run, shown as a checklist while it works so the wait is
// legible instead of being one spinner that could mean anything.
const STAGES = [
  { i: 0, label: 'Reading your docs', what: 'pulling out every tag and cite' },
  { i: 1, label: 'Sorting with Warroom AI', what: 'deciding the sheet and column for each card' },
  { i: 2, label: 'Summarizing cards', what: 'only when summary mode is on' },
  { i: 3, label: 'Writing into the flow', what: 'placing cards and drawing answer arrows' },
] as const;

// ── Live write pacing ────────────────────────────────────────────────────────
// A frame is one persist + one `warroom-flow-updated`, which makes the open
// FlowView re-read and re-render. That's cheap but not free, so cards are
// written in small groups rather than one at a time — a 800-card packet at one
// card per frame would take minutes and hammer the disk. Grouping keeps the
// whole run to roughly FILL_TARGET_MS regardless of size, while still reading as
// "watching it fill in" rather than "it appeared".
const FRAME_MS = 90;
const FILL_TARGET_MS = 14_000;
/** Extra beat when the write moves to a different tab, so the switch registers. */
const TAB_SWITCH_MS = 320;

/**
 * Replay a finished Auto Flow write into the live flow, one group of cards at a
 * time, switching tabs as the writes move between sheets.
 *
 * `activeSheetIdx` is part of the stored flow and FlowView restores it on every
 * external-edit reload, so simply persisting the index of the sheet currently
 * being written is what makes the user's view follow along — no extra plumbing.
 *
 * The finished `finalSheets` is written at the end regardless, so the result is
 * byte-identical to a non-live run; the replay only controls what the user sees
 * on the way there.
 */
async function replayIntoFlow(
  flowId: string,
  base: StoredFlowData,
  writtenSheets: SheetData[],
  finalSheets: SheetData[],
  writeLog: { sheetIdx: number; cellKey: string; html: string }[],
  skip: { current: boolean },
) {
  const live: SheetData[] = base.sheets.map((s) => ({ ...s, cells: { ...s.cells } }));
  const perFrame = Math.max(1, Math.ceil(writeLog.length / Math.max(1, FILL_TARGET_MS / FRAME_MS)));

  // A frame is pushed straight into the open FlowView, NOT through storage.
  //
  // It used to persist the whole flow and fire 'warroom-flow-updated' on every
  // frame — ~150 disk writes, each one making FlowView blank itself to "Loading
  // flow…" and re-read from disk. The read landed after the next frame had
  // already fired, so the grid strobed the loading screen and no cell was ever
  // on screen long enough to be seen filling in. Frames are ephemeral by nature;
  // only the finished state below is worth persisting.
  const frame = (sheets: SheetData[], activeSheetIdx: number) => {
    window.dispatchEvent(new CustomEvent('warroom-flow-live-patch', {
      detail: { flowId, sheets, activeSheetIdx },
    }));
  };

  let lastSheetIdx = -1;
  for (let i = 0; i < writeLog.length; i += perFrame) {
    if (skip.current) break; // jump to the finished state below
    const group = writeLog.slice(i, i + perFrame);
    for (const w of group) {
      if (live[w.sheetIdx]) live[w.sheetIdx].cells[w.cellKey] = w.html;
    }
    const sheetIdx = group[group.length - 1].sheetIdx;
    const switched = sheetIdx !== lastSheetIdx && lastSheetIdx !== -1;
    lastSheetIdx = sheetIdx;
    frame(live.map((s) => ({ ...s, cells: { ...s.cells } })), sheetIdx);
    await new Promise((r) => setTimeout(r, switched ? TAB_SWITCH_MS : FRAME_MS));
  }

  // Land on the real finished state: arrows, AI-cell marks, tab summaries, and
  // the cleanup of unused default tabs all arrive together at the end. The tab
  // the user is left on is the last one written to, mapped through the prune.
  const lastName = writtenSheets[lastSheetIdx]?.name;
  const finalIdx = Math.max(0, finalSheets.findIndex((s) => s.name === lastName));
  await writeKey(`flow_data_${flowId}`, {
    ...base, sheets: finalSheets, activeSheetIdx: finalIdx,
  } as StoredFlowData);
  window.dispatchEvent(new CustomEvent('warroom-flow-updated', { detail: { flowId } }));
}

export default function AutoFlow({ onClose }: { onClose: () => void }) {
  const { event, flowsIndex, setFlowsIndex, setView } = useApp();
  const [step, setStep] = useState<Step>('upload');
  const { dragActive, setDragActive, dragHandlers } = useDragActive();
  const [error, setError] = useState('');

  const [docs, setDocs] = useState<DocResult[]>([]);
  // Preloaded at upload: word count of every tagline, keyed `fileName tag`.
  // Ready to become the AI summary's word cap without recomputing later.
  const wordCounts = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && step !== 'writing') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, step]);

  // Target step
  const [targetMode, setTargetMode] = useState<'new' | 'existing'>('new');
  const [selectedFlowId, setSelectedFlowId] = useState<string>('');
  const [newEvent, setNewEvent] = useState<'policy' | 'pf'>('policy');
  const [newVariant, setNewVariant] = useState<PolicyVariant>('stock-issues');
  const [newPfOrder, setNewPfOrder] = useState<PFOrder>('pro-first');
  const [variantInferred, setVariantInferred] = useState(false);
  // Opt-in: replace each card's tag+cite with a short AI summary of the card
  // (built from tag + body), capped under the tagline's own word count. Off by
  // default — it reads card bodies (sent to the AI) and costs an extra call.
  const [summarize, setSummarize] = useState(false);

  // Which engine sorts the cards. Persisted so the choice survives the dialog
  // closing — this is a working preference, not a per-run decision, and having
  // to re-pick it every time is exactly the sort of friction that makes people
  // stop using the faster path.
  const [engine, setEngineState] = useState<'ai' | 'parser'>(() => {
    try { return localStorage.getItem(ENGINE_KEY) === 'parser' ? 'parser' : 'ai'; } catch { return 'ai'; }
  });
  function setEngine(next: 'ai' | 'parser') {
    setEngineState(next);
    try { localStorage.setItem(ENGINE_KEY, next); } catch {}
  }
  const [summarizing, setSummarizing] = useState(false);

  // Classify / question-pause-resume (mirrors CardCutter's runEmphasize/answerQuestion)
  const [clarifications, setClarifications] = useState<AIClarification[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState<AIQuestion | null>(null);
  const [pendingClassify, setPendingClassify] = useState<ClassifyCtx | null>(null);
  const [answering, setAnswering] = useState(false);
  const [targetCtx, setTargetCtx] = useState<TargetCtx | null>(null);

  // Batch progress, pushed from the main process as each classify/summarize
  // batch lands — so a long run shows real movement instead of a blank spinner.
  const [progress, setProgress] = useState<AutoFlowProgress | null>(null);
  // Seconds since sorting began. The bar only advances when a whole batch lands,
  // and one batch can take a while — without a second-by-second number on screen
  // there is nothing to distinguish "working" from "hung", which is exactly how
  // a long first batch read.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (step !== 'classifying') { setElapsed(0); return; }
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [step]);
  useEffect(() => {
    return onAutoFlowProgress((p) => setProgress(p));
  }, []);

  // Review
  const [placements, setPlacements] = useState<Placement[]>([]);
  // How many cards went in vs. how many placements came back — shown on the
  // review step so a shortfall is visible instead of silently looking like the
  // docs just had fewer cards.
  const [classifyStats, setClassifyStats] = useState<ClassifyStats | null>(null);
  // The aff Warroom AI read off the 1AC, used to name a new flow. Null when it
  // couldn't tell, in which case the flow is named after today's date.
  const [aiFlowName, setAiFlowName] = useState<string | null>(null);
  // Parser-run shortfalls, surfaced on review: cards it could place but not
  // separate into a named position, and cards it couldn't place at all.
  const [parserNotes, setParserNotes] = useState<
    { unresolved: number; skipped: number; docs: { fileName: string; sheetName: string; count: number }[] } | null
  >(null);

  // Writing / done
  const [writeSummary, setWriteSummary] = useState<{ written: number; skipped: SkippedPlacement[] } | null>(null);

  // ── Step 1: upload ──────────────────────────────────────────────────────────

  async function extractAll(paths: string[]) {
    setStep('extracting');
    setError('');
    const results: DocResult[] = [];
    const counts = new Map<string, number>();
    for (const p of paths) {
      const fileName = fileNameOf(p);
      try {
        const { cards } = await extractBlocks(p);
        // Preload each tagline's word count now — it's cheap, derived, and
        // can't go stale, so computing it here beats making the user wait for
        // it later during the summary pass.
        for (const c of cards) counts.set(`${fileName} ${c.tag.trim().toLowerCase()}`, tagWordCount(c.tag));
        results.push({
          fileName, path: p, cards,
          error: cards.length === 0 ? 'No cards found in this doc.' : undefined,
        });
      } catch (e: any) {
        results.push({ fileName, path: p, cards: [], error: e?.message || 'Could not read this file.' });
      }
    }
    wordCounts.current = counts;
    setDocs(results);

    // This app is policy only, so there is no event to infer — but the aff's
    // hat/block structure still decides Stock Issues vs. Advantage, which is
    // the default the user reviews on the next step.
    const resolvedEvent = 'policy' as const;
    setNewEvent(resolvedEvent);

    const allHats = results.flatMap((d) => d.cards.flatMap((c) => [c.hat, c.block]));
    const inferredVariant = inferVariantFromHats(allHats);
    setNewVariant(inferredVariant ?? 'stock-issues');
    setVariantInferred(!!inferredVariant);

    setStep('target');
  }

  async function pickFiles() {
    const paths = await openFiles(['docx']);
    if (paths.length === 0) return;
    await extractAll(paths);
  }

  // ── Step 2 → 3: target, then kick off classify ──────────────────────────────

  async function runClassify(clars: AIClarification[], ctx: ClassifyCtx) {
    setPendingClassify(ctx);
    setPendingQuestion(null);
    setClarifications(clars);
    setStep('classifying');
    setError('');
    setProgress(null);
    setClassifyStats(null);
    setParserNotes(null);
    try {
      const res = await autoFlowClassify({
        docs: ctx.docs,
        existingSheetNames: ctx.existingSheetNames,
        existingColumns: ctx.existingColumns,
        event: ctx.event,
        variant: ctx.variantLabel,
        clarifications: clars,
      });
      if (res.question) { setPendingQuestion(res.question); return; }
      if (res.stats) setClassifyStats(res.stats as ClassifyStats);
      const suggestedName: string | undefined = typeof res.flowName === 'string' ? res.flowName : undefined;
      setAiFlowName(suggestedName ?? null);
      let list: Placement[] = (res.placements || []).map((p: any) => ({
        id: crypto.randomUUID(),
        fileName: p.fileName,
        tag: p.tag,
        cite: p.cite,
        column: p.column,
        sheetName: p.sheetName,
        isNewSheet: !!p.isNewSheet,
        respondsTo: typeof p.respondsTo === 'string' && p.respondsTo.trim() ? p.respondsTo.trim() : null,
        isPlan: !!p.isPlan,
        sheetRole: p.sheetRole === 'advantage' || p.sheetRole === 'offcase' ? p.sheetRole : null,
        removed: false,
      }));
      // Opt-in summary pass: replace each card's tag+cite with a short AI
      // summary (built from tag + body, capped under the tagline's word count).
      // Bodies are re-read from the user's own files and only the short
      // summaries are kept — the full text is never held on to.
      if (summarize && list.length > 0) {
        setSummarizing(true);
        try {
          const files = docs.filter((d) => d.cards.length > 0).map((d) => ({ fileName: d.fileName, path: d.path }));
          const cards = list.map((p) => ({
            fileName: p.fileName,
            tag: p.tag,
            maxWords: wordCounts.current.get(`${p.fileName} ${p.tag.trim().toLowerCase()}`) ?? tagWordCount(p.tag),
          }));
          const sres = await autoFlowSummarize({ files, cards });
          if (Array.isArray(sres.summaries)) {
            const byKey = new Map<string, string>();
            for (const s of sres.summaries) byKey.set(`${s.fileName} ${String(s.tag).trim().toLowerCase()}`, s.summary);
            list = list.map((p) => {
              const sum = byKey.get(`${p.fileName} ${p.tag.trim().toLowerCase()}`);
              return sum && sum.trim() ? { ...p, summary: sum.trim() } : p;
            });
          }
        } catch { /* summaries are best-effort — fall back to tag+cite for any that fail */ }
        finally { setSummarizing(false); }
      }
      setPlacements(list);
      // A BRAND-NEW flow goes straight to writing, live, with no review step:
      // there's nothing in it to damage, so approving placements one by one is a
      // formality. Adding into an EXISTING flow always stops at review first —
      // that flow already holds the user's own work, and a bad placement there
      // costs them something, so it stays opt-in and writes silently.
      if (ctx.target.kind === 'new') {
        await commitWrite(true, ctx.target, list, suggestedName);
        return;
      }
      setStep('review');
    } catch (e: any) {
      setError(humanizeGeminiError(e?.message) || e?.message || 'Warroom AI could not sort these cards.');
      setStep('target');
    } finally {
      setProgress(null);
    }
  }

  async function answerQuestion(answer: string) {
    if (!pendingQuestion || !pendingClassify || answering) return;
    setAnswering(true);
    const next = [...clarifications, { question: pendingQuestion.question, answer }];
    await runClassify(next, pendingClassify);
    setAnswering(false);
  }

  /**
   * Parser engine. No IPC and no model — the cards are already in memory here,
   * so this is a synchronous pass over them and the run is effectively instant.
   * Feeds the identical `Placement[]` the AI path produces, so review, live
   * writing, and the write step itself are all unchanged downstream.
   */
  async function runParser(
    docsIn: { fileName: string; cards: ExtractedFlowCard[] }[],
    columns: string[],
    existingSheets: string[],
    event: 'policy' | 'pf',
    target: TargetCtx,
  ) {
    setStep('classifying');
    setError('');
    setProgress(null);
    try {
      const res = parseAutoFlow({ docs: docsIn, columns, existingSheets, event });
      if (res.placements.length === 0) {
        throw new Error(
          'The parser couldn\'t place a single card — none of these docs had a recognisable speech label ' +
          'on their headings or filenames. Switch to Warroom AI for these docs.',
        );
      }
      const list: Placement[] = res.placements.map((p) => ({ ...p, id: crypto.randomUUID(), removed: false }));
      const cardsIn = docsIn.reduce((n, d) => n + d.cards.length, 0);
      setClassifyStats({ cardsIn, placed: list.length, dropped: res.skipped.length, batches: 0 });
      const notes = { unresolved: res.unresolved, skipped: res.skipped.length, docs: res.unresolvedDocs };
      setParserNotes(notes);
      setPlacements(list);
      setAiFlowName(res.flowName ?? null);
      if (target.kind === 'new') { await commitWrite(true, target, list, res.flowName, notes); return; }
      setStep('review');
    } catch (e: any) {
      setError(e?.message || 'The parser could not sort these cards.');
      setStep('target');
    }
  }

  async function confirmTarget() {
    setError('');
    const usableDocs = docs.filter((d) => d.cards.length > 0);
    if (usableDocs.length === 0) {
      setError('None of the uploaded docs had any cards to sort.');
      return;
    }
    const docsForClassify = usableDocs.map((d) => ({ fileName: d.fileName, cards: d.cards }));

    if (targetMode === 'existing') {
      if (!selectedFlowId) { setError('Pick a flow to add into.'); return; }
      const data: StoredFlowData | null = await readKey(`flow_data_${selectedFlowId}`);
      if (!data) { setError('Could not load that flow — try picking it again.'); return; }
      const existingColumns = data.customColumns ?? columnsForEvent(data.event, data.pfOrder);
      const existingSheetNames = data.sheets.map((s) => s.name);
      const variantLabel = data.event === 'policy' ? data.variant : data.pfOrder;
      const target: TargetCtx = { kind: 'existing', flowId: selectedFlowId };
      setTargetCtx(target);
      if (engine === 'parser') {
        await runParser(docsForClassify, existingColumns, existingSheetNames, data.event, target);
        return;
      }
      await runClassify(clarifications, { docs: docsForClassify, existingColumns, existingSheetNames, event: data.event, variantLabel, target });
    } else {
      const existingColumns = columnsForEvent(newEvent, newPfOrder);
      const existingSheetNames = sheetsForVariant(newEvent, newVariant);
      const variantLabel = newEvent === 'policy' ? newVariant : newPfOrder;
      const target: TargetCtx = { kind: 'new', event: newEvent, variant: newVariant, pfOrder: newPfOrder };
      setTargetCtx(target);
      if (engine === 'parser') {
        await runParser(docsForClassify, existingColumns, existingSheetNames, newEvent, target);
        return;
      }
      await runClassify(clarifications, { docs: docsForClassify, existingColumns, existingSheetNames, event: newEvent, variantLabel, target });
    }
  }

  // ── Step 4: review ──────────────────────────────────────────────────────────

  function toggleRemoved(id: string) {
    setPlacements((prev) => prev.map((p) => (p.id === id ? { ...p, removed: !p.removed } : p)));
  }

  const acceptedCount = placements.filter((p) => !p.removed).length;

  // While the replay runs the flow itself is the thing worth looking at, so the
  // wizard collapses to a small corner card with no backdrop instead of sitting
  // over the top of it.
  const live = step === 'live';
  const cardsBeingSorted = docs.reduce((n, d) => n + d.cards.length, 0);

  // What the progress panel says, derived from the real run state — never a
  // generic "working…". `stagePct` is null only before the first progress event
  // arrives, which renders the bar indeterminate for that brief window.
  const stageIndex = step === 'extracting' ? 0
    : summarizing ? 2
    : (step === 'writing' || step === 'live') ? 3
    : 1;
  const stagePct = progress && progress.cardsTotal > 0
    ? (progress.cardsDone / progress.cardsTotal) * 100
    : null;
  const stageTitle = summarizing ? 'Summarizing cards'
    : engine === 'parser' ? 'Reading the documents'
    : 'Sorting with Warroom AI';
  const stageDetail = progress && progress.cardsTotal > 0
    ? `Batch ${Math.min(progress.batchesDone + 1, progress.totalBatches)} of ${progress.totalBatches} · `
      + `${progress.cardsDone.toLocaleString()} of ${progress.cardsTotal.toLocaleString()} cards done`
    : `Sending ${cardsBeingSorted.toLocaleString()} card${cardsBeingSorted === 1 ? '' : 's'} to Warroom AI…`;
  // Set by "Skip animation" — the replay loop checks it each frame and jumps
  // straight to the finished flow. A ref, not state: the loop reads it between
  // awaits and would never see a re-rendered value.
  const skipLive = useRef(false);

  // ── Step 5: write ────────────────────────────────────────────────────────────

  /**
    * `ctx` and `list` are passed explicitly by the live path, which runs
    * immediately after `setTargetCtx`/`setPlacements` in the same tick — React
    * state hasn't flushed yet at that point, so reading it here would use the
    * previous render's values (null / empty). The review path omits both and
    * gets the committed state, which is what it wants.
    */
  async function commitWrite(live = false, ctxIn?: TargetCtx, listIn?: Placement[], nameIn?: string, notesIn?: typeof parserNotes) {
    const ctx = ctxIn ?? targetCtx;
    // Same reason as ctxIn/listIn above: the new-flow path calls this in the tick
    // that set the state, so reading `parserNotes` here would see the old value.
    const notes = notesIn ?? parserNotes;
    if (!ctx) return;
    setStep('writing');
    setError('');
    try {
      const accepted = (listIn ?? placements).filter((p) => !p.removed);
      // Nothing to write. This USED to sail straight through: a flow was created,
      // every default tab was pruned for being empty, and the user was dropped
      // into a flow containing one blank "RFD/Notes" with the wizard already
      // closed and no error anywhere. Never create a flow out of zero cards.
      if (accepted.length === 0) {
        throw new Error(
          'Warroom AI didn\'t return a placement for a single card, so there\'s nothing to write — ' +
          'no flow was created. This is almost always a one-off; sorting again usually fixes it.',
        );
      }
      let flowId: string;
      let data: StoredFlowData;
      let isNewFlow = false;

      if (ctx.kind === 'existing') {
        flowId = ctx.flowId;
        const fresh: StoredFlowData | null = await readKey(`flow_data_${flowId}`);
        if (!fresh) throw new Error('That flow no longer exists.');
        data = fresh;
      } else {
        flowId = crypto.randomUUID();
        data = makeDefaultData(ctx.event, ctx.variant, ctx.pfOrder);
        isNewFlow = true;
      }

      const columns = data.customColumns ?? columnsForEvent(data.event, data.pfOrder);
      const sheets: SheetData[] = data.sheets.map((s) => ({
        ...s, cells: { ...s.cells },
        arrows: s.arrows ? [...s.arrows] : undefined,
        aiCells: s.aiCells ? [...s.aiCells] : undefined,
      }));
      // Keyed by ALIAS, not literal name, so "Midterms" written by the 2NC lands
      // on the "Midterms DA" tab the 2AC made instead of starting a second one.
      // See sheetAliasKey — only the position-TYPE suffix is dropped, so the
      // aff's "Economy" and the neg's "Econ DA" still get their own tabs.
      const sheetIndexByName = new Map<string, number>();
      sheets.forEach((s, i) => sheetIndexByName.set(sheetAliasKey(s.name), i));

      const skipped: SkippedPlacement[] = [];
      let written = 0;
      // Where each written card landed, keyed by its tag — so a card that answers
      // another can align to it and/or draw an arrow back.
      const placedByTag = new Map<string, { sheetIdx: number; ri: number; ci: number }>();
      // AI-summarized cards' text, grouped by the sheet they landed on — folded
      // into that sheet's `aiSummary` once writing is done, for the tab hover
      // tooltip. Reuses the summaries already generated above; no extra AI call.
      // The COLUMN is kept with each one so the fold can keep only the speech
      // that introduced the position, matching what a hover-generated summary
      // reads (see lib/flowTabSummary.ts).
      const summariesBySheet = new Map<number, { ci: number; text: string }[]>();
      // Every cell write, in the order it happened. A new flow replays this into
      // an empty copy of the finished layout so the user watches the flow fill
      // in; an existing flow ignores it and takes the finished sheets directly.
      const writeLog: { sheetIdx: number; cellKey: string; html: string }[] = [];

      // Need a sheet that doesn't exist? MAKE one. It is never a rename of some
      // unused default tab ("Off 3" → "Fism DA").
      //
      // The old behavior hunted for an empty placeholder and renamed it, which
      // quietly repurposed a slot the user might have been holding, and made tab
      // ORDER depend on which placeholder happened to be free rather than on the
      // order positions actually came up in the document. Appending, then
      // dropping the leftover defaults at the very end (see the cleanup pass
      // below), reaches the same layout with neither problem. See
      // src/lib/flowSheetNaming.ts for the shared rule.
      const ensureSheet = (name: string): number => {
        const key = sheetAliasKey(name);
        let idx = sheetIndexByName.get(key);
        if (idx === undefined) {
          sheets.push({ id: crypto.randomUUID(), name, cells: {} });
          idx = sheets.length - 1;
          sheetIndexByName.set(key, idx);
        }
        return idx;
      };
      const writeCard = (sheetIdx: number, ri: number, ci: number, p: Placement) => {
        const cellKey = `${ri}-${ci}`;
        // Stamp the tab as Auto Flow's work. Its presence is what makes the tab
        // eligible for an AI hover summary at all, and its value picks which
        // speech column that summary reads. First non-null role wins — a tab is
        // one position, so a later card disagreeing is noise, not a reclassify.
        const sh = sheets[sheetIdx];
        if (sh.autoFlowRole === undefined || (sh.autoFlowRole === null && p.sheetRole)) {
          sh.autoFlowRole = p.sheetRole ?? null;
        }
        // Recorded in placement order so a live run can replay the same writes,
        // one at a time, into an initially-empty copy of these sheets.
        writeLog.push({ sheetIdx, cellKey, html: buildCellHtml(p.tag, p.cite, p.summary) });
        sheets[sheetIdx].cells[cellKey] = buildCellHtml(p.tag, p.cite, p.summary);
        if (p.summary && p.summary.trim()) {
          const ai = sheets[sheetIdx].aiCells ?? [];
          ai.push(cellKey);
          sheets[sheetIdx].aiCells = ai;
          const list = summariesBySheet.get(sheetIdx) ?? [];
          list.push({ ci, text: p.summary.trim() });
          summariesBySheet.set(sheetIdx, list);
        }
        placedByTag.set(normTag(p.tag), { sheetIdx, ri, ci });
        written++;
      };
      const addArrow = (sheetIdx: number, from: string, to: string) => {
        const arrows = sheets[sheetIdx].arrows ?? [];
        arrows.push({ id: crypto.randomUUID(), from, to });
        sheets[sheetIdx].arrows = arrows;
      };

      // Tab-ORDER pre-pass — advantages first, in 1AC order, then off-case.
      //
      // The AI returns placements in document (1AC) order and tags each with a
      // sheetRole, so the distinct new 'advantage' sheets in first-appearance
      // order ARE the aff's advantages 1..N. Creating all of those before any of
      // the off-case ones is what puts advantage tabs to the left of off-case
      // tabs, in the order they came up in the 1AC.
      //
      // This runs as its own pass rather than letting Pass 1 create sheets
      // incidentally: Pass 1 walks `accepted` in document order too, so it would
      // usually produce the same order, but "usually" isn't a guarantee — a doc
      // that opens with an off-case card would invert it. Ordering the tabs is a
      // deliberate decision, so it gets a deliberate pass.
      const createNewSheetsForRole = (role: 'advantage' | 'offcase') => {
        for (const p of accepted) {
          if (!p.isNewSheet || p.sheetRole !== role) continue;
          const name = p.sheetName.trim();
          if (!name || sheetIndexByName.has(sheetAliasKey(name))) continue;
          ensureSheet(name);
        }
      };
      createNewSheetsForRole('advantage');
      createNewSheetsForRole('offcase');

      // Pass 0 — the plan text (policy) always goes to the very first cell of the
      // very first sheet, regardless of what column/sheet the AI proposed for it.
      // Falls back to the first empty row of column 0 if 0-0 is already taken
      // (adding into an existing flow that already has a plan there).
      const planCard = accepted.find((p) => p.isPlan);
      if (planCard && sheets.length > 0) {
        const c0Empty = !((sheets[0].cells['0-0'] ?? '').trim());
        const ri = c0Empty ? 0 : firstEmptyRow(sheets[0].cells, 0, NUM_ROWS);
        if (ri !== -1) writeCard(0, ri, 0, planCard);
        else skipped.push({ tag: planCard.tag, sheetName: sheets[0].name, column: columns[0] ?? '1AC', reason: 'first column is full' });
      }

      // Pass 1 — every card that does NOT answer another card (originals). Placed
      // first so their positions are known when Pass 2 aligns answers to them.
      for (const p of accepted) {
        if (p.isPlan || p.respondsTo) continue;
        const sheetIdx = ensureSheet(p.sheetName);
        const colIdx = findColumnIndex(columns, p.column);
        if (colIdx === -1) { skipped.push({ tag: p.tag, sheetName: p.sheetName, column: p.column, reason: 'column not found' }); continue; }
        const row = firstEmptyRow(sheets[sheetIdx].cells, colIdx, NUM_ROWS);
        if (row === -1) { skipped.push({ tag: p.tag, sheetName: p.sheetName, column: p.column, reason: 'column is full' }); continue; }
        writeCard(sheetIdx, row, colIdx, p);
      }

      // Pass 2 — answering cards. Try to sit an answer on the SAME ROW as the
      // card it answers (so they line up like a paper flow). When that row is
      // already taken (e.g. a second card answering the same one), it drops to
      // the next empty row and an arrow is drawn from the answered card to it, so
      // the connection stays visible. Only same-sheet answers can align/arrow —
      // arrow endpoints are cell keys within one sheet.
      //
      // Worklist, not a single loop: a response can itself be answered by a LATER
      // response (1NC turn → 2AC answer → 1NR extension), and the AI's output
      // order isn't guaranteed to keep that chain in doc order. Repeatedly write
      // whichever remaining cards already have their target placed, so multi-
      // level chains still resolve regardless of list order; only genuinely
      // unresolvable cards (dangling/cyclic respondsTo) fall through unaligned.
      let remaining = accepted.filter((p) => !p.isPlan && !!p.respondsTo);
      while (remaining.length > 0) {
        const stillRemaining: Placement[] = [];
        let progressed = false;
        for (const p of remaining) {
          const sheetIdx = ensureSheet(p.sheetName);
          const colIdx = findColumnIndex(columns, p.column);
          if (colIdx === -1) { skipped.push({ tag: p.tag, sheetName: p.sheetName, column: p.column, reason: 'column not found' }); progressed = true; continue; }

          const answered = resolveRespondsTo(p.respondsTo!, placedByTag);
          if (!answered) { stillRemaining.push(p); continue; }

          const cells = sheets[sheetIdx].cells;
          if (answered.sheetIdx === sheetIdx && answered.ci !== colIdx && !((cells[`${answered.ri}-${colIdx}`] ?? '').trim())) {
            writeCard(sheetIdx, answered.ri, colIdx, p); // same row, adjacency IS the link — no arrow
          } else {
            const row = firstEmptyRow(cells, colIdx, NUM_ROWS);
            if (row === -1) { skipped.push({ tag: p.tag, sheetName: p.sheetName, column: p.column, reason: 'column is full' }); progressed = true; continue; }
            writeCard(sheetIdx, row, colIdx, p);
            if (answered.sheetIdx === sheetIdx) addArrow(sheetIdx, `${answered.ri}-${answered.ci}`, `${row}-${colIdx}`);
          }
          progressed = true;
        }
        if (!progressed) {
          // Nothing left resolved this round — the rest never will (target not in
          // this batch, or a cycle). Write them plainly so they still land.
          for (const p of stillRemaining) {
            const sheetIdx = ensureSheet(p.sheetName);
            const colIdx = findColumnIndex(columns, p.column);
            if (colIdx === -1) { skipped.push({ tag: p.tag, sheetName: p.sheetName, column: p.column, reason: 'column not found' }); continue; }
            const row = firstEmptyRow(sheets[sheetIdx].cells, colIdx, NUM_ROWS);
            if (row === -1) { skipped.push({ tag: p.tag, sheetName: p.sheetName, column: p.column, reason: 'column is full' }); continue; }
            writeCard(sheetIdx, row, colIdx, p);
          }
          break;
        }
        remaining = stillRemaining;
      }

      // Fold each sheet's AI card summaries into a short tab-hover blurb — reuses
      // text already generated above, no extra AI call. Joins up to 3, truncated.
      //
      // Only the cards in the speech that INTRODUCED the position count: the
      // 1AC for an advantage, the 1NC for an off-case. A tab also holds the
      // answers to that position, and folding those in described the argument's
      // whole history rather than the argument. Same rule the hover-generated
      // summary follows, so the two can't disagree about what a tab is.
      for (const [sheetIdx, list] of summariesBySheet) {
        const col = summaryColumnFor(sheets[sheetIdx].autoFlowRole, columns, data.event);
        const kept = list.filter((s) => col === null || s.ci === col);
        // An unclassified tab, or one whose introducing speech had no summarized
        // card, gets no blurb rather than a misleading one built from answers.
        if (kept.length === 0) continue;
        const joined = kept.slice(0, 3).map((s) => s.text).join(' · ');
        sheets[sheetIdx].aiSummary = joined.length > 160 ? joined.slice(0, 159) + '…' : joined;
      }

      // Cleanup — the second half of "always create, never rename". Now that all
      // the writing is done, drop the default tabs nothing landed on: the unused
      // "Off 3"/"Off 4" slots, a 2-advantage doc's spare "Adv 3", any blank
      // "Sheet 2" sitting around. Only sheets that are BOTH still default-named
      // and completely empty go; a real name is always kept, even when blank,
      // because an empty "Politics DA" tab is telling you the position existed
      // but nothing landed on it. See src/lib/flowSheetNaming.ts.
      //
      // This runs for an existing flow too, not just a new one. Under the old
      // rename-a-placeholder scheme it couldn't — the user's spare slots were
      // theirs. Now that positions are appended instead, leaving them would mean
      // every run stacks named tabs after a row of dead defaults. Nothing is
      // lost: a sheet has to be literally empty to qualify.
      // Every card was rejected during placement (unknown column, full column).
      // Same rule as above: a flow with nothing in it is not a result.
      if (written === 0) {
        const why = skipped[0]?.reason ? ` Every card was skipped — first reason: "${skipped[0].reason}".` : '';
        throw new Error(`None of the ${accepted.length} sorted cards could be placed, so no flow was created.${why}`);
      }

      const finalSheets = pruneUnnamedEmptySheets(sheets);

      if (isNewFlow && ctx.kind === 'new') {
        // Named after the AFF being read — that's how a debater refers to a
        // round ("the Single Payer round"), whichever side they were on. Warroom
        // AI reads it off the 1AC (rule 7 of the classify prompt). When the docs
        // give no usable read on the aff it returns null rather than guessing,
        // and the fallback is today's date — a file name like
        // "AFF---Single Payer---FINAL-v3" is a worse label than "8/20/26".
        const aiName = (nameIn ?? aiFlowName ?? '').trim();
        const dateName = new Date().toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' });
        const meta: FlowMeta = {
          id: flowId,
          name: aiName || dateName,
          event: 'policy',
          createdAt: new Date().toISOString(),
        };
        const newIndex = [...flowsIndex, meta];
        setFlowsIndex(newIndex);
        await writeKey('flows_index', newIndex);
      }

      if (live) {
        // Put the (still empty) flow on screen first, then fill it in front of
        // the user. Everything below writes through the SAME storage key the
        // open FlowView reads, so each persist + event is a frame of animation.
        const empty: StoredFlowData = {
          ...data,
          sheets: sheets.map((s) => ({ ...s, cells: {}, arrows: [], aiCells: [] })),
          activeSheetIdx: 0,
        };
        await writeKey(`flow_data_${flowId}`, empty);
        setView({ kind: 'flow', flowId });
        setStep('live');
        skipLive.current = false;
        await replayIntoFlow(flowId, empty, sheets, finalSheets, writeLog, skipLive);
      } else {
        const updated: StoredFlowData = { ...data, sheets: finalSheets };
        await writeKey(`flow_data_${flowId}`, updated);
      }

      setWriteSummary({ written, skipped });
      // Navigate either way — the point of the run is the flow. Only close on a
      // clean run: anything the user should know about (rejected cards OR cards
      // the parser couldn't split) keeps the wizard up to say so.
      setView({ kind: 'flow', flowId });
      if (skipped.length === 0 && !(notes && notes.unresolved > 0)) onClose();
      else setStep('done');
    } catch (e: any) {
      setError(e?.message || 'Failed to write into the flow.');
      // A new-flow run has no meaningful review screen to fall back to (the
      // placement list may be empty, which is often the failure itself), so send
      // the user to the target step — the "Sort with Warroom AI" button is there
      // and re-running is the fix for nearly everything that lands here.
      setStep(live ? 'target' : 'review');
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const totalCards = docs.reduce((n, d) => n + d.cards.length, 0);

  // Shown on BOTH the review step and the done step. It used to exist only on
  // review — which a new flow skips entirely — and the wizard then closed itself
  // whenever no card had been outright rejected. So a run that dumped 16 cards
  // onto one generic "OFF" tab reported nothing at all: the user was left in a
  // flow that looked sorted, with no way to know a sixth of it wasn't.
  const parserWarning = parserNotes && (parserNotes.unresolved > 0 || parserNotes.skipped > 0) ? (
    <div className="text-[11px] rounded-sm p-2.5 leading-relaxed"
      style={{ color: 'rgb(var(--warn-rgb))', background: 'rgba(var(--warn-rgb), 0.08)', border: '1px solid rgba(var(--warn-rgb), 0.25)' }}>
      {parserNotes.unresolved > 0 && (
        <>
          <strong>{parserNotes.unresolved} card{parserNotes.unresolved === 1 ? '' : 's'}</strong>{' '}
          couldn't be split into positions — these documents label those blocks with a
          generic header, so the parser has nothing to separate them by:
          <ul className="mt-1.5 mb-1.5 ml-3 list-disc space-y-0.5">
            {parserNotes.docs.map((d, i) => (
              <li key={i}>
                <strong>{d.count}</strong> card{d.count === 1 ? '' : 's'} in {d.fileName} — all under
                {' '}"{d.sheetName}"
              </li>
            ))}
          </ul>
          Re-running those docs with Warroom AI reads the taglines and splits them.{' '}
        </>
      )}
      {parserNotes.skipped > 0 && (
        <>
          <strong>{parserNotes.skipped}</strong> had no recognisable speech and were left out.
        </>
      )}
    </div>
  ) : null;

  return (
    <div
      className={live
        ? 'fixed bottom-4 right-4 z-50'
        : 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6'}
      onClick={(step === 'writing' || live) ? undefined : onClose}
    >
      <div
        className={live
          ? 'glass-elevated rounded-md shadow-xl flex flex-col'
          : 'glass-elevated rounded-md w-full max-w-2xl max-h-[88vh] flex flex-col shadow-xl'}
        style={live ? { width: 300 } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-line flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-base font-semibold">Auto Flow — sort speech docs into a flow</h2>
            <p className="text-xs text-ink/40">{stepLabel(step)}</p>
          </div>
          {!live && <button className="text-ink/40 hover:text-ink text-lg leading-none" onClick={onClose}>✕</button>}
        </div>

        <div className={live ? 'p-3' : 'flex-1 overflow-y-auto scroll-thin p-5'}>
          {error && (
            <div className="mb-3 border border-danger/30 rounded-sm bg-danger/5 p-2.5 text-sm text-danger">{error}</div>
          )}

          {/* STEP: upload */}
          {step === 'upload' && (
            <div className="space-y-4">
              <p className="text-sm text-ink/60">
                Upload one or more speech docs (<code>.docx</code>). Warroom AI reads only the tags,
                cites, and heading structure — never the card bodies — and sorts each card into the
                right column and sheet of a flow.
              </p>
              <div
                className="flex flex-col items-center justify-center p-10 text-center border-2 rounded-sm cursor-pointer transition"
                style={{
                  borderStyle: 'dashed',
                  borderColor: dragActive ? 'var(--accent)' : 'var(--border-med)',
                  background: dragActive ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
                }}
                onClick={pickFiles}
                {...dragHandlers}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDragActive(false);
                  const files = Array.from(e.dataTransfer.files);
                  if (files.length === 0) return;
                  const paths = resolveDroppedFiles(files, ['docx']);
                  if (paths.length > 0) { await extractAll(paths); return; }
                  setError('Those files could not be opened — Auto Flow only reads .docx speech docs.');
                }}
              >
                <div className="text-sm font-medium text-ink/60 mb-2">
                  {dragActive ? 'Drop to add' : 'Drop speech docs here (.docx)'}
                </div>
                <div className="text-xs text-ink/40">drop several at once, or click to open the file picker</div>
              </div>
            </div>
          )}

          {/* STEP: extracting */}
          {step === 'extracting' && (
            <div className="py-14">
              <LoadingState messages={[
                'Reading the speech docs…',
                'Pulling tags, cites, and headings…',
                'Never reading card bodies…',
              ]} />
            </div>
          )}

          {/* STEP: target */}
          {step === 'target' && (
            <div className="space-y-4">
              <div className="rounded-sm border border-line divide-y divide-line">
                {docs.map((d) => (
                  <div key={d.fileName} className="px-3 py-2 flex items-center justify-between text-xs">
                    <span className="truncate text-ink/80">{d.fileName}</span>
                    {d.cards.length > 0 ? (
                      <span className="text-ink/45">{d.cards.length} card{d.cards.length === 1 ? '' : 's'}</span>
                    ) : (
                      <span className="text-danger/70">{d.error || 'No cards found'}</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-xs text-ink/45">{totalCards} card{totalCards === 1 ? '' : 's'} total across {docs.length} file{docs.length === 1 ? '' : 's'}.</p>

              <div className="space-y-2">
                <label className="label">Where should these go?</label>
                <div className="flex gap-2">
                  <button
                    className={`btn text-sm flex-1 ${targetMode === 'new' ? 'btn-primary' : ''}`}
                    onClick={() => setTargetMode('new')}
                  >
                    Create a new flow
                  </button>
                  <button
                    className={`btn text-sm flex-1 ${targetMode === 'existing' ? 'btn-primary' : ''}`}
                    onClick={() => setTargetMode('existing')}
                    disabled={flowsIndex.length === 0}
                    title={flowsIndex.length === 0 ? 'You have no existing flows yet' : ''}
                  >
                    Add to an existing flow
                  </button>
                </div>
              </div>

              {targetMode === 'new' && newEvent === 'pf' && (
                <div className="space-y-3 rounded-sm border border-line p-3">
                  <div className="space-y-1.5">
                    <label className="text-xs text-ink/55 font-medium">Speech order</label>
                    <div className="flex gap-2">
                      <button className={`btn text-xs flex-1 ${newPfOrder === 'pro-first' ? 'btn-primary' : ''}`} onClick={() => setNewPfOrder('pro-first')}>Pro first</button>
                      <button className={`btn text-xs flex-1 ${newPfOrder === 'con-first' ? 'btn-primary' : ''}`} onClick={() => setNewPfOrder('con-first')}>Con first</button>
                    </div>
                  </div>
                </div>
              )}
              {/* Policy sheet layout (Stock issues vs. Advantage) has no UI — Warroom AI
                  guesses it from the doc's hat/block structure (inferVariantFromHats,
                  run at extract time) and the classify step's own read of the cards.
                  newVariant/variantInferred stay wired, just not surfaced here. */}

              {targetMode === 'existing' && (
                <div className="space-y-1.5">
                  <label className="text-xs text-ink/55 font-medium">Flow</label>
                  <select
                    className="input w-full text-sm"
                    value={selectedFlowId}
                    onChange={(e) => setSelectedFlowId(e.target.value)}
                  >
                    <option value="">Choose a flow…</option>
                    {flowsIndex.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Which engine sorts the cards. Lives here rather than in Settings
                  because it is a per-document decision — a clean Verbatim doc
                  parses perfectly, a doc that hats everything "OFF" needs the
                  model — and the choice sticks between runs. */}
              <div className="rounded-sm border border-line p-3">
                <div className="text-xs font-medium text-ink/80 mb-0.5">How should the cards be sorted?</div>
                <p className="text-[11px] text-ink/45 mb-2.5">
                  Your choice is remembered for next time.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { id: 'parser' as const, title: 'Read the document', sub: 'Instant · no API call',
                      body: 'Uses the doc\u2019s own headings \u2014 the speech gives the column, the position gives the tab. No length limit, however big the file.' },
                    { id: 'ai' as const, title: 'Warroom AI', sub: 'Slower · costs a call',
                      body: 'Reads the taglines. Needed when a doc labels every off\u2011case block the same thing, so the headings don\u2019t say what the positions are.' },
                  ]).map((opt) => {
                    const on = engine === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        title={opt.title}
                        onClick={() => setEngine(opt.id)}
                        className={`text-left rounded-sm p-2.5 transition ${opt.id === 'ai' ? 'ai-glow-ring' : ''}`}
                        style={{
                          background: on ? 'var(--nav-active-bg)' : 'transparent',
                          border: `1px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'}`,
                          cursor: 'pointer',
                        }}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="shrink-0 rounded-full" style={{
                            width: 10, height: 10,
                            border: `2px solid ${on ? 'var(--accent)' : 'var(--border-med)'}`,
                            background: on ? 'var(--accent)' : 'transparent',
                            boxShadow: on ? 'inset 0 0 0 1.5px var(--bg-elevated)' : 'none',
                          }} />
                          <span className="text-xs font-medium text-ink/85">{opt.title}</span>
                        </div>
                        <div className="text-[10px] text-ink/40 mt-0.5 pl-[16px]">{opt.sub}</div>
                        <p className="text-[11px] text-ink/50 mt-1.5 leading-relaxed">{opt.body}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Opt-in AI summary mode. The ai-glow-ring marks it as an AI action
                  — it adds a Warroom AI call and reads card bodies. A real switch
                  (not a plain checkbox) so the on/off state reads unambiguously.
                  Hidden in parser mode: it is itself a Warroom AI call, and the
                  point of that mode is not making one. */}
              {engine === 'ai' && (
              <div className="ai-glow-ring flex items-start gap-3 rounded-sm border border-line p-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={summarize}
                  onClick={() => setSummarize((v) => !v)}
                  className="relative shrink-0 mt-0.5 transition"
                  style={{
                    width: 34, height: 19, borderRadius: 999,
                    background: summarize ? 'var(--accent)' : 'var(--bg-elevated)',
                    border: '1px solid var(--border-med)',
                  }}
                >
                  <span
                    className="absolute rounded-full transition"
                    style={{
                      top: 1, left: summarize ? 16 : 1,
                      width: 15, height: 15,
                      background: '#fff',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.35)',
                    }}
                  />
                </button>
                <button type="button" className="text-left flex-1 cursor-pointer" onClick={() => setSummarize((v) => !v)}>
                  <div className="text-xs font-medium text-ink/80">Summarize each card with Warroom AI</div>
                  <div className="text-[11px] text-ink/45 mt-0.5 leading-snug">
                    Writes a short AI summary of each card — built from its tagline <em>and</em> its evidence, always
                    shorter than the tagline — instead of the tagline + cite. Reads card bodies and takes an extra
                    moment. Off by default; summarized cells show an AI ring.
                  </div>
                </button>
              </div>
              )}
            </div>
          )}

          {/* STEP: classifying */}
          {step === 'classifying' && pendingQuestion && (
            <div className="py-6">
              <AIQuestionPrompt question={pendingQuestion} onAnswer={answerQuestion} busy={answering} />
            </div>
          )}
          {step === 'classifying' && !pendingQuestion && (
            <div className="py-10 mx-auto" style={{ maxWidth: 420 }}>
              {/*
                A determinate bar with the real numbers, not a spinner. The old
                spinner said "Matching pockets to columns…" for minutes with no
                indication of whether anything was happening, how much was left,
                or that a long run is normal — which is indistinguishable from
                being hung. Every line here is a fact, not a mood.
              */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-ink/80">{stageTitle}</span>
                  <span className="text-ink/50 tabular-nums">{stagePct === null ? '' : `${Math.round(stagePct)}%`}</span>
                </div>
                <ProgressBar pct={stagePct ?? undefined} />
                <div className="flex items-center justify-between text-[11px] text-ink/50">
                  <span className="leading-relaxed">{stageDetail}</span>
                  <span className="tabular-nums shrink-0 pl-3">{formatElapsed(elapsed)}</span>
                </div>
              </div>

              <ol className="mt-5 space-y-1.5">
                {STAGES.map((st) => {
                  const state = stageIndex === st.i ? 'now' : stageIndex > st.i ? 'done' : 'todo';
                  return (
                    <li key={st.i} className="flex items-start gap-2 text-[11px]">
                      {/* Done, current, and not-yet must be tellable apart at a
                          glance — a filled dot for both done and current made
                          the checklist say nothing about where the run is. */}
                      <span
                        className="shrink-0 mt-[2px] flex items-center justify-center"
                        style={{ width: 9, height: 9 }}
                      >
                        {state === 'done' ? (
                          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                            <path d="M1.5 5.2l2.2 2.2L8.5 2.6" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : (
                          <span
                            className="rounded-full"
                            style={{
                              width: state === 'now' ? 8 : 6,
                              height: state === 'now' ? 8 : 6,
                              background: state === 'now' ? 'var(--accent)' : 'transparent',
                              border: state === 'now' ? 'none' : '1.5px solid var(--border-med)',
                            }}
                          />
                        )}
                      </span>
                      <span style={{ color: state === 'todo' ? 'var(--nav-inactive-color)' : 'rgb(var(--ink-rgb))', opacity: state === 'todo' ? 0.6 : 1 }}>
                        <span className={state === 'now' ? 'font-medium' : ''}>{st.label}</span>
                        <span className="text-ink/40"> — {st.what}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>

              <p className="mt-4 text-[11px] text-ink/40 leading-relaxed">
                Sorting a full case packet can take a few minutes — each batch is a separate request
                to Warroom AI. Nothing is written to a flow until every card has been sorted.
              </p>
            </div>
          )}

          {/* STEP: review */}
          {step === 'review' && (
            <div className="space-y-3">
              <p className="text-xs text-ink/50">
                Review where each card will land. Uncheck any you don't want, then confirm.
              </p>
              {parserWarning}

              {classifyStats && (
                <p className="text-[11px] text-ink/45">
                  {classifyStats.placed.toLocaleString()} of {classifyStats.cardsIn.toLocaleString()} cards sorted
                  {classifyStats.batches > 1 ? ` across ${classifyStats.batches} batches` : ''}
                  {classifyStats.batches === 0 ? ' straight from the document — no AI call' : ''}
                  {classifyStats.dropped > 0 && (
                    <span className="text-danger"> · {classifyStats.dropped} returned incomplete and were dropped</span>
                  )}
                  {classifyStats.placed < classifyStats.cardsIn - classifyStats.dropped && (
                    <span className="text-danger">
                      {' '}· {(classifyStats.cardsIn - classifyStats.dropped - classifyStats.placed).toLocaleString()} didn't come back —
                      cancel and sort again to retry them
                    </span>
                  )}
                </p>
              )}
              {groupBySheet(placements).map(([sheetName, isNewSheet, items]) => (
                <div key={sheetName} className="rounded-sm border border-line">
                  <div className="px-3 py-1.5 flex items-center gap-2 border-b border-line" style={{ background: 'var(--bg-elevated)' }}>
                    <span className="text-xs font-medium text-ink/75">{sheetName}</span>
                    {isNewSheet && <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>NEW</span>}
                  </div>
                  <div className="divide-y divide-line">
                    {items.map((p) => (
                      <label key={p.id} className="flex items-start gap-2 px-3 py-2 text-xs cursor-pointer">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={!p.removed}
                          onChange={() => toggleRemoved(p.id)}
                        />
                        <span className={`flex-1 ${p.removed ? 'opacity-40 line-through' : ''}`}>
                          {p.summary ? (
                            <>
                              {/* AI summary replaces the tag+cite in the cell. No ring
                                  here — per CLAUDE.md, AI-generated taglines (including
                                  this opt-in summary standing in for one) never get the
                                  ring, only the toggle that turns summarization on does. */}
                              <span className="inline-block rounded-sm px-1.5 py-0.5 text-ink/85">{truncate(p.summary, 90)}</span>
                              <span className="block text-ink/35 mt-1 italic">was: {truncate(p.tag, 70)}</span>
                            </>
                          ) : (
                            <span className="text-ink/80">{truncate(p.tag, 90)}</span>
                          )}
                          <span className="block text-ink/40 mt-0.5">{p.sheetName} → {p.column}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              {placements.length === 0 && (
                <div className="py-8 text-center space-y-3">
                  <p className="text-sm text-ink/60">Warroom AI didn't place any of these cards.</p>
                  <p className="text-xs text-ink/45 max-w-md mx-auto">
                    Every card came back unusable — usually a one-off model hiccup rather than
                    anything wrong with your docs. Sorting again normally fixes it.
                  </p>
                  <button className="ai-glow-ring btn-primary text-sm" onClick={() => setStep('target')}>
                    Back to sort again
                  </button>
                </div>
              )}
            </div>
          )}

          {/* STEP: writing */}
          {step === 'live' && (
            <div className="space-y-2">
              <p className="text-xs text-ink/60">
                Flowing your docs in. The tabs switch as Warroom AI moves between positions —
                everything is already saved as it lands.
              </p>
            </div>
          )}

          {step === 'writing' && (
            <div className="py-14">
              <LoadingState messages={['Writing cards into the flow…']} />
            </div>
          )}

          {/* STEP: done (only reached when some placements didn't fit) */}
          {step === 'done' && writeSummary && (
            <div className="space-y-3">
              <p className="text-sm text-ink/70">
                Wrote {writeSummary.written} card{writeSummary.written === 1 ? '' : 's'} into the flow.
                {writeSummary.skipped.length > 0
                  ? ` ${writeSummary.skipped.length} didn't fit and were skipped:`
                  : ''}
              </p>
              {parserWarning}
              {writeSummary.skipped.length > 0 && (
                <div className="rounded-sm border border-line divide-y divide-line">
                  {writeSummary.skipped.map((s, i) => (
                    <div key={i} className="px-3 py-2 text-xs">
                      <span className="text-ink/75">{truncate(s.tag, 90)}</span>
                      <span className="block text-ink/40 mt-0.5">{s.sheetName} → {s.column} — {s.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={live
          ? 'px-3 pb-3 flex items-center gap-2 shrink-0'
          : 'px-5 py-3 border-t border-line flex items-center gap-2 shrink-0'}>
          {live && (
            <button
              className="btn text-xs ml-auto"
              title="Jump to the finished flow"
              onClick={() => { skipLive.current = true; }}
            >
              Skip animation
            </button>
          )}
          {step === 'upload' && (
            <button className="btn text-sm ml-auto" onClick={onClose}>Cancel</button>
          )}
          {step === 'target' && (
            <>
              <button
                className={`btn-primary text-sm ${engine === 'ai' ? 'ai-glow-ring' : ''}`}
                title={engine === 'ai' ? 'Sort with Warroom AI' : 'Sort from the document'}
                disabled={totalCards === 0 || (targetMode === 'existing' && !selectedFlowId)}
                onClick={confirmTarget}
              >
                {engine === 'ai' ? 'Sort with Warroom AI →' : 'Sort from the document →'}
              </button>
              <button className="btn text-sm ml-auto" onClick={onClose}>Cancel</button>
            </>
          )}
          {step === 'review' && (
            <>
              <button className="btn-primary text-sm" disabled={acceptedCount === 0} onClick={() => commitWrite()}>
                Write {acceptedCount} card{acceptedCount === 1 ? '' : 's'} to the flow
              </button>
              <button className="btn text-sm ml-auto" onClick={onClose}>Cancel</button>
            </>
          )}
          {step === 'done' && (
            <button className="btn-primary text-sm ml-auto" onClick={onClose}>Done</button>
          )}
          {(step === 'extracting' || step === 'classifying') && !pendingQuestion && (
            <button className="btn text-sm ml-auto" onClick={onClose}>Cancel</button>
          )}
        </div>
      </div>
    </div>
  );
}

function stepLabel(step: Step): string {
  switch (step) {
    case 'upload': return 'Step 1 — upload speech docs';
    case 'extracting': return 'Reading the docs…';
    case 'target': return 'Step 2 — choose the destination flow';
    case 'classifying': return 'Sorting…';
    case 'review': return 'Step 3 — review placements, then write';
    case 'writing': return 'Writing…';
    case 'live': return 'Flowing it in front of you…';
    case 'done': return 'Done';
  }
}

function formatElapsed(secs: number): string {
  const m = Math.floor(secs / 60);
  const sec = secs % 60;
  return m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Groups placements by destination sheet for the review step, preserving first-
// seen order so new sheets appear where the AI first introduced them rather than
// jumping around.
function groupBySheet(placements: Placement[]): [string, boolean, Placement[]][] {
  const order: string[] = [];
  const groups = new Map<string, { isNew: boolean; items: Placement[] }>();
  for (const p of placements) {
    if (!groups.has(p.sheetName)) {
      groups.set(p.sheetName, { isNew: p.isNewSheet, items: [] });
      order.push(p.sheetName);
    }
    groups.get(p.sheetName)!.items.push(p);
  }
  return order.map((name) => {
    const g = groups.get(name)!;
    return [name, g.isNew, g.items] as [string, boolean, Placement[]];
  });
}
