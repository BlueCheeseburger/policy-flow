import { useLayoutEffect } from 'react';

// Grows a composer textarea to fit its content, capped at `fraction` of the
// nearest scrollable chat panel's own height (not the window) — past that it
// scrolls internally instead of pushing the message list further out of view.
export function useAutoGrowTextarea(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  containerRef: React.RefObject<HTMLElement | null>,
  value: string,
  fraction = 1 / 3,
) {
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const maxH = containerRef.current ? containerRef.current.clientHeight * fraction : 160;
    const next = Math.min(ta.scrollHeight, Math.max(maxH, 36));
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > next ? 'auto' : 'hidden';
  }, [value, textareaRef, containerRef, fraction]);
}
