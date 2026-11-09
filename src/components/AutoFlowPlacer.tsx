import { useEffect, useMemo, useState } from 'react';
import type { SheetData } from './FlowView';
import { NUM_ROWS, MAX_ROWS } from './FlowView';
import { readFlow, writeFlow, type FlowSnapshot } from '../lib/flowBridge';
import { isSheetEmpty } from '../lib/flowSheetNaming';
import { placeRows, nextFreeRow } from '../lib/flowPlace';
import { findColumnIndex } from '../lib/autoFlowPlacement';
import { sheetAliasKey } from '../lib/autoFlowParse';
import type { OutlineContext } from '../lib/autoFlowStructured';

// Auto Flow's last step for the cards the parser couldn't sort: each one is
// shown with the pocket, hat and block it sat under, and the user picks where
// it goes on a small copy of the flow: an empty cell, or the line between two
// cells to slot it in there. Every placement is written straight into the
// flow (already open behind this dialog), so nothing waits on a final save.

export interface PendingCard {
  id: string;
  fileName: string;
  tag: string;
  cite: string;
  /** The cell's HTML, built the same way as every other Auto Flow row. */
  html: string;
  context: OutlineContext;
  /** Rows under the same heading instance share this. */
  group: string;
  /** Best guess at a tab (a tagline the block opened with), or null. */
  suggestedSheet: string | null;
  /** The speech column, when the doc said which speech it is. */
  column: string | null;
  sheetRole: 'advantage' | 'offcase' | null;
  /** Why the parser couldn't place it, in a few words. */
  why: string;
}

type Target = {
  /** A sheet id, or 'new' for a tab that doesn't exist yet. */
  sheet: string;
  newName: string;
  ci: number;
  ri: number;
  mode: 'cell' | 'insert';
};

const cellText = (html: string) => html
  .replace(/<br\s*\/?>/gi, ' · ')
  .replace(/<\/(div|p)>/gi, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

const filled = (cells: Record<string, string>, r: number, c: number) => !!(cells[`${r}-${c}`] ?? '').trim();

export default function AutoFlowPlacer({ flowId, columns, cards, pruneEmpty, onFinish }: {
  flowId: string;
  columns: string[];
  cards: PendingCard[];
  /** Drop every tab left empty when done (a new flow the parser made). */
  pruneEmpty: boolean;
  onFinish: () => void;
}) {
  const [data, setData] = useState<FlowSnapshot | null>(null);
  const [idx, setIdx] = useState(0);
  const [placed, setPlaced] = useState(0);
  const [left, setLeft] = useState(0);
  const [target, setTarget] = useState<Target | null>(null);
  const [last, setLast] = useState<{ group: string; sheet: string; ci: number; row: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const card = cards[idx] as PendingCard | undefined;

  // The rest of this card's block, from here on: what "Place all" places.
  const groupSize = useMemo(() => {
    if (!card) return 0;
    let n = 0;
    while (idx + n < cards.length && cards[idx + n].group === card.group) n++;
    return n;
  }, [cards, idx, card]);
  const groupTotal = useMemo(() => (card ? cards.filter((c) => c.group === card.group).length : 0), [cards, card]);
  const groupPos = groupTotal - groupSize + 1;

  useEffect(() => {
    let alive = true;
    void readFlow(flowId).then((d) => { if (alive) setData(d); });
    return () => { alive = false; };
  }, [flowId]);

  async function finish() {
    if (pruneEmpty) {
      try {
        const d = await readFlow(flowId);
        const kept = d?.sheets.filter((sh) => !isSheetEmpty(sh)) ?? [];
        if (d && kept.length && kept.length < d.sheets.length) {
          const activeId = d.sheets[d.activeSheetIdx ?? 0]?.id;
          await writeFlow(flowId, { ...d, sheets: kept, activeSheetIdx: Math.max(0, kept.findIndex((sh) => sh.id === activeId)) });
        }
      } catch { /* leaving an empty tab behind is harmless */ }
    }
    onFinish();
  }

  /** Make a tab now, so it's on the flow and in the row above before anything goes on it. */
  async function createTab(name: string) {
    const clean = name.trim().slice(0, 40);
    if (!clean || busy) return;
    setBusy(true);
    setError('');
    try {
      const d = await readFlow(flowId);
      if (!d) throw new Error('That flow is gone — it may have been deleted.');
      let sh = d.sheets.find((x) => sheetAliasKey(x.name) === sheetAliasKey(clean));
      let next = d;
      if (!sh) {
        sh = { id: crypto.randomUUID(), name: clean, cells: {}, autoFlowRole: card?.sheetRole ?? null };
        next = { ...d, sheets: [...d.sheets, sh], activeSheetIdx: d.sheets.length };
        await writeFlow(flowId, next);
      }
      const ci = target?.ci ?? 0;
      setData(next);
      setTarget({ sheet: sh.id, newName: '', ci, ri: nextFreeRow(sh.cells, ci), mode: 'cell' });
    } catch (e: any) {
      setError(e?.message || 'Could not make that tab.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteTab(id: string) {
    if (busy) return;
    const d = await readFlow(flowId);
    if (!d) return;
    const sh = d.sheets.find((x) => x.id === id);
    if (!sh) return;
    if (d.sheets.length <= 1) { setError('A flow needs at least one tab.'); return; }
    if (!isSheetEmpty(sh)) {
      const n = Object.values(sh.cells).filter((v) => (v ?? '').trim()).length;
      if (!window.confirm(`Delete "${sh.name}" and the ${n} cell${n === 1 ? '' : 's'} on it? ⌘Z in the flow brings it back.`)) return;
    }
    setBusy(true);
    setError('');
    try {
      const activeId = d.sheets[d.activeSheetIdx ?? 0]?.id;
      const sheets = d.sheets.filter((x) => x.id !== id);
      const next = { ...d, sheets, activeSheetIdx: Math.max(0, sheets.findIndex((x) => x.id === activeId)) };
      await writeFlow(flowId, next);
      setData(next);
      if (target?.sheet === id && card) setTarget(defaultTarget(next, card, columns, null));
    } catch (e: any) {
      setError(e?.message || 'Could not delete that tab.');
    } finally {
      setBusy(false);
    }
  }

  // A fresh default spot for each new card: right under the last one when it
  // came from the same block, else the end of its speech's column on the tab
  // its tagline suggests (a new tab when there isn't one).
  useEffect(() => {
    if (!data || !card) return;
    setTarget(defaultTarget(data, card, columns, last));
  }, [data, idx]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!card && cards.length) void finish(); }, [card]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!card) return null;

  const sheets: SheetData[] = data?.sheets ?? [];
  const sheet = target && target.sheet !== 'new' ? sheets.find((s) => s.id === target.sheet) ?? null : null;
  const cells = sheet?.cells ?? {};
  let lastRow = 0;
  for (const k of Object.keys(cells)) if ((cells[k] ?? '').trim()) lastRow = Math.max(lastRow, Number(k.split('-')[0]) + 1);
  const shownRows = Math.min(MAX_ROWS, Math.max(lastRow + 3, (target?.ri ?? 0) + 3, 8));

  async function place(n: number) {
    if (!target || busy) return;
    setBusy(true);
    setError('');
    try {
      const fresh = await readFlow(flowId);
      if (!fresh) throw new Error('That flow is gone — it may have been deleted.');
      const list = fresh.sheets.map((s) => ({ ...s }));
      let si = target.sheet === 'new' ? -1 : list.findIndex((s) => s.id === target.sheet);
      if (target.sheet === 'new') {
        const name = target.newName.trim() || 'Unsorted';
        si = list.findIndex((s) => sheetAliasKey(s.name) === sheetAliasKey(name));
        if (si === -1) {
          list.push({ id: crypto.randomUUID(), name, cells: {}, autoFlowRole: card!.sheetRole ?? null });
          si = list.length - 1;
        }
      }
      if (si === -1) throw new Error('That tab is gone — pick another.');
      const batch = cards.slice(idx, idx + n);
      const res = placeRows(list[si], target.ci, target.ri, target.mode, batch.map((c) => c.html));
      list[si] = res.sheet;
      const numRows = Math.max(fresh.numRows ?? NUM_ROWS, Math.min(MAX_ROWS, res.depth + 5));
      const next: FlowSnapshot = { sheets: list, numRows, activeSheetIdx: si };
      await writeFlow(flowId, next);
      setLast({ group: batch[batch.length - 1].group, sheet: list[si].id, ci: target.ci, row: res.rows[res.rows.length - 1] });
      setPlaced((v) => v + batch.length);
      setData(next);
      setIdx((v) => v + n);
    } catch (e: any) {
      setError(e?.message || 'Could not place that card.');
    } finally {
      setBusy(false);
    }
  }

  function leaveOut() {
    setLeft((v) => v + 1);
    setIdx((v) => v + 1);
  }

  const crumbs = ([['Pocket', card.context.pocket], ['Hat', card.context.hat], ['Block', card.context.block]] as const)
    .filter(([, t]) => !!t);
  const remaining = cards.length - idx;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="glass-elevated rounded-md w-full max-w-5xl max-h-[90vh] flex flex-col shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-line flex items-center justify-between shrink-0 gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Place the cards the parser couldn&rsquo;t sort</h2>
            <p className="text-xs text-ink/40">
              Card {idx + 1} of {cards.length}
              {placed > 0 && ` · ${placed} placed`}
              {left > 0 && ` · ${left} left out`}
            </p>
          </div>
          <div className="w-40 shrink-0"><Bar pct={(idx / cards.length) * 100} /></div>
        </div>

        <div className="flex-1 overflow-y-auto scroll-thin p-5 grid gap-5 md:grid-cols-[260px_minmax(0,1fr)]">
          {/* The card, and where it sat in its doc */}
          <div className="space-y-3 min-w-0">
            <div className="text-[11px] text-ink/40 truncate" title={card.fileName}>{card.fileName}</div>
            {crumbs.length > 0 && (
              <div className="space-y-1">
                {crumbs.map(([label, text], i) => (
                  <div key={label} className="flex items-baseline gap-2 text-xs" style={{ paddingLeft: i * 8 }}>
                    <span className="text-[9px] uppercase tracking-wider text-ink/35 w-10 shrink-0">{label}</span>
                    <span className="text-ink/70 break-words min-w-0">{text}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="rounded-sm border p-3 space-y-1" style={{ borderColor: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 6%, transparent)' }}>
              <div className="text-sm font-semibold text-ink/90 leading-snug break-words">{card.tag}</div>
              {card.cite && <div className="text-xs text-ink/55">{card.cite}</div>}
            </div>
            <div className="text-[11px] text-ink/45 leading-snug">{card.why}</div>
            {groupTotal > 1 && (
              <div className="text-[11px] text-ink/45">Card {groupPos} of {groupTotal} under this block.</div>
            )}
            {error && <div className="text-xs text-danger">{error}</div>}
          </div>

          {/* Where it goes */}
          <div className="space-y-3 min-w-0">
            <div className="flex items-center gap-1.5 overflow-x-auto scroll-thin pb-1">
              {sheets.map((s, i) => (
                <div
                  key={s.id}
                  className="flex items-center rounded-sm border whitespace-nowrap transition shrink-0"
                  style={target?.sheet === s.id
                    ? { borderColor: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--accent)' }
                    : { borderColor: 'var(--border-med)' }}
                >
                  <button
                    type="button"
                    className="text-xs pl-2.5 pr-1.5 py-1"
                    onClick={() => setTarget((t) => {
                      const ci = t?.ci ?? 0;
                      return { sheet: s.id, newName: t?.newName ?? '', ci, ri: nextFreeRow(s.cells, ci), mode: 'cell' };
                    })}
                  >
                    {s.name || `Tab ${i + 1}`}
                  </button>
                  <button
                    type="button"
                    className="text-ink/35 hover:text-danger pr-2 pl-0.5 py-1 text-xs leading-none"
                    aria-label={`Delete tab ${s.name || i + 1}`}
                    title={isSheetEmpty(s) ? 'Delete this tab' : 'Delete this tab and everything on it'}
                    disabled={busy || sheets.length <= 1}
                    onClick={() => void deleteTab(s.id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="text-xs px-2.5 py-1 rounded-sm border border-dashed whitespace-nowrap transition"
                style={target?.sheet === 'new'
                  ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                  : { borderColor: 'var(--border-med)' }}
                onClick={() => setTarget((t) => ({
                  sheet: 'new', newName: t?.newName || card.suggestedSheet || '', ci: t?.ci ?? 0, ri: 0, mode: 'cell',
                }))}
              >
                + New tab
              </button>
            </div>

            {target?.sheet === 'new' && (
              <form
                className="flex items-center gap-2 text-xs"
                onSubmit={(e) => { e.preventDefault(); void createTab(target.newName); }}
              >
                <span className="text-ink/50 shrink-0">New tab name</span>
                <input
                  className="input text-sm flex-1"
                  value={target.newName}
                  placeholder="e.g. Econ DA"
                  onChange={(e) => setTarget({ ...target, newName: e.target.value })}
                  autoFocus
                />
                <button type="submit" className="btn text-sm" disabled={busy || !target.newName.trim()}>
                  Create tab
                </button>
              </form>
            )}

            <p className="text-[11px] text-ink/45">
              Click an empty cell, or the line between two cells to slot it in there.
            </p>

            {/* The tab, small: every column, enough rows to see where things are */}
            <div className="overflow-x-auto scroll-thin rounded-sm border border-line">
              <div className="flex" style={{ minWidth: columns.length * 112 }}>
                {columns.map((col, ci) => (
                  <div key={ci} className="flex-1 min-w-[112px] border-r border-line last:border-r-0">
                    <div className="text-[10px] font-semibold text-ink/55 px-1.5 py-1 border-b border-line text-center truncate" style={{ background: 'var(--bg-elevated)' }}>
                      {col}
                    </div>
                    {Array.from({ length: shownRows }, (_, r) => {
                      const has = filled(cells, r, ci);
                      const isCell = target?.mode === 'cell' && target.ci === ci && target.ri === r;
                      const isGap = target?.mode === 'insert' && target.ci === ci && target.ri === r;
                      return (
                        <div key={r}>
                          {/* The line above row r: inserting here pushes r and below down */}
                          <button
                            type="button"
                            disabled={!has}
                            aria-label={`Insert above row ${r + 1} in ${col}`}
                            className={`block w-full ${has ? 'cursor-pointer group' : 'cursor-default'}`}
                            style={{ height: 7 }}
                            onClick={() => target && setTarget({ ...target, ci, ri: r, mode: 'insert' })}
                          >
                            {(has || isGap) && (
                              <span
                                className={`block mx-1 rounded-full transition ${isGap ? '' : 'opacity-0 group-hover:opacity-100'}`}
                                style={{
                                  height: isGap ? 3 : 2,
                                  background: isGap ? 'var(--accent)' : 'color-mix(in srgb, var(--accent) 55%, transparent)',
                                }}
                              />
                            )}
                          </button>
                          {isGap && <Ghost text={card.tag} />}
                          <button
                            type="button"
                            disabled={has}
                            className="block w-full text-left px-1.5 mx-0 rounded-[2px] transition"
                            style={{
                              height: 34,
                              fontSize: 10,
                              lineHeight: '13px',
                              cursor: has ? 'default' : 'pointer',
                              outline: isCell ? '2px solid var(--accent)' : undefined,
                              outlineOffset: -2,
                              background: isCell
                                ? 'color-mix(in srgb, var(--accent) 14%, transparent)'
                                : has ? 'var(--bg-elevated)' : 'transparent',
                            }}
                            title={has ? cellText(cells[`${r}-${ci}`]) : `Place in ${col}, row ${r + 1}`}
                            onClick={() => target && setTarget({ ...target, ci, ri: r, mode: 'cell' })}
                          >
                            <span className="line-clamp-2 overflow-hidden" style={{ color: isCell ? 'var(--accent)' : undefined }}>
                              {isCell ? card.tag : has ? cellText(cells[`${r}-${ci}`]) : ''}
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-line flex items-center gap-2 shrink-0 flex-wrap">
          <button className="btn-primary text-sm" disabled={!target || busy || (target.sheet === 'new' && !target.newName.trim())} onClick={() => place(1)}>
            {target?.sheet === 'new' && target.newName.trim()
              ? `Make "${truncName(target.newName)}" and place`
              : 'Place card'}
          </button>
          {groupSize > 1 && (
            <button className="btn text-sm" disabled={!target || busy || (target.sheet === 'new' && !target.newName.trim())} onClick={() => place(groupSize)}
              title="Places this card and the rest of its block in order, one under the other">
              Place {groupSize === groupTotal ? 'all' : 'the rest'} {groupSize} from this block
            </button>
          )}
          <button className="btn text-sm" disabled={busy} onClick={leaveOut}>Leave out</button>
          <button className="btn text-sm ml-auto" disabled={busy} onClick={() => void finish()}
            title={remaining > 1 ? `The other ${remaining} cards stay out of the flow` : 'This card stays out of the flow'}>
            {remaining > 1 ? `Leave the rest out` : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}

const truncName = (s: string) => (s.trim().length > 18 ? `${s.trim().slice(0, 17)}…` : s.trim());

function Ghost({ text }: { text: string }) {
  return (
    <div className="mx-0 px-1.5 rounded-[2px]" style={{
      height: 34, fontSize: 10, lineHeight: '13px', color: 'var(--accent)',
      outline: '2px dashed var(--accent)', outlineOffset: -2,
      background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
    }}>
      <span className="line-clamp-2 overflow-hidden">{text}</span>
    </div>
  );
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height: 4, background: 'var(--border-subtle)' }}>
      <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: 'var(--accent)', transition: 'width 0.2s ease' }} />
    </div>
  );
}

function defaultTarget(
  data: FlowSnapshot, card: PendingCard, columns: string[],
  last: { group: string; sheet: string; ci: number; row: number } | null,
): Target {
  const sheets = data.sheets;
  if (last && last.group === card.group && sheets.some((s) => s.id === last.sheet)) {
    const s = sheets.find((x) => x.id === last.sheet)!;
    const ri = last.row + 1;
    return { sheet: s.id, newName: '', ci: last.ci, ri, mode: filled(s.cells, ri, last.ci) ? 'insert' : 'cell' };
  }
  const colIdx = card.column ? findColumnIndex(columns, card.column) : -1;
  const ci = colIdx === -1 ? 0 : colIdx;
  if (card.suggestedSheet) {
    const key = sheetAliasKey(card.suggestedSheet);
    const s = sheets.find((x) => sheetAliasKey(x.name) === key);
    if (s) return { sheet: s.id, newName: '', ci, ri: nextFreeRow(s.cells, ci), mode: 'cell' };
    return { sheet: 'new', newName: card.suggestedSheet, ci, ri: 0, mode: 'cell' };
  }
  const s = sheets[Math.max(0, Math.min(data.activeSheetIdx ?? 0, sheets.length - 1))];
  return { sheet: s?.id ?? 'new', newName: '', ci, ri: s ? nextFreeRow(s.cells, ci) : 0, mode: 'cell' };
}
