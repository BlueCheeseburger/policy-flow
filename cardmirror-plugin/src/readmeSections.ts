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

/** The README's plugin subsections as raw markdown, by title. */
function rawSections(): { title: string; md: string }[] {
  const text = String(README ?? '');
  const start = text.indexOf('## Using the CardMirror plugin');
  if (start < 0) return [];
  const rest = text.slice(start + 1);
  const end = rest.search(/\n## /);
  const body = end < 0 ? rest : rest.slice(0, end);
  // Subsections are marked by a line that is only bold text: **Title**
  const parts = body.split(/\n\*\*([^*\n]+)\*\*\n/);
  const out: { title: string; md: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) out.push({ title: parts[i], md: parts[i + 1] ?? '' });
  return out;
}

export function helpSections(): HelpSection[] {
  return rawSections().map((s) => ({ title: s.title, html: block(s.md) }));
}

/**
 * The same sections as plain text for CardMirror's own `info` settings
 * (rendered with textContent: blank line = paragraph, "- " = bullet,
 * adjacent plain lines join). Markdown marks are stripped, links keep their
 * text, and numbered steps become bullets that keep their numbers.
 */
export function helpPlainSections(): { title: string; body: string }[] {
  const plain = (s: string) => s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
  return rawSections().map(({ title, md }) => {
    const lines: string[] = [];
    for (const raw of md.split('\n')) {
      const line = raw.trimEnd();
      const num = line.match(/^(\d+)\. (.*)$/);
      if (num) lines.push(`- ${num[1]}. ${plain(num[2])}`);
      else if (/^- /.test(line)) lines.push(`- ${plain(line.slice(2))}`);
      else if (!line.trim()) lines.push('');
      else if (/^\s+/.test(raw) && lines.length && lines[lines.length - 1].startsWith('- ')) lines[lines.length - 1] += ' ' + plain(line.trim());
      else lines.push(plain(line.trim()));
    }
    return { title, body: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
  }).filter((s) => s.body);
}
