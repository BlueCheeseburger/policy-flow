// Harden localStorage so a failing read or write can never crash a click handler,
// a render, or module initialization. In this Electron app localStorage is backed
// by the app's own partition and is virtually always available, but a corrupted
// profile, a disabled storage partition, or (in the browser fallback) private
// mode / quota can make setItem/getItem throw synchronously. There are ~40
// setItem call sites across the renderer, none of which expect a throw, so we make
// the whole surface best-effort in one place instead of wrapping each one.
//
// Imported for its side effect as the VERY FIRST import in main.tsx, so the patch
// is installed before any other module (e.g. the app store) reads localStorage at
// evaluation time.

try {
  const proto = Storage.prototype;

  const origSet = proto.setItem;
  proto.setItem = function (key: string, value: string) {
    try {
      return origSet.call(this, key, value);
    } catch {
      /* best-effort: dropping a preference write is better than crashing */
    }
  };

  const origGet = proto.getItem;
  proto.getItem = function (key: string) {
    try {
      return origGet.call(this, key);
    } catch {
      return null;
    }
  };

  const origRemove = proto.removeItem;
  proto.removeItem = function (key: string) {
    try {
      return origRemove.call(this, key);
    } catch {
      /* best-effort */
    }
  };
} catch {
  /* Storage entirely unavailable — call sites already tolerate null/no-ops. */
}

export {};
