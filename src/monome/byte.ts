// How matron stores an LED level, and how libmonome puts it on the wire.
//
// These two steps are usually described as one, and they are not — which is
// the whole of `research/arc-design.md` §5.
//
// `dev_monome_grid_set_led` and `dev_monome_arc_set_led` both end with
//
//     md->data[...] = val;    // val is int8_t, data is uint8_t
//
// with NO masking. So an absolute write of 16 leaves 16 in the buffer. The
// `& 0x0F` happens later, in libmonome, when the quad is packed into nybbles
// for the wire — which is why `g:led(x, y, 16)` lights the LED at ZERO while
// the buffer holds 16, and a relative write after it reads 16.
//
// Masking at store time gives the same LED and a different buffer, and the
// difference shows the moment a script writes an absolute value above 15 and
// then a relative one.

/**
 * The narrowing a `uint8_t data[]` gets from an `int8_t val`.
 *
 * Two steps, both of them real: the argument is `int8_t`, so 200 arrives as
 * -56; the array is `uint8_t`, so -56 is stored as 200. The round trip is
 * the identity on 0..255 and folds anything else into it, which is what a C
 * compiler does here and what a script that writes 300 gets.
 */
export function narrowLevel(v: number): number {
  const i = Math.trunc(v) | 0;
  return ((i << 24) >> 24) & 0xff;
}

/** `clamp_range(x, 0, 15)`, which is what a RELATIVE write gets. */
export function clamp15(v: number): number {
  return v > 15 ? 15 : v < 0 ? 0 : v;
}

/** What libmonome packs into a nybble on the wire. */
export function wireLevel(v: number): number {
  return v & 0x0f;
}

/**
 * Lua truthiness for `rel`.
 *
 * `rel` reaches matron as `lua_toboolean`, and in Lua **`0` is true**. A
 * script passing `0` meaning "no" gets relative mode, on hardware and here.
 * The same trap applies to the arc, and NOT to `midi_clock_receive`, which
 * is `lua_tointeger` — see `src/midi/register.ts`.
 */
export function luaTruthy(v: unknown): boolean {
  return v !== null && v !== undefined && v !== false;
}
