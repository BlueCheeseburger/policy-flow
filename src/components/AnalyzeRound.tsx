import React, { useEffect, useMemo, useState } from 'react';
import type { SheetData } from './FlowView';
import type { AIClarification, AIQuestion } from '../types';
import AIQuestionPrompt from './AIQuestionPrompt';
import { LoadingState } from './Spinner';
import { humanizeGeminiError } from '../utils/geminiError';
import { htmlToText } from '../lib/cellHtml';
import { useDragActive } from '../hooks/useDragActive';
import ProgressBar from './ProgressBar';
import { readKey, writeKey } from '../platform/storage';
import { openFiles, resolveDroppedFiles, fileNameOf } from '../platform/files';
import { extractText } from '../platform/docx';
import { analyzeRound as runAnalyzeRound } from '../platform/aiFeatures';

type Step = 'setup' | 'analyzing' | 'question' | 'result';

// Same localStorage keys FlowView/Settings use for the user's actual aff/neg
// (or pro/con) column colors — read here too so the verdict banner and clash
// cards use the SAME colors the debater already sees on their flow, rather than
// a hardcoded pair that could clash with a customized palette.
const AFF_COLOR_KEY = 'warroom-flow-aff-color';
const NEG_COLOR_KEY = 'warroom-flow-neg-color';
const DEFAULT_AFF_COLOR = '#2563eb';
const DEFAULT_NEG_COLOR = '#16a34a';

interface Verdict { leading: 'A' | 'B' | 'even'; reason: string }
interface DroppedItem { side: 'A' | 'B'; argument: string; sheet: string }
interface ClashItem { topic: string; claimA: string | null; claimB: string | null; winner: 'A' | 'B' | 'even'; reasoning: string }
interface NextSpeechItem { action: string; why: string }
interface AnalysisResult {
  sideALabel: string;
  sideBLabel: string;
  verdict: Verdict;
  dropped: DroppedItem[];
  clashes: ClashItem[];
  nextSpeech: NextSpeechItem[];
}

interface UploadedDoc {
  fileName: string;
  text: string;
}

// Flattens the flow into a plain-text summary an LLM can reason about clash
// across speeches with: for each sheet, for each column (speech, in the flow's
// own left-to-right order), every non-empty cell in row order. See
// DEBATE_DOC_STRUCTURE.md / CLAUDE.md for why cell HTML has to go through
// htmlToText rather than being sent raw.
function buildFlowSummary(sheets: SheetData[], columns: string[]): string {
  const lines: string[] = [];
  for (const sheet of sheets) {
    lines.push(`=== Sheet: ${sheet.name} ===`);
    for (let ci = 0; ci < columns.length; ci++) {
      const col = columns[ci];
      const entries = Object.entries(sheet.cells || {})
        .map(([key, html]) => {
          const [riStr, ciStr] = key.split('-');
          return { ri: Number(riStr), ci: Number(ciStr), text: htmlToText(String(html ?? '')).trim() };
        })
        .filter((e) => e.ci === ci && e.text)
        .sort((a, b) => a.ri - b.ri);
      if (entries.length === 0) {
        lines.push(`[${col}] (empty)`);
      } else {
        for (const e of entries) lines.push(`[${col}] ${e.text}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

// Local copy of the shared AI-emphasis renderer — every AI-output panel in this
// codebase defines its own (no shared component exists yet). Parses **bold**,
// *italic*, __underline__, `code` per the CLAUDE.md "always support emphasis" rule.
function RichText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*(.+?)\*\*|__(.+?)__|`(.+?)`|\*(.+?)\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const full = match[0];
    if (full.startsWith('**')) parts.push(<strong key={key++}>{match[2]}</strong>);
    else if (full.startsWith('__')) parts.push(<u key={key++}>{match[3]}</u>);
    else if (full.startsWith('`')) parts.push(<code key={key++} style={{ fontFamily: 'monospace', fontSize: '0.9em', background: 'var(--bg-hover)', borderRadius: 3, padding: '1px 4px' }}>{match[4]}</code>);
    else parts.push(<em key={key++}>{match[5]}</em>);
    last = match.index + full.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

// ── Card UI — deliberately styled to match Impact Calc's result view
// (ImpactCalcView.tsx: verdict banner, side colors, clash cards with claims
// side-by-side and a winner badge) rather than a wall of prose. ──────────────

function Tag({ children, color, bg }: { children: React.ReactNode; color?: string; bg?: string }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, borderRadius: 4, padding: '2px 7px',
      color: color ?? 'var(--nav-inactive-color)',
      background: bg ?? 'var(--bg-hover)',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function SectionHeader({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--nav-inactive-color)', textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 12 }}>
      {children} {count !== undefined && <span style={{ fontWeight: 400, opacity: 0.6 }}>({count})</span>}
    </div>
  );
}

function DroppedCard({ item, sideLabel, sideColor }: { item: DroppedItem; sideLabel: string; sideColor: string }) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
      borderRadius: 8, padding: '10px 12px', marginBottom: 8, borderLeft: `3px solid ${sideColor}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <Tag color={sideColor} bg={`${sideColor}18`}>{sideLabel}</Tag>
        {item.sheet && <Tag>{item.sheet}</Tag>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink)', lineHeight: 1.5 }}>
        <RichText text={item.argument} />
      </div>
    </div>
  );
}

function ClashCard({ clash, labelA, labelB, colorA, colorB }: {
  clash: ClashItem; labelA: string; labelB: string; colorA: string; colorB: string;
}) {
  const wc = clash.winner === 'A' ? colorA : clash.winner === 'B' ? colorB : 'var(--nav-inactive-color)';
  const winnerName = clash.winner === 'A' ? labelA : clash.winner === 'B' ? labelB : 'Even';

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '14px 16px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: wc, background: `${wc}15`, borderRadius: 5, padding: '3px 9px' }}>
          {clash.winner === 'even' ? 'Even' : `${winnerName} ahead`}
        </span>
        <Tag>{clash.topic}</Tag>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 28px 1fr', gap: 8, alignItems: 'start', marginBottom: 12 }}>
        <div style={{ background: 'var(--bg-main)', borderRadius: 6, padding: '8px 10px', border: `1px solid ${clash.winner === 'A' ? colorA + '40' : 'var(--border-subtle)'}` }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: colorA, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{labelA}</div>
          <div style={{ fontSize: 11, color: 'var(--ink)', lineHeight: 1.4 }}>
            {clash.claimA ? <RichText text={clash.claimA} /> : <span style={{ color: 'var(--nav-inactive-color)', fontStyle: 'italic' }}>Never addressed</span>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--nav-inactive-color)', fontSize: 11, fontWeight: 600, paddingTop: 20 }}>vs</div>
        <div style={{ background: 'var(--bg-main)', borderRadius: 6, padding: '8px 10px', border: `1px solid ${clash.winner === 'B' ? colorB + '40' : 'var(--border-subtle)'}` }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: colorB, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{labelB}</div>
          <div style={{ fontSize: 11, color: 'var(--ink)', lineHeight: 1.4 }}>
            {clash.claimB ? <RichText text={clash.claimB} /> : <span style={{ color: 'var(--nav-inactive-color)', fontStyle: 'italic' }}>Never addressed</span>}
          </div>
        </div>
      </div>
      {clash.reasoning && (
        <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--ink)', borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
          <RichText text={clash.reasoning} />
        </div>
      )}
    </div>
  );
}

function NextSpeechCard({ item, index }: { item: NextSpeechItem; index: number }) {
  return (
    <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
      <div style={{
        flexShrink: 0, width: 20, height: 20, borderRadius: '50%', background: 'var(--nav-active-bg)',
        color: 'var(--nav-active-color)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {index + 1}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', lineHeight: 1.4, marginBottom: 2 }}>
          <RichText text={item.action} />
        </div>
        {item.why && (
          <div style={{ fontSize: 11.5, color: 'var(--nav-inactive-color)', lineHeight: 1.5 }}>
            <RichText text={item.why} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function AnalyzeRound({
  sheets, columns, event, flowId, onClose,
}: {
  sheets: SheetData[];
  columns: string[];
  event: 'policy' | 'pf';
  flowId?: string;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>('setup');
  // Set only when a long flow is read across several passes, so a run that
  // takes minutes says which pass it is on instead of spinning silently.
  const [passProgress, setPassProgress] = useState<{ pass: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState('');
  const [docs, setDocs] = useState<UploadedDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const { dragActive, setDragActive, dragHandlers } = useDragActive();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [pendingQuestion, setPendingQuestion] = useState<AIQuestion | null>(null);
  const [clarifications, setClarifications] = useState<AIClarification[]>([]);
  const [answering, setAnswering] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [ready, setReady] = useState(false);

  const affColor = useMemo(() => localStorage.getItem(AFF_COLOR_KEY) || DEFAULT_AFF_COLOR, []);
  const negColor = useMemo(() => localStorage.getItem(NEG_COLOR_KEY) || DEFAULT_NEG_COLOR, []);

  const flowSummary = useMemo(() => buildFlowSummary(sheets, columns), [sheets, columns]);

  // Load a cached analysis for this flow, if one exists, so it's never lost by
  // just closing the panel. Keyed per-flow so switching flows doesn't show a
  // stale result from a different round. Gated behind `ready` rather than
  // defaulting straight to the 'setup' step, so there's no flash of the setup
  // screen before a cached result swaps in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!flowId) { setReady(true); return; }
      try {
        const cached = await readKey(`analyze_round_${flowId}`);
        if (cancelled) return;
        if (cached?.result?.verdict) {
          setAnalysis(cached.result);
          setCachedAt(typeof cached.savedAt === 'number' ? cached.savedAt : null);
          setStep('result');
        }
      } catch { /* no cache, or unreadable — just start fresh */ }
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, [flowId]);

  async function addDocs(paths: string[]) {
    if (!paths.length) return;
    setDocsLoading(true);
    setError('');
    try {
      for (const p of paths) {
        const res = await extractText(p);
        setDocs((prev) => [...prev, { fileName: fileNameOf(p), text: res.full }]);
      }
    } catch (e: any) {
      setError(e?.message || 'Could not read one of those documents.');
    } finally {
      setDocsLoading(false);
    }
  }

  async function pickDocs() {
    const paths = await openFiles(['docx']);
    if (paths.length) await addDocs(paths);
  }

  function removeDoc(fileName: string) {
    setDocs((prev) => prev.filter((d) => d.fileName !== fileName));
  }

  async function runAnalyze(clars: AIClarification[]) {
    setPendingQuestion(null);
    setStep('analyzing');
    setError('');
    setPassProgress(null);
    try {
      const res = await runAnalyzeRound({
        flowSummary, notes, docs, event, clarifications: clars,
        onPass: (pass, total) => setPassProgress({ pass, total }),
      });
      if (res?.question) {
        setPendingQuestion(res.question);
        setStep('question');
        return;
      }
      if (!res.verdict) throw new Error('The model did not return an analysis.');
      const result: AnalysisResult = {
        sideALabel: res.sideALabel ?? 'Aff', sideBLabel: res.sideBLabel ?? 'Neg',
        verdict: res.verdict, dropped: res.dropped ?? [], clashes: res.clashes ?? [], nextSpeech: res.nextSpeech ?? [],
      };
      setAnalysis(result);
      setClarifications([]);
      setStep('result');
      const savedAt = Date.now();
      setCachedAt(savedAt);
      if (flowId) writeKey(`analyze_round_${flowId}`, { result, notes, savedAt });
    } catch (e: any) {
      setError(humanizeGeminiError(e?.message) || e?.message || 'Could not analyze the round.');
      setStep('setup');
    }
  }

  async function answerQuestion(answer: string) {
    if (!pendingQuestion || answering) return;
    setAnswering(true);
    const next = [...clarifications, { question: pendingQuestion.question, answer }];
    setClarifications(next);
    await runAnalyze(next);
    setAnswering(false);
  }

  // "New analysis" — a genuinely fresh start, not just a re-run: clears the
  // notes/docs too, and drops the cached result so reopening the panel later
  // doesn't bring back what this just discarded.
  function startNewAnalysis() {
    setAnalysis(null);
    setClarifications([]);
    setPendingQuestion(null);
    setError('');
    setNotes('');
    setDocs([]);
    setCachedAt(null);
    setStep('setup');
    if (flowId) writeKey(`analyze_round_${flowId}`, null);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div className="glass-elevated rounded-md w-full max-w-2xl max-h-[88vh] flex flex-col shadow-xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-3 border-b border-line flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-base font-semibold">Analyze this round</h2>
            <p className="text-xs text-ink/40">{stepLabel(step)}</p>
          </div>
          <button className="text-ink/40 hover:text-ink text-lg leading-none" onClick={onClose}>✕</button>
        </div>

        <div className="flex-1 overflow-y-auto scroll-thin p-5">
          {!ready && (
            <div className="py-14">
              <LoadingState messages={['Checking for a saved analysis…']} />
            </div>
          )}

          {ready && error && (
            <div className="mb-3 border border-danger/30 rounded-sm bg-danger/5 p-2.5 text-sm text-danger">{error}</div>
          )}

          {/* STEP: setup */}
          {ready && step === 'setup' && (
            <div className="space-y-4">
              <div>
                <button
                  className="text-xs text-ink/50 hover:text-ink/80 underline decoration-dotted"
                  onClick={() => setShowSummary((v) => !v)}
                >
                  {showSummary ? 'Hide' : 'Preview'} what's being read from your flow
                </button>
                {showSummary && (
                  <pre className="mt-2 text-[11px] leading-relaxed text-ink/60 rounded-sm border border-line p-2.5 max-h-40 overflow-y-auto scroll-thin whitespace-pre-wrap">
                    {flowSummary || '(flow is empty)'}
                  </pre>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-ink/55 font-medium">Additional context for the model</label>
                <textarea
                  className="input w-full text-sm" rows={3}
                  placeholder="e.g. I'm Neg, this is round 4, I think we're ahead on the DA but losing case — anything else not already on the flow"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-ink/55 font-medium">Supplementary docs <span className="text-ink/35 font-normal">(optional)</span></label>
                </div>
                <div
                  className="flex flex-col items-center justify-center py-5 text-center border-2 rounded-sm cursor-pointer transition"
                  style={{
                    borderStyle: 'dashed',
                    borderColor: dragActive ? 'var(--accent)' : 'var(--border-med)',
                    background: dragActive ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
                  }}
                  onClick={pickDocs}
                  {...dragHandlers}
                  onDrop={async (e) => {
                    e.preventDefault();
                    setDragActive(false);
                    const files = Array.from(e.dataTransfer.files);
                    if (files.length === 0) return;
                    const paths = resolveDroppedFiles(files, ['docx']);
                    if (paths.length > 0) await addDocs(paths);
                    else setError('Those files could not be opened — supplementary docs must be .docx.');
                  }}
                >
                  {docsLoading ? (
                    <div className="w-full max-w-[220px] space-y-1.5">
                      <div className="text-xs font-medium text-ink/60">Reading…</div>
                      <ProgressBar />
                    </div>
                  ) : (
                    <>
                      <div className="text-xs font-medium text-ink/60">
                        {dragActive ? 'Drop to add' : 'Drop case docs / blocks here (.docx)'}
                      </div>
                      <div className="text-[11px] text-ink/40 mt-0.5">or click to choose files — several at once is fine</div>
                    </>
                  )}
                </div>
                {docs.length > 0 && (
                  <div className="space-y-1">
                    {docs.map((d) => (
                      <div key={d.fileName} className="flex items-center justify-between text-xs rounded-sm border border-line px-2 py-1">
                        <span className="truncate text-ink/70">{d.fileName}</span>
                        <button className="text-ink/40 hover:text-danger px-1" onClick={() => removeDoc(d.fileName)} title="Remove">✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* STEP: analyzing */}
          {step === 'analyzing' && (
            <div className="py-14">
              {passProgress && (
                <p className="text-center text-xs mb-3" style={{ color: 'var(--label-color)' }}>
                  Reading part {passProgress.pass} of {passProgress.total} — the whole flow, nothing skipped.
                </p>
              )}
              <LoadingState messages={[
                'Reading your flow…',
                'Checking what got dropped…',
                'Weighing who is ahead on each clash…',
                'Drafting suggestions for your next speech…',
              ]} />
            </div>
          )}

          {/* STEP: question */}
          {step === 'question' && pendingQuestion && (
            <div className="py-6">
              <AIQuestionPrompt question={pendingQuestion} onAnswer={answerQuestion} busy={answering} />
            </div>
          )}

          {/* STEP: result */}
          {step === 'result' && analysis && (
            <div>
              {cachedAt && (
                <p className="text-[11px] text-ink/40 mb-3">
                  Saved analysis from {new Date(cachedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} —
                  your flow may have changed since then. <button className="underline decoration-dotted hover:text-ink/70" onClick={startNewAnalysis}>Run a new one</button>.
                </p>
              )}
              {/* Verdict banner */}
              {(() => {
                const vc = analysis.verdict.leading === 'A' ? affColor : analysis.verdict.leading === 'B' ? negColor : 'var(--nav-inactive-color)';
                const vName = analysis.verdict.leading === 'A' ? analysis.sideALabel : analysis.verdict.leading === 'B' ? analysis.sideBLabel : null;
                return (
                  <div style={{
                    background: analysis.verdict.leading === 'A' ? `${affColor}12` : analysis.verdict.leading === 'B' ? `${negColor}12` : 'var(--bg-card)',
                    border: `1.5px solid ${vc}40`, borderRadius: 12, padding: '18px 20px', marginBottom: 24,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
                      <span style={{ fontSize: 20, fontWeight: 800, color: vc, letterSpacing: '-0.02em' }}>
                        {vName ? `${vName} ahead` : 'Even'}
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: vc, opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        right now
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.6 }}>
                      <RichText text={analysis.verdict.reason} />
                    </div>
                  </div>
                );
              })()}

              {/* Dropped / conceded */}
              {analysis.dropped.length > 0 && (
                <section className="mb-6">
                  <SectionHeader count={analysis.dropped.length}>Dropped &amp; Conceded</SectionHeader>
                  {analysis.dropped.map((d, i) => (
                    <DroppedCard
                      key={i} item={d}
                      sideLabel={d.side === 'A' ? analysis.sideALabel : analysis.sideBLabel}
                      sideColor={d.side === 'A' ? affColor : negColor}
                    />
                  ))}
                </section>
              )}

              {/* Live clashes */}
              {analysis.clashes.length > 0 && (
                <section className="mb-6">
                  <SectionHeader count={analysis.clashes.length}>Live Clashes</SectionHeader>
                  {analysis.clashes.map((c, i) => (
                    <ClashCard key={i} clash={c} labelA={analysis.sideALabel} labelB={analysis.sideBLabel} colorA={affColor} colorB={negColor} />
                  ))}
                </section>
              )}

              {/* Next speech */}
              {analysis.nextSpeech.length > 0 && (
                <section>
                  <SectionHeader>For Your Next Speech</SectionHeader>
                  {analysis.nextSpeech.map((n, i) => <NextSpeechCard key={i} item={n} index={i} />)}
                </section>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-line flex items-center gap-2 shrink-0">
          {!ready && (
            <button className="btn text-sm ml-auto" onClick={onClose}>Cancel</button>
          )}
          {ready && step === 'setup' && (
            <>
              <button className="ai-glow-ring btn-primary text-sm" onClick={() => runAnalyze(clarifications)}>Analyze round →</button>
              <button className="btn text-sm ml-auto" onClick={onClose}>Cancel</button>
            </>
          )}
          {(step === 'analyzing' || step === 'question') && (
            <button className="btn text-sm ml-auto" onClick={onClose}>Cancel</button>
          )}
          {step === 'result' && (
            <>
              <button className="btn text-sm" onClick={startNewAnalysis}>New analysis</button>
              <button className="btn-primary text-sm ml-auto" onClick={onClose}>Done</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function stepLabel(step: Step): string {
  switch (step) {
    case 'setup': return 'Give the model context, then analyze';
    case 'analyzing': return 'Analyzing…';
    case 'question': return 'One quick question';
    case 'result': return 'Strategic read of the round';
  }
}
