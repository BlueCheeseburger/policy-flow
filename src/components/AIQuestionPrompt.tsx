import { useState } from 'react';
import type { AIQuestion } from '../types';

// Shared UI for the AI-clarifying-question contract (see AIQuestion / AIQuestionOr
// in src/types.ts). Used by any one-shot AI wizard step that can pause instead of
// guessing — Auto Flow, Round Analysis, and the card cutter. Deliberately modeled
// on how Claude asks a clarifying question mid-task rather than committing to a
// guess: a short question, 2–4 concrete options, plus a free-text "Other".
export default function AIQuestionPrompt({
  question, onAnswer, busy,
}: {
  question: AIQuestion;
  onAnswer: (answer: string) => void;
  busy?: boolean;
}) {
  const [other, setOther] = useState('');
  const [showOther, setShowOther] = useState(false);

  return (
    <div className="rounded-sm border border-line p-3 space-y-2.5" style={{ background: 'var(--bg-elevated)' }}>
      <div className="flex items-start gap-2">
        <span className="text-base leading-none mt-0.5" aria-hidden>❓</span>
        <p className="text-sm text-ink/90 flex-1">{question.question}</p>
      </div>
      <div className="flex flex-wrap gap-1.5 pl-6">
        {question.options.map((opt) => (
          <button
            key={opt}
            className="btn text-xs px-2.5 py-1"
            disabled={busy}
            onClick={() => onAnswer(opt)}
          >
            {opt}
          </button>
        ))}
        {!showOther && (
          <button className="btn text-xs px-2.5 py-1 text-ink/60" disabled={busy} onClick={() => setShowOther(true)}>
            Other…
          </button>
        )}
      </div>
      {showOther && (
        <div className="flex items-center gap-1.5 pl-6">
          <input
            autoFocus
            className="input text-xs flex-1 max-w-xs"
            placeholder="Type your answer…"
            value={other}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && other.trim()) onAnswer(other.trim()); }}
            disabled={busy}
          />
          <button className="btn-primary text-xs px-2.5 py-1" disabled={busy || !other.trim()} onClick={() => onAnswer(other.trim())}>
            Send
          </button>
        </div>
      )}
    </div>
  );
}
