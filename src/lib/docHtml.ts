// ── Rendered-document HTML sanitizer ────────────────────────────────────────
//
// For the docx-preview output that CasePreview caches and re-injects through
// dangerouslySetInnerHTML. This is a *document*-shaped counterpart to
// cellHtml.ts's sanitizeCellHtml: a flow cell is one run of formatted text, a
// rendered page has sections, tables, images and its own stylesheet, so it needs
// a much wider allowlist — but the same posture.
//
// It replaces a regex blacklist that stripped `<script>` and `\son*=` handlers.
// That approach loses to anything that doesn't put whitespace before the
// attribute name, because `/` is also a valid attribute separator:
//
//     <img/onerror=alert(1) src=x>      → survived
//     <svg/onload=alert(1)>             → survived
//     <iframe src="javascript:alert(1)"> → survived (no `on*` at all)
//
// Rather than patch the pattern, parse. DOMParser builds an inert document — it
// never runs script or fetches a resource — so we can walk the real tree, drop
// everything outside the allowlist, and let innerHTML serialization handle
// escaping. Blacklists get bypassed; allowlists have to be widened on purpose.
//
// The immediate input (docx-preview's own DOM serialization) is not attacker-
// controlled today, so this is defense-in-depth rather than a live-bug fix — but
// it guards a live HTML sink whose input is cached in localStorage and derived
// from user-supplied .docx files, and the dev-mode CSP allows inline handlers.

const ALLOWED_TAGS = new Set([
  // structure docx-preview emits
  'SECTION', 'ARTICLE', 'DIV', 'P', 'SPAN', 'BR', 'HR', 'PRE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'COL', 'COLGROUP', 'CAPTION',
  'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
  'FIGURE', 'FIGCAPTION', 'IMG',
  // inline formatting
  'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'INS', 'SUB', 'SUP', 'SMALL', 'MARK', 'FONT',
  // the document's own stylesheet travels with the page (contents sanitized below)
  'STYLE',
]);

// Dropped along with everything inside them. Unwrapping these would leak their
// raw text as markup (STYLE/SCRIPT) or keep an active embedding context.
const DROP_SUBTREE = new Set([
  'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED',
  'APPLET', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA',
  // Foreign content: SVG and MathML carry their own event-handler and script
  // surface (<svg><script>, xlink:href="javascript:") that HTML rules don't cover.
  'SVG', 'MATH',
]);

// `class` is required — docx-preview scopes every generated rule by class.
// `style` is allowed but filtered. Anything else (id, srcset, ping, target,
// formaction, href…) is dropped: none of it is needed to render a page thumbnail.
const ALLOWED_ATTRS = new Set(['class', 'style', 'colspan', 'rowspan', 'width', 'height', 'align', 'valign']);

// Only inline image data survives. docx-preview is configured with
// useBase64URL: true precisely so images are data: URIs and the result stays a
// self-contained string, so nothing legitimate needs a remote or blob src.
const SAFE_IMG_SRC = /^data:image\/(png|jpe?g|gif|webp|bmp|tiff?|x-emf|x-wmf);base64,[a-z0-9+/=\s]*$/i;

/** Strip CSS that can fetch, execute, or escape its rule. */
export function sanitizeCss(css: string): string {
  return css
    // @import pulls in a remote stylesheet.
    .replace(/@import[^;]*;?/gi, '')
    // IE expression(), -moz-binding, and legacy behavior: all execute.
    .replace(/expression\s*\(/gi, 'void(')
    .replace(/-moz-binding\s*:[^;}]*/gi, '')
    .replace(/behavior\s*:[^;}]*/gi, '')
    // url(...) is allowed only for inline image data.
    .replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (m, _q, u) =>
      /^data:image\//i.test(String(u).trim()) ? m : 'none')
    // Any surviving script-ish scheme.
    .replace(/javascript\s*:/gi, '')
    .replace(/vbscript\s*:/gi, '')
    // A stray </style> would end the block early and drop us back into markup.
    .replace(/<\/?style/gi, '');
}

// Declaration-level filter for inline style="" — same intent as sanitizeCss,
// applied per declaration so one bad value doesn't cost the whole attribute.
function sanitizeInlineStyle(style: string): string {
  return style
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((decl) => {
      const idx = decl.indexOf(':');
      if (idx < 0) return false;
      const prop = decl.slice(0, idx).trim().toLowerCase();
      const val = decl.slice(idx + 1).trim().toLowerCase();
      if (prop.startsWith('-moz-binding') || prop === 'behavior') return false;
      if (/expression\s*\(|javascript\s*:|vbscript\s*:/.test(val)) return false;
      // Same rule as the stylesheet: inline images only, no remote fetches.
      if (/url\(/.test(val) && !/url\(\s*['"]?data:image\//.test(val)) return false;
      return true;
    })
    .join('; ');
}

function scrub(el: Element): void {
  // Iterate over a copy: removing children mutates the live list.
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toUpperCase();

    if (DROP_SUBTREE.has(tag)) { child.remove(); continue; }

    if (tag === 'STYLE') {
      child.textContent = sanitizeCss(child.textContent || '');
      continue; // no attributes worth keeping, and no element children
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown but not dangerous: keep the (scrubbed) contents, drop the tag.
      scrub(child);
      while (child.firstChild) el.insertBefore(child.firstChild, child);
      child.remove();
      continue;
    }

    // Read the stashed src before the sweep below removes it — `data-wr-src` is
    // not in ALLOWED_ATTRS either, so it does not survive on its own.
    const stashedSrc = tag === 'IMG' ? child.getAttribute('data-wr-src') : null;

    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase();
      // Catches onclick/onerror/onload and any future on* in one rule.
      if (name.startsWith('on') || !ALLOWED_ATTRS.has(name)) {
        child.removeAttribute(attr.name);
        continue;
      }
      if (name === 'style') {
        const clean = sanitizeInlineStyle(attr.value);
        if (clean) child.setAttribute('style', clean);
        else child.removeAttribute('style');
      }
    }

    // src is not in ALLOWED_ATTRS, so the sweep stripped it from every element —
    // put it back only for an <img> that carried inline image data.
    if (tag === 'IMG') {
      if (stashedSrc && SAFE_IMG_SRC.test(stashedSrc)) child.setAttribute('src', stashedSrc);
      else child.remove();
      continue;
    }

    scrub(child);
  }
}

/**
 * Parse `html` inertly, drop everything outside the allowlist, reserialize.
 * Safe to hand to dangerouslySetInnerHTML.
 */
export function sanitizeDocHtml(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // renderFirstPageHtml prepends the document's <style> tags to the page markup,
  // and the HTML parser hoists a leading <style> into <head> — where it is not
  // part of body.innerHTML and would be silently dropped, un-styling every
  // thumbnail. Move them back to the front of the body before scrubbing.
  const headStyles = Array.from(doc.head.querySelectorAll('style'));
  for (let i = headStyles.length - 1; i >= 0; i--) {
    doc.body.insertBefore(headStyles[i], doc.body.firstChild);
  }

  // Stash each img's src before the attribute sweep strips it, so scrub() can
  // restore the ones that are inline image data.
  doc.body.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (SAFE_IMG_SRC.test(src)) img.setAttribute('data-wr-src', src);
  });

  scrub(doc.body);
  return doc.body.innerHTML;
}
