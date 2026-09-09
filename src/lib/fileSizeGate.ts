// Shared 2MB cap for speech docs / flows attached in chat or uploaded to Team
// Files — anything larger gets routed through the "too large" popup instead of
// being sent whole. See OversizedFilePopup.tsx and its call sites in Chat.tsx
// (mention attach) and TeamFiles.tsx (+ Add file).

export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

export function base64SizeBytes(b64: string): number {
  return Math.ceil((b64.length * 3) / 4);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
