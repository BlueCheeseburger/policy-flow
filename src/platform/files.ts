// A browser stand-in for Electron's file dialogs.
//
// The flow components were written against a main process that handed back
// filesystem PATHS and later re-read those paths on demand. A web page has no
// paths, so instead every picked or dropped File is parked in a registry and
// the components get back an opaque handle that looks and behaves like a path
// ("blob:af-3/1AC Warming.docx"). Everything downstream — Auto Flow's re-read
// for card bodies, Analyze Round's doc list — resolves the handle instead of
// touching a disk, and the component code did not have to change shape.
//
// The registry is per-page-load. That is the honest lifetime: a File object is
// only valid while the page that picked it is alive, so a handle from a
// previous session must not silently resolve to the wrong bytes.

const registry = new Map<string, File>();
let seq = 0;

export function registerFile(file: File): string {
  const handle = `blob:af-${++seq}/${file.name}`;
  registry.set(handle, file);
  return handle;
}

export function resolveFile(handle: string): File | null {
  return registry.get(handle) ?? null;
}

export function fileNameOf(handle: string): string {
  return registry.get(handle)?.name ?? handle.split('/').pop() ?? handle;
}

/** Accept an extension list the way the Electron dialog filters did. */
function accepts(exts: string[]): string {
  return exts.map((e) => `.${e.replace(/^\./, '')}`).join(',');
}

function matchesExt(name: string, exts: string[]): boolean {
  const lower = name.toLowerCase();
  return exts.some((e) => lower.endsWith(`.${e.replace(/^\./, '').toLowerCase()}`));
}

/** Open the OS file picker. Resolves to handles, or [] if the user cancelled. */
export function openFiles(exts: string[], multiple = true): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = accepts(exts);
    input.style.display = 'none';
    let settled = false;
    const finish = (handles: string[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(handles);
    };
    input.addEventListener('change', () => {
      finish(Array.from(input.files ?? []).map(registerFile));
    });
    // A cancelled picker fires no 'change' in most browsers. 'cancel' is
    // supported in current Chrome/Firefox/Safari; the focus fallback covers
    // anything older so the caller is never left waiting on a dead promise.
    input.addEventListener('cancel', () => finish([]));
    window.addEventListener('focus', () => setTimeout(() => finish([]), 500), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/** Filter a drop's FileList down to the wanted extensions and register them. */
export function resolveDroppedFiles(files: FileList | File[], exts: string[]): string[] {
  return Array.from(files).filter((f) => matchesExt(f.name, exts)).map(registerFile);
}

export async function readFileBytes(handle: string): Promise<{ ok: boolean; base64?: string; error?: string }> {
  const file = resolveFile(handle);
  if (!file) return { ok: false, error: 'That file is no longer available — pick it again.' };
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
      s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + chunk)) as any);
    }
    return { ok: true, base64: btoa(s) };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Could not read the file.' };
  }
}

/**
 * Hand the user a file to save. A page cannot write to disk, so this is a
 * download — the browser decides where it lands.
 */
export function saveBase64(base64: string, fileName: string, mime: string): void {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next turn — revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
