// How a speech doc's structure looks once it's in a flow column. One set of
// rules, shared by Auto Flow's parse mode and by sends from CardMirror, so a
// block flows the same way whichever route it came in by:
//
//   Pocket  → not a row. It names the flow TAB (the off-case or advantage).
//   Hat     → double underlined, with one blank row between it and anything
//             above it, and one below it.
//   Block   → single underlined, no blank rows, indented one step under a hat.
//   Tag /   → indented one step per hat or block above it.
//   analytic
//
// Pure (strings in, strings out) so scripts/test-flow-row-style.ts can pin it.

import { escapeHtml } from './cellHtml';
import { DOUBLE_UNDERLINE_STYLE } from './cellStyleTokens';

export type RowKind = 'pocket' | 'hat' | 'block' | 'card' | 'analytic';

/** One indent step, in px. Small on purpose: flow columns are narrow. */
export const INDENT_PX = 8;

/** A row's content before layout: its kind and its already-built inner HTML. */
export interface FlowRow { kind: RowKind; html: string }

/** Wrap a heading's text in its style: double underline for a hat, single for a block. */
export function headingHtml(kind: 'hat' | 'block', text: string): string {
  const t = escapeHtml(text);
  return kind === 'hat' ? `<span style="${DOUBLE_UNDERLINE_STYLE}">${t}</span>` : `<u>${t}</u>`;
}

/** Indent a row's HTML by `steps`. Zero steps leaves it untouched. */
export function indentHtml(html: string, steps: number): string {
  if (steps <= 0 || !html) return html;
  return `<div style="padding-left: ${Math.min(steps, 4) * INDENT_PX}px">${html}</div>`;
}

/**
 * Lay a run of rows out for one column: indents applied, blank rows (null)
 * inserted around each hat. `textAbove` says whether the cell just above the
 * run already has something in it, so a hat at the very top of a run still
 * gets its gap from whatever was written before.
 *
 * Pockets are dropped here: they never become a row. Callers that turn a
 * pocket into a tab split the run at each pocket before calling this.
 */
export function layoutRows(rows: FlowRow[], textAbove = false): (string | null)[] {
  const out: (string | null)[] = [];
  let underHat = false;
  let underBlock = false;
  const lastFilled = () => (out.length ? out[out.length - 1] !== null : textAbove);
  for (const r of rows) {
    switch (r.kind) {
      case 'pocket':
        underHat = false; underBlock = false;
        break;
      case 'hat':
        if (lastFilled()) out.push(null);
        out.push(r.html);
        out.push(null);
        underHat = true; underBlock = false;
        break;
      case 'block':
        out.push(indentHtml(r.html, underHat ? 1 : 0));
        underBlock = true;
        break;
      default:
        out.push(indentHtml(r.html, (underHat ? 1 : 0) + (underBlock ? 1 : 0)));
    }
  }
  // A trailing gap after a final hat is only there to separate it from what
  // follows; with nothing following, it's just a hole that would push the next
  // send down a row.
  while (out.length && out[out.length - 1] === null) out.pop();
  return out;
}
