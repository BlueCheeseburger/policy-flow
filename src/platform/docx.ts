// Reading .docx in the browser. Warroom did this in the main process with Node
// fs + JSZip; JSZip is a browser library, and every parser this calls is pure
// string work, so the whole path moves into the tab unchanged. No server, and
// no evidence ever leaves the machine unless the user opts into an AI step.

import JSZip from 'jszip';
import { resolveFile, fileNameOf } from './files';
import { resolveHeadingStyles, defaultHeadingLevels, extractDocText } from '../lib/docxStyles';
import { extractFlowCardsFromXml, type ExtractedFlowCard } from '../lib/docxFlowCards';

interface DocParts { documentXml: string; headingLevels: Map<string, number> }

// Unzipping the same doc twice in one run is common (Auto Flow reads tags, then
// re-reads for bodies if summaries are on), so parsed parts are memoized per
// handle. The registry is per-page-load, so a stale entry can't outlive its file.
const partsCache = new Map<string, DocParts>();
const textCache = new Map<string, { full: string; tokenSaving: string }>();

async function loadParts(handle: string): Promise<DocParts> {
  const cached = partsCache.get(handle);
  if (cached) return cached;

  const file = resolveFile(handle);
  if (!file) throw new Error('That file is no longer available — pick it again.');

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new Error(`"${fileNameOf(handle)}" isn't a readable .docx file.`);
  }

  const documentXml = (await zip.file('word/document.xml')?.async('string')) ?? '';
  if (!documentXml) throw new Error(`Could not read the document body of "${fileNameOf(handle)}".`);

  const stylesXml = (await zip.file('word/styles.xml')?.async('string')) ?? '';
  let headingLevels = resolveHeadingStyles(stylesXml);
  if (headingLevels.size === 0) headingLevels = defaultHeadingLevels();

  const parts = { documentXml, headingLevels };
  partsCache.set(handle, parts);
  return parts;
}

/** Auto Flow's input: tag + cite + pocket/hat/block ancestry per card. */
export async function extractBlocks(handle: string): Promise<{ cards: ExtractedFlowCard[] }> {
  const { documentXml, headingLevels } = await loadParts(handle);
  return { cards: extractFlowCardsFromXml(documentXml, headingLevels) };
}

/** The same, with card bodies — only for the opt-in AI summary step. */
export async function extractBlocksWithBodies(handle: string): Promise<{ cards: ExtractedFlowCard[] }> {
  const { documentXml, headingLevels } = await loadParts(handle);
  return { cards: extractFlowCardsFromXml(documentXml, headingLevels, true) };
}

/** Analyze Round's input: whole-document text, plus the read-aloud subset. */
export async function extractText(handle: string): Promise<{ full: string; tokenSaving: string }> {
  const cached = textCache.get(handle);
  if (cached) return cached;
  const { documentXml, headingLevels } = await loadParts(handle);
  const result = extractDocText(documentXml, headingLevels);
  textCache.set(handle, result);
  return result;
}
