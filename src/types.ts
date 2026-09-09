// Shared shapes that cross module boundaries.

/**
 * An AI handler's escape hatch for genuine ambiguity.
 *
 * Rather than committing to a possibly-wrong result, a handler can return a
 * question; the caller shows it (via AIQuestionPrompt), then re-invokes the
 * SAME handler with the answer appended to `clarifications`. Prompts using
 * this contract are told to ask at most ONE question per call, never to ask
 * once two answers are already in hand, and to prefer a reasonable default
 * over asking whenever the input gives enough signal to infer one.
 */
export interface AIQuestion {
  question: string;
  /** 2–4 short, concrete option labels. The UI always adds a free-text "Other". */
  options: string[];
}

export interface AIClarification {
  question: string;
  answer: string;
}

export type { ExtractedFlowCard } from './lib/docxFlowCards';
