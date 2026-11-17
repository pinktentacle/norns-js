// The `buffer` module, for anything fengari reaches through
// `require("buffer")` rather than through the global. The global is shimmed
// separately in index.html, because `lauxlib.js:905` and `lbaselib.js:115`
// use the bare name and a module alias cannot reach those.
//
// A plain object rather than a subclass of Uint8Array: Buffer's static `from`
// has a wider signature than Uint8Array's and extending it fails to
// typecheck, which is a fair complaint — what fengari wants is a factory, not
// a subclass.
const encoder = new TextEncoder();

function from(value: ArrayLike<number> | Iterable<number> | string | ArrayBuffer): Uint8Array {
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return Uint8Array.from(value as Iterable<number>);
}

function alloc(size: number): Uint8Array {
  return new Uint8Array(size);
}

function concat(list: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(list.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of list) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

function isBuffer(v: unknown): boolean {
  return v instanceof Uint8Array;
}

export const Buffer = { from, alloc, allocUnsafe: alloc, concat, byteLength, isBuffer };
export default { Buffer };
