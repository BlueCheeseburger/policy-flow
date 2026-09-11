import React, { useEffect } from 'react';
import { useApp } from '../store/appStore';

/**
 * The undo affordance for destructive actions. A deleted flow tab is gone from
 * the grid immediately — this is what makes that safe, so the confirm dialog
 * that would otherwise interrupt every delete isn't needed.
 */
export default function UndoToasts() {
  const { undoToasts, dismissUndoToast } = useApp();
  return (
    <div className="fixed right-4 z-[60] flex flex-col gap-2 items-end" style={{ bottom: 44 }}>
      {undoToasts.map((t) => (
        <Toast key={t.id} id={t.id} message={t.message} onUndo={t.onUndo} onDismiss={dismissUndoToast} />
      ))}
    </div>
  );
}

function Toast({ id, message, onUndo, onDismiss }: {
  id: string;
  message: string;
  onUndo: () => void | Promise<void>;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(id), 8000);
    return () => clearTimeout(t);
  }, [id, onDismiss]);

  return (
    <div
      className="flex items-center gap-3 px-4 py-2 rounded-lg shadow-lg border text-sm"
      style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-color)' }}
      role="status"
    >
      <span>{message}</span>
      <button
        className="btn px-2 py-0.5 text-xs"
        onClick={async () => { await onUndo(); onDismiss(id); }}
      >
        Undo
      </button>
      <button className="btn-icon px-1 text-xs" onClick={() => onDismiss(id)} title="Dismiss">✕</button>
    </div>
  );
}
