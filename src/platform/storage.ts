// Browser replacement for Warroom's Electron `storage.read` / `storage.write`
// IPC pair. Same contract: a flat key → JSON-value store, reads that never
// throw, and writes that are ordered per key.
//
// IndexedDB rather than localStorage: a real flow is a few hundred KB of cell
// HTML and a debater can have dozens of them, which blows past localStorage's
// ~5MB budget. IndexedDB is also async, which matches the IPC shape the flow
// components were already written against, so nothing upstream had to change.
//
// Writes are chained per key (mirroring main.ts's `writeChains`) and a read
// waits for that key's pending write, so a read-after-write inside the same
// tick sees the value that was just written rather than the one before it.

const DB_NAME = 'policy-flow';
const DB_VERSION = 1;
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the local database.'));
    req.onblocked = () => reject(new Error('Another tab is upgrading the local database. Close it and reload.'));
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Local database request failed.'));
  }));
}

// One promise chain per key, so two writes to the same key can't interleave and
// land out of order. Failures are swallowed into the chain (never rejecting it)
// so one bad write doesn't wedge every later write to that key.
const writeChains = new Map<string, Promise<void>>();

export function writeKey(name: string, data: unknown): Promise<void> {
  const prev = writeChains.get(name) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => (data === null || data === undefined
      ? tx('readwrite', (s) => s.delete(name)).then(() => undefined)
      : tx('readwrite', (s) => s.put(data, name)).then(() => undefined)));
  writeChains.set(name, next.catch(() => undefined));
  return next;
}

export async function readKey<T = any>(name: string): Promise<T | null> {
  const pending = writeChains.get(name);
  if (pending) await pending.catch(() => undefined);
  try {
    const v = await tx<T | undefined>('readonly', (s) => s.get(name));
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}

export async function listKeys(): Promise<string[]> {
  try {
    const keys = await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
    return keys.map(String);
  } catch {
    return [];
  }
}

/** Flush every in-flight write. Used before a page unload and before an export. */
export async function flushWrites(): Promise<void> {
  await Promise.all([...writeChains.values()].map((p) => p.catch(() => undefined)));
}

/** Wipe every locally stored flow. Used by Settings → clear local data. */
export async function clearAll(): Promise<void> {
  await flushWrites();
  writeChains.clear();
  await tx('readwrite', (s) => s.clear());
}
