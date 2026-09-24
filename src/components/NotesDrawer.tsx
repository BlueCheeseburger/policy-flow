import React, { useMemo, useState } from 'react';
import CrossExPanel from './CrossExPanel';
import { cxToPlainText, parseCx } from '../lib/crossEx';

export type NotesTab = 'cx' | 'rfd';

/**
 * The notes drawer beside the grid: the cross-ex outline (bullets only) and
 * the RFD (free text: the reason for decision, written by a judge, or taken
 * down by a debater after the round). One drawer so the flow never loses more
 * than one column's worth of width, with a tab for each.
 *
 * Both notes save on their own and, in a live room, sync to everyone in the
 * flow as they're typed — the header says which, so a partner's words
 * appearing never looks like a glitch.
 */
export default function NotesDrawer({
  tab, onTab, onClose, cx, onCx, rfd, onRfd, live, peers, onFocusBullet,
}: {
  tab: NotesTab;
  onTab: (t: NotesTab) => void;
  onClose: () => void;
  cx: string;
  onCx: (next: string) => void;
  rfd: string;
  onRfd: (next: string) => void;
  /** 'live': synced with the room now; 'connecting': will be; 'off': this device only. */
  live: 'live' | 'connecting' | 'off';
  /** Everyone else in the room, and which CX bullet (if any) they're in. */
  peers: { color: string; index: number | null }[];
  onFocusBullet: (index: number | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyText = useMemo(
    () => (tab === 'cx' ? cxToPlainText(parseCx(cx)) : rfd.trim()),
    [tab, cx, rfd],
  );

  const others = peers.length;
  const status = live === 'live'
    ? (others ? `Live · ${others} other${others === 1 ? '' : 's'} here` : 'Live · shared with this flow')
    : live === 'connecting' ? 'Connecting…' : 'This device only';
  const statusTip = live === 'live'
    ? 'Everyone with this flow open sees these notes as they’re typed.'
    : live === 'connecting' ? 'Reaching the room — notes sync once connected.' : 'Not connected to a live room, so these notes stay on this device.';

  const words = rfd.trim() ? rfd.trim().split(/\s+/).length : 0;

  const tabBtn = (t: NotesTab, label: string) => (
    <button
      role="tab"
      aria-selected={tab === t}
      className="px-2 h-6 rounded-md text-[11px] font-semibold uppercase tracking-[0.06em] transition"
      style={{
        background: tab === t ? 'var(--nav-active-bg)' : 'transparent',
        color: tab === t ? 'var(--nav-active-color)' : 'var(--label-color)',
      }}
      onClick={() => onTab(t)}
    >{label}</button>
  );

  return (
    <aside
      className="flex flex-col min-h-0 shrink-0"
      style={{ width: 340, borderLeft: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)' }}
      aria-label={tab === 'cx' ? 'Cross-ex notes' : 'RFD notes'}
    >
      <div className="flex items-center gap-1 px-2 h-9 shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div role="tablist" aria-label="Notes" className="flex items-center gap-0.5">
          {tabBtn('cx', 'Cross-ex')}
          {tabBtn('rfd', 'RFD')}
        </div>
        <div className="flex-1" />
        <button
          className="btn px-2 py-0 text-[11px] leading-6"
          disabled={!copyText}
          onClick={() => {
            void navigator.clipboard.writeText(copyText).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >{copied ? 'Copied' : 'Copy'}</button>
        <button className="btn-icon px-1 text-xs" onClick={onClose} title="Close notes" aria-label="Close notes">✕</button>
      </div>
      <div className="flex items-center gap-1 px-3 pt-2 text-[10.5px] shrink-0" style={{ color: 'var(--label-color)' }} title={statusTip}>
        <span
          aria-hidden
          className="inline-block rounded-full shrink-0"
          style={{ width: 5, height: 5, background: live === 'live' ? '#22c55e' : 'var(--border-med)' }}
        />
        <span className="truncate">{status}</span>
      </div>

      {tab === 'cx' ? (
        <CrossExPanel value={cx} onChange={onCx} peers={peers} onFocusBullet={onFocusBullet} />
      ) : (
        <>
          <textarea
            className="flex-1 min-h-0 w-full resize-none bg-transparent outline-none text-[13px] px-3 py-2.5 scroll-thin"
            style={{ lineHeight: '20px', color: 'rgb(var(--ink-rgb))', border: 'none' }}
            value={rfd}
            spellCheck
            aria-label="Reason for decision"
            placeholder={'Decision and why.\n\nWhich arguments decided it, what was dropped, and what each side could have done better.'}
            onChange={(e) => onRfd(e.currentTarget.value)}
          />
          <div className="px-3 py-1.5 text-[10.5px] shrink-0 flex" style={{ color: 'var(--label-color)', borderTop: '1px solid var(--border-subtle)' }}>
            <span>Reason for decision · saved as you type</span>
            <span className="flex-1" />
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{words} {words === 1 ? 'word' : 'words'}</span>
          </div>
        </>
      )}
    </aside>
  );
}
