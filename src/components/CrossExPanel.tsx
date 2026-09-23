import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CxBullet, CxLevel, cxToPlainText, normalizeCx, parseCx, pastedToBullets, serializeCx } from '../lib/crossEx';

/**
 * The flow's cross-ex doc: a side panel of bullet points and sub-points, and
 * only those. Every line is a bullet — Enter makes the next one, Tab turns it
 * into a sub-point under the one above, Shift-Tab brings it back out. Pasted
 * text is split into bullets, with its own glyphs and numbering stripped.
 *
 * Controlled: `value` is the serialized outline (lib/crossEx.ts). FlowView
 * owns saving it and syncing it to partners in a live room — and in one, the
 * header says so, and a partner's colored marker sits on the point they're
 * typing in, so notes arriving from someone else never look like a glitch.
 */
export default function CrossExPanel({ value, onChange, onClose, live, peers, onFocusBullet }: {
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
  /** 'live': synced with the room now; 'connecting': will be; 'off': this device only. */
  live: 'live' | 'connecting' | 'off';
  /** Everyone else in the room, and which bullet (if any) they're in. */
  peers: { color: string; index: number | null }[];
  /** Tells partners which bullet this user is in (null when none). */
  onFocusBullet: (index: number | null) => void;
}) {
  const bullets = useMemo(() => parseCx(value), [value]);
  const inputs = useRef<(HTMLTextAreaElement | null)[]>([]);
  // Where the caret goes after a structural edit (split, merge, indent).
  const pendingFocus = useRef<{ index: number; caret: number } | null>(null);
  const [copied, setCopied] = useState(false);

  function commit(next: CxBullet[], focus?: { index: number; caret: number }) {
    if (focus) pendingFocus.current = focus;
    onChange(serializeCx(normalizeCx(next)));
  }

  useLayoutEffect(() => {
    // Auto-grow every bullet to its wrapped text.
    for (const ta of inputs.current) {
      if (!ta) continue;
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight}px`;
    }
    const f = pendingFocus.current;
    if (!f) return;
    pendingFocus.current = null;
    const ta = inputs.current[Math.max(0, Math.min(f.index, bullets.length - 1))];
    if (!ta) return;
    ta.focus();
    const c = Math.min(f.caret, ta.value.length);
    ta.setSelectionRange(c, c);
  });

  function setLevel(i: number, level: CxLevel) {
    if (i === 0 && level === 1) return; // the first point has nothing to sit under
    const ta = inputs.current[i];
    commit(bullets.map((b, j) => (j === i ? { ...b, level } : b)), { index: i, caret: ta?.selectionStart ?? 0 });
  }

  /** True when the caret is on the textarea's first (or last) wrapped line. */
  function onEdgeLine(ta: HTMLTextAreaElement, edge: 'first' | 'last'): boolean {
    const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    if (ta.scrollHeight <= lineH * 1.6) return true; // single visual line
    return edge === 'first' ? ta.selectionStart === 0 : ta.selectionEnd === ta.value.length;
  }

  function onKeyDown(i: number, e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const ta = e.currentTarget;
    const b = bullets[i];
    const collapsed = ta.selectionStart === ta.selectionEnd;
    const pos = ta.selectionStart;

    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter on an empty sub-point steps back out, the way list editors do.
      if (!b.text && b.level === 1) { setLevel(i, 0); return; }
      const before = b.text.slice(0, ta.selectionStart);
      const after = b.text.slice(ta.selectionEnd);
      const next = [...bullets];
      next.splice(i, 1, { ...b, text: before }, { level: b.level, text: after });
      commit(next, { index: i + 1, caret: 0 });
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      setLevel(i, e.shiftKey ? 0 : 1);
      return;
    }
    if (e.key === 'Backspace' && collapsed && pos === 0) {
      e.preventDefault();
      if (b.level === 1) { setLevel(i, 0); return; }
      if (i === 0) return;
      const prev = bullets[i - 1];
      const next = [...bullets];
      next.splice(i - 1, 2, { ...prev, text: prev.text + b.text });
      commit(next, { index: i - 1, caret: prev.text.length });
      return;
    }
    if (e.key === 'Delete' && collapsed && pos === b.text.length && i < bullets.length - 1) {
      e.preventDefault();
      const next = [...bullets];
      next.splice(i, 2, { ...b, text: b.text + bullets[i + 1].text });
      commit(next, { index: i, caret: b.text.length });
      return;
    }
    if (e.key === 'ArrowUp' && i > 0 && !e.shiftKey && onEdgeLine(ta, 'first')) {
      e.preventDefault();
      const up = inputs.current[i - 1];
      if (up) { up.focus(); const c = Math.min(pos, up.value.length); up.setSelectionRange(c, c); }
      return;
    }
    if (e.key === 'ArrowDown' && i < bullets.length - 1 && !e.shiftKey && onEdgeLine(ta, 'last')) {
      e.preventDefault();
      const down = inputs.current[i + 1];
      if (down) { down.focus(); const c = Math.min(pos, down.value.length); down.setSelectionRange(c, c); }
    }
  }

  function onPaste(i: number, e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const text = e.clipboardData.getData('text/plain');
    if (!/[\r\n]/.test(text.trim())) {
      // One line: paste normally, minus any leading bullet glyph.
      const one = pastedToBullets(text)[0];
      if (!one || one.text === text) return;
      e.preventDefault();
      const ta = e.currentTarget;
      const b = bullets[i];
      const merged = b.text.slice(0, ta.selectionStart) + one.text + b.text.slice(ta.selectionEnd);
      commit(bullets.map((x, j) => (j === i ? { ...x, text: merged } : x)), { index: i, caret: ta.selectionStart + one.text.length });
      return;
    }
    e.preventDefault();
    const pasted = pastedToBullets(text);
    if (!pasted.length) return;
    const ta = e.currentTarget;
    const b = bullets[i];
    const before = b.text.slice(0, ta.selectionStart);
    const after = b.text.slice(ta.selectionEnd);
    // Pasted structure is relative to where it lands: under a sub-point,
    // everything pasted is a sub-point too.
    const lift = (l: CxLevel): CxLevel => (b.level === 1 ? 1 : l);
    const rows: CxBullet[] = pasted.map((p) => ({ level: lift(p.level), text: p.text }));
    // Several lines are several points, so they never fuse with the one being
    // typed: text before the caret stays its own bullet, the pasted bullets
    // follow, and text after the caret continues as a bullet after them.
    const out: CxBullet[] = [];
    if (before.trim()) out.push({ level: b.level, text: before });
    out.push(...rows);
    const lastPasted = out.length - 1;
    if (after.trim()) out.push({ level: b.level, text: after });
    const next = [...bullets];
    next.splice(i, 1, ...out);
    commit(next, { index: i + lastPasted, caret: out[lastPasted].text.length });
  }

  const empty = bullets.every((b) => !b.text.trim());
  const others = peers.length;
  const status = live === 'live'
    ? (others ? `Live · ${others} other${others === 1 ? '' : 's'} here` : 'Live · shared with this flow')
    : live === 'connecting' ? 'Connecting…' : 'This device only';
  const statusTip = live === 'live'
    ? 'Everyone with this flow open sees these notes as they’re typed.'
    : live === 'connecting' ? 'Reaching the room — notes sync once connected.' : 'Not connected to a live room, so these notes stay on this device.';

  return (
    <aside
      className="flex flex-col min-h-0 shrink-0"
      style={{ width: 340, borderLeft: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)' }}
      aria-label="Cross-ex notes"
    >
      <div className="flex items-center gap-2 px-3 h-9 shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--label-color)' }}>Cross-ex</span>
        <span className="flex items-center gap-1 text-[10.5px] truncate" style={{ color: 'var(--label-color)' }} title={statusTip}>
          <span
            aria-hidden
            className="inline-block rounded-full shrink-0"
            style={{ width: 5, height: 5, background: live === 'live' ? '#22c55e' : 'var(--border-med)' }}
          />
          {status}
        </span>
        <div className="flex-1" />
        <button
          className="btn px-2 py-0 text-[11px] leading-6"
          disabled={empty}
          onClick={() => {
            void navigator.clipboard.writeText(cxToPlainText(bullets)).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >{copied ? 'Copied' : 'Copy'}</button>
        <button className="btn-icon px-1 text-xs" onClick={onClose} title="Close cross-ex" aria-label="Close cross-ex">✕</button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto scroll-thin px-3 py-2.5">
        <ul className="flex flex-col" style={{ gap: 2 }}>
          {bullets.map((b, i) => {
            const here = peers.filter((p) => p.index === i);
            return (
            <li
              key={i}
              className="flex items-start relative rounded-[5px]"
              style={{
                paddingLeft: b.level ? 20 : 0,
                // A partner typing here: their color, the same ring the grid
                // draws around a cell they're in.
                boxShadow: here.length ? `inset 2px 0 0 ${here[0].color}` : undefined,
                background: here.length ? `color-mix(in srgb, ${here[0].color} 8%, transparent)` : undefined,
              }}
            >
              <span
                aria-hidden
                className="shrink-0 select-none text-center"
                style={{ width: 16, lineHeight: '20px', fontSize: b.level ? 10 : 13, color: 'var(--label-color)' }}
              >{b.level ? '◦' : '•'}</span>
              <textarea
                ref={(el) => { inputs.current[i] = el; }}
                rows={1}
                value={b.text}
                spellCheck
                placeholder={i === 0 && empty ? 'Question, then Tab for the answer under it' : ''}
                aria-label={b.level ? 'Sub-point' : 'Point'}
                className="flex-1 min-w-0 resize-none bg-transparent outline-none text-[13px]"
                style={{ lineHeight: '20px', color: 'rgb(var(--ink-rgb))', overflow: 'hidden', padding: 0, border: 'none' }}
                onChange={(e) => {
                  // Same cleanup parseCx applies, so the round-trip hands back
                  // exactly what's in the box and the caret stays put.
                  const text = e.currentTarget.value.replace(/[\r\n\t\u2028\u2029]+/g, ' ');
                  commit(bullets.map((x, j) => (j === i ? { ...x, text } : x)));
                }}
                onKeyDown={(e) => onKeyDown(i, e)}
                onPaste={(e) => onPaste(i, e)}
                onFocus={() => onFocusBullet(i)}
                onBlur={() => onFocusBullet(null)}
              />
            </li>
            );
          })}
        </ul>
      </div>
      <div className="px-3 py-1.5 text-[10.5px] shrink-0" style={{ color: 'var(--label-color)', borderTop: '1px solid var(--border-subtle)' }}>
        Enter new point · Tab sub-point · ⇧Tab back out
      </div>
    </aside>
  );
}
