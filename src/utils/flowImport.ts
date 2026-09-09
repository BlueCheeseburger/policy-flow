import * as XLSX from 'xlsx';
import { makeDefaultData, POLICY_COLS, PF_PRO_FIRST_COLS, PF_CON_FIRST_COLS, NUM_ROWS } from '../components/FlowView';
import { readFileBytes, fileNameOf } from '../platform/files';
import { callAI, renderPrompt, parseJsonLoose } from '../platform/ai';
import { aiConfigured } from '../platform/settings';
import { capForPrompt } from '../platform/longInputGate';
import { htmlToText } from '../lib/cellHtml';

type StoredFlowData = ReturnType<typeof makeDefaultData>;
type FlowEvent = 'policy' | 'pf';

interface ParsedSheet {
  name: string;
  cells: Record<string, string>;
}

// ── Header recognition ────────────────────────────────────────────────────────
// Normalize a header token: lowercase, strip everything but a-z0-9.
function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Policy speech synonyms → target column index in POLICY_COLS
// POLICY_COLS = ['1AC','1NC','2AC','2NC/1NR','1AR','2NR','2AR']  (2NC + 1NR merge into idx 3)
const POLICY_HEADER_MAP: Record<string, number> = {
  '1ac': 0, 'ac1': 0, 'affconstructive': 0, '1affirmative': 0,
  '1nc': 1, 'nc1': 1, 'negconstructive': 1,
  '2ac': 2, 'ac2': 2,
  '2nc1nr': 3, '2nc': 3, '1nr': 3, 'block': 3, 'negblock': 3, 'theblock': 3, 'nc2': 3, 'nr1': 3,
  '1ar': 4, 'ar1': 4,
  '2nr': 5, 'nr2': 5,
  '2ar': 6, 'ar2': 6,
};

// PF speech synonyms → { side, phase } so we can resolve against either column order.
// phase order: case(0), rebuttal(1), summary(2), finalfocus(3)
const PF_PHASE: Record<string, number> = {
  case: 0, constructive: 0,
  rebuttal: 1, reb: 1,
  summary: 2, sum: 2,
  ff: 3, finalfocus: 3, final: 3, grandcrossfire: 3,
};

function pfSideAndPhase(token: string): { side: 'pro' | 'con'; phase: number } | null {
  const t = norm(token);
  const side: 'pro' | 'con' | null = t.startsWith('pro') ? 'pro' : (t.startsWith('con') ? 'con' : null);
  if (!side) return null;
  const rest = t.slice(3);
  for (const key of Object.keys(PF_PHASE)) {
    if (rest.includes(key)) return { side, phase: PF_PHASE[key] };
  }
  return null;
}

// Resolve a (side, phase) pair to a column index for a given PF order.
function pfColIndex(cols: string[], side: 'pro' | 'con', phase: number): number {
  // cols labels look like "Pro Case", "Con Rebuttal", "Pro FF", etc.
  const wantSide = side;
  const phaseToken = ['case', 'rebuttal', 'summary', 'ff'][phase];
  for (let i = 0; i < cols.length; i++) {
    const n = norm(cols[i]);
    const colSide = n.startsWith('pro') ? 'pro' : (n.startsWith('con') ? 'con' : null);
    if (colSide !== wantSide) continue;
    const rest = n.slice(3);
    if (phaseToken === 'ff' ? (rest.includes('ff') || rest.includes('final')) : rest.includes(phaseToken)) return i;
  }
  return -1;
}

interface HeaderMatch {
  map: Map<number, number>; // source col index → target col index
  score: number;
  event: FlowEvent;
}

function matchPolicyHeader(row: string[]): HeaderMatch {
  const map = new Map<number, number>();
  let score = 0;
  row.forEach((cell, ci) => {
    const key = norm(cell);
    if (key && key in POLICY_HEADER_MAP) {
      map.set(ci, POLICY_HEADER_MAP[key]);
      score++;
    }
  });
  return { map, score, event: 'policy' };
}

function matchPFHeader(row: string[]): HeaderMatch {
  // Always map onto the canonical pro-first layout — that's how the flow is
  // built (makeDefaultData(..., 'pro-first')) and how the AI fallback emits PF,
  // so source column order doesn't matter, only the side+phase of each header.
  const map = new Map<number, number>();
  let score = 0;
  row.forEach((cell, ci) => {
    const sp = pfSideAndPhase(cell);
    if (!sp) return;
    const tgt = pfColIndex(PF_PRO_FIRST_COLS, sp.side, sp.phase);
    if (tgt >= 0) { map.set(ci, tgt); score++; }
  });
  return { map, score, event: 'pf' };
}

// Scan the first few rows for the best-matching header. Returns null if nothing recognizable.
function detectHeader(aoa: string[][]): { headerRowIdx: number; match: HeaderMatch } | null {
  const limit = Math.min(aoa.length, 8);
  let best: { headerRowIdx: number; match: HeaderMatch } | null = null;
  for (let r = 0; r < limit; r++) {
    const row = aoa[r] ?? [];
    if (!row.some((c) => String(c ?? '').trim())) continue;
    const candidates = [matchPolicyHeader(row), matchPFHeader(row)];
    for (const m of candidates) {
      if (!best || m.score > best.match.score) best = { headerRowIdx: r, match: m };
    }
  }
  // Require at least 2 recognized speech columns to call it confident.
  if (best && best.match.score >= 2) return best;
  return null;
}

// ── Cell extraction (algorithmic path) ────────────────────────────────────────
function buildCells(aoa: string[][], headerRowIdx: number, map: Map<number, number>): Record<string, string> {
  const cells: Record<string, string> = {};
  const dataRows = aoa.slice(headerRowIdx + 1);
  dataRows.forEach((srcRow, ri) => {
    if (ri >= NUM_ROWS) return;
    map.forEach((tgtCi, srcCi) => {
      const v = String(srcRow[srcCi] ?? '').replace(/\r\n/g, '\n').trim();
      if (!v) return;
      const key = `${ri}-${tgtCi}`;
      cells[key] = cells[key] ? `${cells[key]}\n${v}` : v;
    });
  });
  return cells;
}

// Convert AI-returned rows (already aligned to target columns) → cells map.
function rowsToCells(rows: string[][]): Record<string, string> {
  const cells: Record<string, string> = {};
  rows.forEach((row, ri) => {
    if (ri >= NUM_ROWS) return;
    row.forEach((v, ci) => {
      const val = String(v ?? '').replace(/\r\n/g, '\n').trim();
      if (val) cells[`${ri}-${ci}`] = val;
    });
  });
  return cells;
}

// ── Main entry ────────────────────────────────────────────────────────────────
export async function importFlowFromXlsx(base64: string): Promise<StoredFlowData> {
  const wb = XLSX.read(base64, { type: 'base64' });
  if (!wb.SheetNames.length) throw new Error('The spreadsheet has no sheets.');

  const parsed: ParsedSheet[] = [];
  const needsAI: { name: string; grid: string[][] }[] = [];
  const eventVotes: Record<FlowEvent, number> = { policy: 0, pf: 0 };

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const aoa = (XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, defval: '' }) as unknown[][])
      .map((row) => (row ?? []).map((c) => String(c ?? '')));

    // Empty sheet → keep an empty placeholder so sheet structure is preserved.
    if (!aoa.some((row) => row.some((c) => c.trim()))) {
      parsed.push({ name: sheetName, cells: {} });
      continue;
    }

    const detected = detectHeader(aoa);
    if (detected) {
      eventVotes[detected.match.event]++;
      parsed.push({ name: sheetName, cells: buildCells(aoa, detected.headerRowIdx, detected.match.map) });
    } else {
      // Can't confidently parse — hand the raw grid to the AI fallback.
      needsAI.push({ name: sheetName, grid: aoa.slice(0, NUM_ROWS + 5) });
      parsed.push({ name: sheetName, cells: {} }); // placeholder, filled in after AI
    }
  }

  let event: FlowEvent = eventVotes.pf > eventVotes.policy ? 'pf' : 'policy';

  // Sheets whose header row wasn't recognizable fall back to the model, which
  // reads the raw grid and says which column is which speech. That step needs a
  // key; without one the algorithmic result stands on its own, and only a
  // spreadsheet where NOTHING parsed is a hard failure.
  if (needsAI.length) {
    let aiError = aiConfigured() ? '' : 'no API key is set, so the unrecognized sheets were skipped';
    if (aiConfigured()) {
      try {
        const blocks: string[] = [];
        for (const sh of needsAI) {
          // Capped, but only after asking — a silently halved grid would drop
          // most of the sheet and the import would look merely incomplete.
          const json = await capForPrompt(JSON.stringify(sh.grid.slice(0, 60)), 12_000, `the "${sh.name}" sheet`);
          blocks.push(`SHEET "${sh.name}":\n${json}`);
        }
        const raw = await callAI(
          renderPrompt('flow_import', {
            EVENT_INSTRUCTION: 'This app is policy only. Use the policy schema for every sheet.',
            SHEET_BLOCKS: blocks.join('\n\n'),
          }),
          'balanced',
          { maxOutputTokens: 32768 },
        );
        const res = parseJsonLoose(raw);
        const aiSheets: { name: string; rows: string[][] }[] = Array.isArray(res?.sheets) ? res.sheets : [];
        if (!aiSheets.length) throw new Error('the model returned no sheets');
        if (res.event === 'pf' || res.event === 'policy') event = res.event;
        const byName = new Map(aiSheets.map((s) => [s.name, s.rows] as const));
        // Match AI output to the sheets we sent — by name first, then
        // positionally (the reply corresponds 1:1, in order, with `needsAI`).
        needsAI.forEach((sent, i) => {
          const rows = byName.get(sent.name) ?? aiSheets[i]?.rows;
          if (!rows) return;
          const target = parsed.find((p) => p.name === sent.name);
          if (target) target.cells = rowsToCells(rows);
        });
      } catch (e: any) {
        aiError = e?.message || 'the model could not read them';
      }
    }
    if (aiError && eventVotes.policy + eventVotes.pf === 0) {
      // Nothing parsed on its own AND the fallback didn't help — give up rather
      // than importing a blank flow that looks like the file was empty.
      throw new Error(`Could not read the spreadsheet (${aiError}).`);
    }
  }

  const data = makeDefaultData(event, 'stock-issues', 'pro-first');
  data.sheets = parsed.map((p) => ({ id: crypto.randomUUID(), name: p.name.slice(0, 40), cells: p.cells }));
  return data;
}

/**
 * Read a .xlsx file off disk (by path) and parse it into flow data, plus a
 * display name derived from the filename. Shared by the single-file importer
 * (Sidebar) and the bulk onboarding importer so both go through one code path.
 */
/**
 * Serialize stored flow data (the same shape written to `flow_data_{id}`) to
 * an .xlsx base64 string, without needing a live FlowView instance mounted.
 * Mirrors FlowView's own `buildXlsxBase64`, which wraps this with its
 * in-memory (not-yet-flushed-to-storage) state — kept as one implementation
 * so the two never drift. Used directly by Team Files' "add from your
 * flows" / auto-sync path, where the flow usually isn't open in an editor.
 */
export function flowDataToXlsxBase64(data: StoredFlowData): string {
  const flowEvent: FlowEvent = data.event === 'pf' ? 'pf' : 'policy';
  const baseCols = flowEvent === 'policy'
    ? POLICY_COLS
    : (data.pfOrder === 'pro-first' ? PF_PRO_FIRST_COLS : PF_CON_FIRST_COLS);
  const cols = data.customColumns ?? baseCols;
  const wb = XLSX.utils.book_new();

  for (const sheet of data.sheets) {
    const aoa: string[][] = [cols];
    for (let ri = 0; ri < NUM_ROWS; ri++) {
      const row = cols.map((_, ci) => htmlToText(sheet.cells[`${ri}-${ci}`] ?? ''));
      if (row.some((v) => v.trim() !== '')) aoa.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = cols.map((_, ci) => ({
      wch: Math.min(60, Math.max(12, ...aoa.map((row) => (row[ci] ?? '').length))),
    }));
    const safeName = sheet.name.replace(/[\\/:*?[\]]/g, '_').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, safeName);
  }

  return XLSX.write(wb, { bookType: 'xlsx', type: 'base64' }) as string;
}

export async function importFlowFile(handle: string): Promise<{ name: string; data: StoredFlowData }> {
  const res = await readFileBytes(handle);
  if (!res.ok || !res.base64) throw new Error(res.error || 'Could not read the file.');
  const data = await importFlowFromXlsx(res.base64);
  const name = fileNameOf(handle).replace(/\.xlsx$/i, '');
  return { name, data };
}
