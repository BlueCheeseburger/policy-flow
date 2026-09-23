// Pulls the plugin's help text out of the repo README at build time
// (scripts/build-plugin.mjs loads .md files as text), so the settings window
// and the README can never say different things.

// @ts-ignore — resolved by esbuild's text loader, not by TypeScript.
import README from '../../README.md';

export interface HelpSection { title: string; html: string }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The small slice of markdown the README section uses: bold, code, links. */
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

/** Lists and paragraphs; continuation lines (indented) join their item. */
function block(md: string): string {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let item: string | null = null;
  let para: string[] = [];
  const flushItem = () => { if (item !== null) { out.push(`<li>${inline(item)}</li>`); item = null; } };
  const flushList = () => { flushItem(); if (list) { out.push(`</${list}>`); list = null; } };
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^- (.*)$/);
    const num = line.match(/^\d+\. (.*)$/);
    if (bullet || num) {
      flushPara();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) { flushList(); out.push(`<${kind}>`); list = kind; }
      flushItem();
      item = (bullet ?? num)![1];
    } else if (!line.trim()) {
      flushList(); flushPara();
    } else if (item !== null && /^\s+/.test(raw)) {
      item += ' ' + line.trim();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushList(); flushPara();
  return out.join('');
}

export function helpSections(): HelpSection[] {
  const text = String(README ?? '');
  const start = text.indexOf('## Using the CardMirror plugin');
  if (start < 0) return [];
  const rest = text.slice(start + 1);
  const end = rest.search(/\n## /);
  const body = end < 0 ? rest : rest.slice(0, end);
  // Subsections are marked by a line that is only bold text: **Title**
  const parts = body.split(/\n\*\*([^*\n]+)\*\*\n/);
  const sections: HelpSection[] = [];
  for (let i = 1; i < parts.length; i += 2) sections.push({ title: parts[i], html: block(parts[i + 1] ?? '') });
  return sections;
}
