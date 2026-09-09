import React, { useEffect, useRef, useState } from 'react';

/**
 * The app's hover tooltip — one implementation, used everywhere.
 *
 * There were two of these (Home's `Tooltip` and FlowView's `FlowTooltip`) with
 * the same visual design copy-pasted, and they had drifted: only one waited
 * before showing, only one sized itself with `width: max-content`, only one
 * could be disabled or run multi-line. So the same control gave a different
 * hover experience depending on which view it lived in. Everything else in the
 * app used the native `title` attribute, which renders as the OS tooltip —
 * a different shape, a different delay, and unreadable against the dark themes.
 *
 * `up` flips it above the anchor (for controls near the bottom edge), `wide`
 * is for multi-line content, and `disabled` renders the children bare.
 */
export default function Tooltip({
  text, children, up = false, disabled, wide = false, className, delay = 350,
}: {
  text?: string;
  children: React.ReactNode;
  /** Show above the anchor instead of below — for controls near the bottom edge. */
  up?: boolean;
  disabled?: boolean;
  /**
   * Multi-line content (e.g. a flow tab's summary): wider box, left-aligned,
   * and `\n`s are preserved as line breaks rather than collapsing into one
   * narrow column.
   */
  wide?: boolean;
  /** Extra classes for the wrapper — e.g. `flex-1 min-w-0` so a truncating
   *  child can actually shrink instead of overflowing. */
  className?: string;
  /** Show-delay in ms. A dense toolbar shouldn't flash a tooltip for every icon
   *  the cursor passes over on its way somewhere else. */
  delay?: number;
}) {
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A tooltip whose anchor unmounts mid-countdown (a button that disappears on
  // click) would otherwise fire setState on a dead component.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (!text || disabled) return <>{children}</>;

  function onEnter() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShow(true), delay);
  }
  function onLeave() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setShow(false);
  }

  return (
    <span
      className={className}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      // A tooltip that survives the click that dismisses its own menu looks
      // stuck, so any press hides it immediately.
      onMouseDown={onLeave}
    >
      {children}
      {show && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            ...(up ? { bottom: 'calc(100% + 7px)' } : { top: 'calc(100% + 7px)' }),
            zIndex: 9999,
            // Load-bearing: an absolutely positioned span with only `left` set
            // shrink-to-fits against the ANCHOR's width (often a 26px icon
            // button), not its own text — so a short label would wrap one word
            // per line. maxWidth is just a ceiling so a long tooltip wraps wide
            // rather than narrow-and-tall.
            width: 'max-content',
            maxWidth: wide ? 360 : 220,
            whiteSpace: wide ? 'pre-line' : 'normal',
            textAlign: wide ? 'left' : 'center',
            lineHeight: wide ? 1.5 : undefined,
            borderRadius: 8,
            padding: '5px 10px',
            fontSize: 11,
            pointerEvents: 'none',
            background: 'color-mix(in srgb, var(--bg-popover, var(--bg-sidebar)) 88%, transparent)',
            backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturate))',
            WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturate))',
            border: '1px solid var(--border-subtle)',
            color: 'var(--ink)',
            boxShadow: 'var(--shadow-elevated)',
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}
