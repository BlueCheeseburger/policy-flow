import React, { useState, useEffect } from 'react';

const DELAYS = [0, 150, 300];

/** Three bouncing dots — use inline inside buttons or small spaces. */
export function Dots({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-end gap-[3px] ${className}`}>
      {DELAYS.map((delay, i) => (
        <span
          key={i}
          className="block w-[3px] h-[3px] rounded-full bg-current"
          style={{ animation: `dot-wave 1.2s ease-in-out ${delay}ms infinite` }}
        />
      ))}
    </span>
  );
}

/** Arc SVG spinner — cleaner replacement for the old circle/path combo. */
export function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      className={`animate-spin shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.12" />
      <path
        d="M12 2a10 10 0 0 1 7.07 2.93"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Pencil edit icon */
export function EditIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

/** Trash delete icon */
export function TrashIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

export function CopyIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/** Cycles through `messages`, fading between them every `intervalMs`. Place
 *  beneath a spinner to narrate progress during slow async work (API/LLM calls).
 *  Resets to the first message whenever the message set changes. */
export function CyclingText({
  messages,
  intervalMs = 2600,
  className = '',
}: { messages: string[]; intervalMs?: number; className?: string }) {
  const [idx, setIdx] = useState(0);
  // Re-key the effect on the joined messages so a new set restarts from the top.
  const key = messages.join('|');
  useEffect(() => {
    setIdx(0);
    if (messages.length <= 1) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % messages.length), intervalMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, intervalMs]);
  if (messages.length === 0) return null;
  return (
    <span key={idx} className={className} style={{ animation: 'lm-fade 0.45s ease' }}>
      {messages[Math.min(idx, messages.length - 1)]}
    </span>
  );
}

/** Inline loading: an arc spinner with descriptive, dynamically-changing text
 *  beneath it. Use for operations you know will take time — AI/LLM calls,
 *  remote fetches — so the wait is narrated instead of a bare spinner. */
export function LoadingState({
  messages,
  className = '',
  spinnerClassName = 'w-5 h-5',
  intervalMs,
}: { messages: string[]; className?: string; spinnerClassName?: string; intervalMs?: number }) {
  return (
    <div
      className={`flex flex-col items-center gap-2 text-center ${className}`}
      style={{ color: 'var(--nav-inactive-color)' }}
    >
      <Spinner className={spinnerClassName} />
      <CyclingText messages={messages} intervalMs={intervalMs} className="text-[12px]" />
    </div>
  );
}

/** Full-panel loading state — centered dots + shimmering label. */
export function LoadingPanel({ message }: { message: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 min-h-[200px]">
      <div className="flex items-end gap-1.5">
        {DELAYS.map((delay, i) => (
          <span
            key={i}
            className="block w-2 h-2 rounded-full bg-ink/25"
            style={{ animation: `dot-wave 1.2s ease-in-out ${delay}ms infinite` }}
          />
        ))}
      </div>
      <p
        className="text-sm text-ink/40 tracking-wide select-none"
        style={{ animation: 'shimmer-text 2.4s ease-in-out infinite' }}
      >
        {message}
      </p>
    </div>
  );
}
