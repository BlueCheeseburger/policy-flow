import { useEffect, useRef, useState } from 'react';
import {
  CM_TIMER_STALE_MS, activeClock, clockMs, formatClock, parseTimeInput,
  type CmTimerCmd, type CmTimerState,
} from '../lib/cmTimer';

/**
 * CardMirror's timer, in the corner of the flow. Collapsed, it's one pill:
 * which clock is up, its time, and an arrow. The arrow opens the whole timer,
 * laid out like CardMirror's own panel: the big display (click it while paused
 * to type a time), reset, start/pause, the speech presets, and both prep
 * clocks. Every button presses the real one in CardMirror; what shows here is
 * always what CardMirror reports back.
 */

const OPEN_KEY = 'pf-cm-timer-open';
const MODE_LABEL = { speech: 'Speech', affPrep: 'Aff prep', negPrep: 'Neg prep' } as const;

export default function CardMirrorTimer({ state, receivedAt, onCmd, affColor, negColor }: {
  state: CmTimerState;
  /** When (on this machine) `state` arrived. */
  receivedAt: number;
  onCmd: (cmd: CmTimerCmd) => void;
  affColor: string;
  negColor: string;
}) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } });
  const [now, setNow] = useState(() => Date.now());
  const [editing, setEditing] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Quick ticks while a clock runs; slow ones otherwise, just to notice when
  // CardMirror has gone quiet.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), state.running ? 250 : 5000);
    setNow(Date.now());
    return () => clearInterval(id);
  }, [state.running, receivedAt]);

  useEffect(() => { if (editing !== null) inputRef.current?.select(); }, [editing !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  // CardMirror started the clock while a time was being typed here: drop it.
  useEffect(() => { if (state.running) setEditing(null); }, [state.running]);

  const toggle = () => setOpen((v) => {
    try { localStorage.setItem(OPEN_KEY, v ? '0' : '1'); } catch { /* per-device nicety */ }
    return !v;
  });

  const stale = now - receivedAt > CM_TIMER_STALE_MS;
  const clock = activeClock(state);
  const up = clock === 'speech' && state.stopwatch;
  const shown = clockMs(state, clock, receivedAt, now);
  const expired = !up && state.expiredMode === state.mode;
  const tint = state.mode === 'affPrep' ? affColor : state.mode === 'negPrep' ? negColor : undefined;
  const timeColor = expired || (state.running && !up && shown <= 0) ? 'var(--danger)' : tint ?? 'var(--ink)';
  const aff = clockMs(state, 'aff', receivedAt, now);
  const neg = clockMs(state, 'neg', receivedAt, now);

  const send = (cmd: CmTimerCmd) => { if (!stale) onCmd(cmd); };
  const commitEdit = () => {
    if (editing === null) return;
    const v = parseTimeInput(editing);
    setEditing(null);
    if (v !== null) send({ action: 'set', ms: v });
  };

  const time = (
    <span className="tabular-nums" style={{ color: timeColor, fontFamily: 'var(--font-num)' }}>
      {up && <span aria-label="counting up" style={{ fontSize: '0.7em', marginRight: 2 }}>↑</span>}
      {formatClock(shown, up)}
    </span>
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={toggle}
        className="glass-elevated shadow-lg rounded-full flex items-center gap-2 pl-3 pr-2 h-8 text-xs pointer-events-auto"
        style={{ border: '1px solid var(--border-subtle)', opacity: stale ? 0.6 : 1 }}
        title={stale ? "CardMirror's timer isn't answering. Open the full timer" : 'Open the full CardMirror timer'}
        aria-label="Open the CardMirror timer"
      >
        {state.running && !stale && (
          <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: tint ?? 'var(--accent)' }} />
        )}
        <span className="text-[10px] uppercase tracking-[0.06em]" style={{ color: tint ?? 'var(--label-color)' }}>
          {MODE_LABEL[state.mode]}
        </span>
        <span className="text-sm font-semibold">{time}</span>
        <span className="text-ink/50 text-sm leading-none" aria-hidden>‹</span>
      </button>
    );
  }

  const presetBtn = (m: number) => (
    <button
      key={m}
      type="button"
      className="btn text-xs h-7 px-0 flex-1 tabular-nums"
      disabled={stale}
      title={`Load ${m}:00 on the speech clock`}
      onClick={() => send({ action: 'preset', minutes: m })}
    >{m}</button>
  );

  const prepBtn = (side: 'aff' | 'neg') => {
    const mode = side === 'aff' ? 'affPrep' : 'negPrep';
    const active = state.mode === mode;
    const color = side === 'aff' ? affColor : negColor;
    const val = side === 'aff' ? aff : neg;
    return (
      <button
        type="button"
        className="flex-1 h-8 rounded-md text-xs flex items-center justify-center gap-1 transition tabular-nums"
        disabled={stale}
        style={{
          border: `1px solid ${active ? color : 'var(--border-med)'}`,
          background: active ? `color-mix(in srgb, ${color} 16%, transparent)` : 'transparent',
          color,
        }}
        title={`${side === 'aff' ? 'Affirmative' : 'Negative'} prep${active ? '' : ' (switch to it)'}`}
        onClick={() => send({ action: 'mode', mode })}
      >
        <span className="font-semibold">{side === 'aff' ? 'A:' : 'N:'}</span>
        <span>{formatClock(val)}</span>
      </button>
    );
  };

  return (
    <div
      className="glass-elevated shadow-xl rounded-lg p-3 space-y-2.5 pointer-events-auto"
      style={{ width: 232, border: '1px solid var(--border-subtle)' }}
      role="group"
      aria-label="CardMirror timer"
    >
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-[0.08em] text-ink/50 flex-1 whitespace-nowrap">
          CardMirror
        </span>
        {state.mode === 'speech' ? (
          <span className="text-[10px] uppercase tracking-[0.06em]" style={{ color: 'var(--label-color)' }}>Speech</span>
        ) : (
          <button
            type="button"
            className="text-[10px] uppercase tracking-[0.06em] rounded px-1.5 h-5 hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--label-color)', border: '1px solid var(--border-med)' }}
            disabled={stale}
            title={`Back to the speech clock (${formatClock(clockMs(state, 'speech', receivedAt, now), state.stopwatch)})`}
            onClick={() => send({ action: 'mode', mode: 'speech' })}
          >← Speech</button>
        )}
        <button
          type="button"
          className="text-ink/50 hover:text-ink w-5 h-5 leading-none text-sm"
          onClick={toggle}
          title="Collapse the timer"
          aria-label="Collapse the timer"
        >›</button>
      </div>

      {editing !== null ? (
        <input
          ref={inputRef}
          className="input w-full text-center text-3xl font-semibold tabular-nums py-1"
          value={editing}
          aria-label="Set the time (M:SS, or digits like 800 for 8:00)"
          onChange={(e) => setEditing(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
            if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
          }}
        />
      ) : (
        <button
          type="button"
          className="w-full text-center text-4xl font-semibold leading-tight py-0.5 rounded-md"
          style={{ cursor: state.running || stale ? 'default' : 'text' }}
          title={state.running ? 'Pause to type a time' : 'Click to type a time'}
          onClick={() => { if (!state.running && !stale) setEditing(formatClock(shown, up)); }}
        >
          {time}
        </button>
      )}

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="btn h-8 w-8 px-0 text-sm"
          disabled={stale}
          title="Reset all timers (refills both prep clocks)"
          aria-label="Reset all timers"
          onClick={() => send({ action: 'reset' })}
        >↻</button>
        <button
          type="button"
          className="btn-primary h-8 flex-1 text-sm"
          disabled={stale}
          aria-label={state.running ? 'Pause' : 'Start'}
          onClick={() => send({ action: state.running ? 'pause' : 'start' })}
        >{state.running ? '⏸ Pause' : '▶ Start'}</button>
      </div>

      {state.presets.length > 0 && (
        <div className="flex items-center gap-1.5">{state.presets.map(presetBtn)}</div>
      )}

      <div className="flex items-center gap-1.5">
        {prepBtn('aff')}
        {prepBtn('neg')}
      </div>

      {stale && (
        <p className="text-[11px] text-ink/55 leading-snug">
          CardMirror isn&rsquo;t answering. Open it with the Policy Flow plugin on, and this
          picks back up.
        </p>
      )}
    </div>
  );
}
