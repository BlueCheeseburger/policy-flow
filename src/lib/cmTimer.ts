// The CardMirror timer, mirrored into the flow. CardMirror owns the clock; the
// plugin broadcasts its state over the paired channel (cardMirrorLink.ts) on
// every change and every few seconds while it's open, and the flow sends back
// button presses. Each side's clock is its own, so a running clock is counted
// down here from when the state ARRIVED, not from CardMirror's timestamps:
// two machines' clocks can disagree by more than the timer's precision.
//
// Shared by the plugin and the web app, so both read one definition.

export const CM_TIMER_EVENT = 'pf-timer';
export const CM_TIMER_REQ_EVENT = 'pf-timer-req';
export const CM_TIMER_CMD_EVENT = 'pf-timer-cmd';

/** The plugin re-sends this often while CardMirror is open. */
export const CM_TIMER_HEARTBEAT_MS = 15_000;
/** No word for this long, and the flow says CardMirror's timer isn't reachable. */
export const CM_TIMER_STALE_MS = 40_000;

export type CmTimerMode = 'speech' | 'affPrep' | 'negPrep';
const MODES: readonly CmTimerMode[] = ['speech', 'affPrep', 'negPrep'];

export interface CmTimerState {
  mode: CmTimerMode;
  running: boolean;
  /** The speech clock: time left, or time elapsed while `stopwatch`. */
  speechMs: number;
  affPrepMs: number;
  negPrepMs: number;
  stopwatch: boolean;
  expiredMode: CmTimerMode | null;
  prepTotalMs: number;
  /** Speech preset buttons, in minutes. */
  presets: number[];
}

export type CmTimerCmd =
  | { action: 'start' }
  | { action: 'pause' }
  | { action: 'reset' }
  | { action: 'mode'; mode: CmTimerMode }
  | { action: 'preset'; minutes: number }
  | { action: 'set'; ms: number };

const MAX_MS = 600 * 60_000;
const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(MAX_MS, v)) : null);
const isMode = (v: unknown): v is CmTimerMode => typeof v === 'string' && (MODES as readonly string[]).includes(v);

/** A timer state off the wire, or null if it isn't one. */
export function parseTimerMsg(raw: unknown): CmTimerState | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || !isMode(r.mode) || typeof r.running !== 'boolean') return null;
  const speechMs = ms(r.speechMs), affPrepMs = ms(r.affPrepMs), negPrepMs = ms(r.negPrepMs);
  if (speechMs === null || affPrepMs === null || negPrepMs === null) return null;
  const presets = Array.isArray(r.presets)
    ? r.presets.filter((m): m is number => typeof m === 'number' && Number.isFinite(m) && m > 0 && m <= 600).slice(0, 6)
    : [];
  return {
    mode: r.mode,
    running: r.running,
    speechMs, affPrepMs, negPrepMs,
    stopwatch: r.stopwatch === true,
    expiredMode: isMode(r.expiredMode) ? r.expiredMode : null,
    prepTotalMs: ms(r.prepTotalMs) ?? 10 * 60_000,
    presets,
  };
}

/** A button press off the wire, or null if it isn't one. */
export function parseTimerCmd(raw: unknown): CmTimerCmd | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  switch (r.action) {
    case 'start': case 'pause': case 'reset': return { action: r.action };
    case 'mode': return isMode(r.mode) ? { action: 'mode', mode: r.mode } : null;
    case 'preset': {
      const m = r.minutes;
      return typeof m === 'number' && Number.isFinite(m) && m > 0 && m <= 600 ? { action: 'preset', minutes: m } : null;
    }
    case 'set': { const v = ms(r.ms); return v === null ? null : { action: 'set', ms: v }; }
    default: return null;
  }
}

export type CmClock = 'speech' | 'aff' | 'neg';
const clockMode: Record<CmClock, CmTimerMode> = { speech: 'speech', aff: 'affPrep', neg: 'negPrep' };

/** A clock's value now, given the state and when (on this machine) it arrived. */
export function clockMs(s: CmTimerState, clock: CmClock, receivedAt: number, now: number): number {
  const base = clock === 'speech' ? s.speechMs : clock === 'aff' ? s.affPrepMs : s.negPrepMs;
  if (!s.running || s.mode !== clockMode[clock]) return base;
  const gone = Math.max(0, now - receivedAt);
  if (clock === 'speech' && s.stopwatch) return Math.min(MAX_MS, base + gone);
  return Math.max(0, base - gone);
}

/** The clock the big display shows. */
export function activeClock(s: CmTimerState): CmClock {
  return s.mode === 'affPrep' ? 'aff' : s.mode === 'negPrep' ? 'neg' : 'speech';
}

/** M:SS. A countdown rounds up, so it never shows 0:00 early; a count-up rounds down. */
export function formatClock(msIn: number, up = false): string {
  const s = Math.max(0, up ? Math.floor(msIn / 1000) : Math.ceil(msIn / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A typed time, the way CardMirror's display reads one: `M:SS` literally, or
 * bare digits keypad style, the last two being seconds (`800` → 8:00).
 */
export function parseTimeInput(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const m = t.match(/^(\d+):(\d{1,2})$/);
  if (m) {
    const sec = parseInt(m[2], 10);
    return sec >= 60 ? null : (parseInt(m[1], 10) * 60 + sec) * 1000;
  }
  if (/^\d+$/.test(t)) {
    const seconds = parseInt(t.length <= 2 ? t : t.slice(-2), 10);
    const minutes = t.length <= 2 ? 0 : parseInt(t.slice(0, -2), 10);
    return (minutes * 60 + seconds) * 1000;
  }
  return null;
}
