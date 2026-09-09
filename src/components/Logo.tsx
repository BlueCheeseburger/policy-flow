import React, { useId } from 'react';

/**
 * The Policy Flow mark — the same three stripes as Warroom's, because the two
 * are the same family of tool.
 *
 * The geometry is lifted verbatim from `warroom/src/assets/warroom-logo.svg`
 * (stripes at x 144/218/292, each rising 76 right and 120 up, 48px round-capped
 * strokes) and translated so the mark's own bounding box is the viewBox, with
 * no squircle behind it.
 *
 * Warroom's app icon wraps those stripes in a neon bloom and a grain filter.
 * Both are omitted here on purpose: at 18px in a top bar a Gaussian bloom
 * smears the three stripes into one lilac blob. `public/favicon.svg` keeps the
 * squircle for the tab strip, where the mark is a badge rather than a wordmark.
 */
export default function Logo({ size = 18 }: { size?: number }) {
  // The gradient id has to be unique per instance: two inline SVGs sharing one
  // id means the second silently paints with the first one's definition.
  const gradientId = useId();
  return (
    <svg
      width={size}
      height={(size * 168) / 272}
      viewBox="0 0 272 168"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Policy Flow"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="1" x2="1" y2="0" gradientUnits="objectBoundingBox">
          <stop offset="0%" stopColor="#88CCFF" />
          <stop offset="12%" stopColor="#3388FF" />
          <stop offset="35%" stopColor="#4466EE" />
          <stop offset="50%" stopColor="#7744DD" />
          <stop offset="65%" stopColor="#AA44DD" />
          <stop offset="88%" stopColor="#CC66FF" />
          <stop offset="100%" stopColor="#DDAAFF" />
        </linearGradient>
      </defs>
      <g stroke={`url(#${gradientId})`} strokeWidth="48" strokeLinecap="round">
        <line x1="24" y1="144" x2="100" y2="24" />
        <line x1="98" y1="144" x2="174" y2="24" />
        <line x1="172" y1="144" x2="248" y2="24" />
      </g>
    </svg>
  );
}
