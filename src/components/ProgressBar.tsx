// Thin linear progress bar — indeterminate (no known percentage) by default,
// since none of this app's drop-zone processing (docx parsing, OCR, AI
// extraction) reports real byte-level progress. Reuses the `wr-indeterminate`
// sweep keyframe defined in index.css.
export default function ProgressBar({ pct, className = '' }: { pct?: number; className?: string }) {
  return (
    <div
      className={`w-full rounded-full overflow-hidden ${className}`}
      style={{ height: 4, background: 'var(--border-subtle)' }}
    >
      <div
        className="h-full rounded-full"
        style={
          typeof pct === 'number'
            ? { width: `${Math.max(0, Math.min(100, pct))}%`, background: 'var(--accent)', transition: 'width 0.2s ease' }
            : { width: '30%', background: 'var(--accent)', animation: 'wr-indeterminate 1.2s ease-in-out infinite' }
        }
      />
    </div>
  );
}
