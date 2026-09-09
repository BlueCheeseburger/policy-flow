import { useCallback, useState } from 'react';

/**
 * Drag-over visual state for a file drop zone. Every drop target in the app
 * (AnalyzeRound, AutoFlow, SpeechDocViewer) previously handled `onDragOver`
 * only to satisfy the browser's "you must preventDefault to allow a drop"
 * requirement — nothing ever reacted to a file actually being dragged over
 * it, so the zone looked inert right up until the drop landed.
 *
 * `onDragLeave` checks `relatedTarget` so hovering between the zone's own
 * child elements doesn't flicker the active state off and back on.
 */
export function useDragActive() {
  const [dragActive, setDragActive] = useState(false);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); // required for onDrop to fire at all
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragActive(false);
  }, []);

  return {
    dragActive,
    setDragActive,
    dragHandlers: { onDragEnter, onDragOver, onDragLeave },
  };
}
