/**
 * E9-199 — WHERE A PACKET FROM sclang GOES, WITHOUT DECODING IT.
 *
 * sclang-wasm removed the concept of an address and a port, so everything
 * sclang sends leaves through one callback: traffic for the server and
 * traffic for matron, interleaved (ADR-04c). `host.ts` owns the
 * demultiplexer, and until now it answered three questions about every
 * packet by decoding the whole of it:
 *
 *     is it for matron?           the address, against a closed set
 *     does it carry a `/sync`?    the address, or any address in a bundle
 *     how many `/d_recv` in it?   the same
 *
 * Every argument was parsed to answer questions about an address. A
 * PolyPerc note leaves sclang as 132 bytes with twenty arguments, and
 * decoding it measured 1.85 us against 0.03 for reading its first bytes.
 *
 * AND MOST OF THE TRAFFIC HAS NO ADDRESS TO READ. `Synth.new` sends
 * `server.sendMsg(9, ...)`: scsynth accepts a command NUMBER in place of
 * the address string, four bytes beginning with a zero. `decode` reads
 * that as the empty string, and the empty string is not for matron, is
 * not `/sync` and is not `/d_recv` — so every note was fully decoded to
 * reach the same answer its first byte gives.
 *
 * THE OLD LOGIC IS KEPT, VERBATIM, AS `routeByDecoding`. It is what the
 * fast path falls back to for everything it does not recognise — a
 * bundle, a matron address, `/sync`, `/d_recv` — and it is what
 * `test/lang-route.test.ts` compares the fast path against, packet by
 * packet, over real traffic and over garbage. The claim is not "this is
 * equivalent, by argument"; it is "these two functions returned the same
 * thing for every packet tried", with the old one still in the tree to
 * be the judge.
 */

import { decode } from "./osc.js";

type OscArg = number | string | Uint8Array;

type Decoded = { address?: string; args?: OscArg[]; bundle?: Array<{ address: string }> };

export interface LangRoute {
  /** Set when the packet belongs to matron: the address and its arguments. */
  readonly matron: { address: string; args: OscArg[] } | null;
  /** A `/sync` is never held behind a `/d_recv`; see `host.ts`. */
  readonly hasSync: boolean;
  /** How many `/done` acknowledgements this packet will produce. */
  readonly defs: number;
}

/**
 * The matron-bound set is small and CLOSED, which is what makes the
 * router safe: anything else is the server's by definition, so a new
 * norns message cannot be silently swallowed — it would go to scsynth
 * and be ignored loudly rather than vanish.
 */
export const toMatron = (addr: string): boolean =>
  addr.startsWith("/crone/") ||
  addr.startsWith("/report/") ||
  addr === "/poll/data" ||
  addr === "/poll/value" ||
  // Added by this port, not by norns: with the port gone, a script's own
  // OSC needs somewhere to say where it was going. See
  // sc-overrides/SystemOverwrites/NornsJsOscPortOverride.sc.
  addr.startsWith("/norns-js/");

/** A bundle counts as whatever its first message is. */
const addressOf = (m: Decoded | null): string | undefined => m?.address ?? m?.bundle?.[0]?.address;

/** scsynth's command number for `/d_recv` (SC_OSC_Commands.h: `cmd_d_recv = 5`). */
const CMD_D_RECV = 5;
const BUNDLE = "#bundle\0";

/**
 * How many `/d_recv` acknowledgements this packet will produce.
 *
 * Every `/d_recv` in a bundle gets its own `/done`, wherever it sits in
 * the bundle -- so this counts them all, not just the first message.
 *
 * E9-246 — READ FROM THE BYTES, because a `/d_recv` can be a NUMBER. JITLib
 * sends its defs as command 5 inside bundles (`Ndef`, `NodeProxy`), and
 * scsynth acknowledges those with the same `/done /d_recv`. Counted by
 * address only, they were invisible: their `/done` then paid off another
 * def's wait, the barrier opened early, and a `Synth.new` reached the server
 * before its SynthDef — "SynthDef mic not found" in carter's delay, whose
 * 48 Ndefs went out beside its five defs.
 */
export function defsInPacket(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = (at: number, end: number): number => {
    if (end - at >= 8 && BUNDLE.split("").every((c, i) => bytes[at + i] === c.charCodeAt(0))) {
      let n = 0;
      let o = at + 16;
      while (o + 4 <= end) {
        const size = view.getInt32(o);
        if (size <= 0 || o + 4 + size > end) break;
        n += count(o + 4, o + 4 + size);
        o += 4 + size;
      }
      return n;
    }
    if (end - at >= 4 && bytes[at] === 0) return view.getInt32(at) === CMD_D_RECV ? 1 : 0;
    const name = "/d_recv";
    for (let i = 0; i < name.length; i++) if (bytes[at + i] !== name.charCodeAt(i)) return 0;
    return at + name.length < end && bytes[at + name.length] === 0 ? 1 : 0;
  };
  return count(0, bytes.length);
}

/** scsynth's command number for `/sync` (`cmd_sync = 52`). */
const CMD_SYNC = 52;

/**
 * E9-246 — does this packet hold nothing but `/d_recv` and `/sync`?
 *
 * Those two are ASYNCHRONOUS on the server: they go into its own FIFO and
 * are done in order, so a second one sent while the first is unfinished
 * cannot overtake it. Only a command that acts at once (`/s_new`,
 * `/n_set`, `/g_new`...) needs a def to be finished before it is sent.
 * Asked only while a def is outstanding, so it costs nothing on a note.
 */
export function onlyDefsAndSync(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const named = (at: number, end: number, name: string): boolean => {
    for (let i = 0; i < name.length; i++) if (bytes[at + i] !== name.charCodeAt(i)) return false;
    return at + name.length < end && bytes[at + name.length] === 0;
  };
  const check = (at: number, end: number): boolean => {
    if (end - at >= 8 && BUNDLE.split("").every((c, i) => bytes[at + i] === c.charCodeAt(0))) {
      let o = at + 16;
      let any = false;
      while (o + 4 <= end) {
        const size = view.getInt32(o);
        if (size <= 0 || o + 4 + size > end) return false;
        if (!check(o + 4, o + 4 + size)) return false;
        any = true;
        o += 4 + size;
      }
      return any && o === end;
    }
    if (end - at >= 4 && bytes[at] === 0) {
      const c = view.getInt32(at);
      return c === CMD_D_RECV || c === CMD_SYNC;
    }
    return named(at, end, "/d_recv") || named(at, end, "/sync");
  };
  return bytes.length > 0 && check(0, bytes.length);
}

/** The route as it was always worked out: decode everything, then ask. */
export function routeByDecoding(bytes: Uint8Array): LangRoute {
  let msg: Decoded | null = null;
  try {
    msg = decode(bytes) as unknown as Decoded;
  } catch {
    /* not decodable here; the server will deal with it */
  }
  const addr = addressOf(msg);
  if (addr && toMatron(addr)) {
    return { matron: { address: addr, args: msg?.args ?? [] }, hasSync: false, defs: 0 };
  }
  // `/sync` is never held; see `host.ts`. A bundle that CONTAINS a `/sync`
  // is not held either — `NetAddr.sync` sends the work and the `/sync`
  // together, so holding the bundle would hold the question with it.
  const hasSync = addr === "/sync" || (msg?.bundle?.some((m) => m.address === "/sync") ?? false);
  return { matron: null, hasSync, defs: defsInPacket(bytes) };
}

/** For the server, nothing to wait for and nothing to count. */
const SERVER: LangRoute = Object.freeze({ matron: null, hasSync: false, defs: 0 });
/** A SynthDef sent by number (E9-246): one `/done` to wait for. */
const ONE_DEF: LangRoute = Object.freeze({ matron: null, hasSync: false, defs: 1 });

const SLASH = 0x2f;

/**
 * The same route, reading only what decides it.
 *
 * TWO CASES ARE ANSWERED HERE and everything else is handed to
 * `routeByDecoding` untouched:
 *
 *  - FIRST BYTE ZERO. A command number, or nothing readable. `decode`
 *    gives the address as the empty string, or throws; either way the
 *    old logic arrives at `SERVER`, because the empty string and
 *    `undefined` fail the same three tests — except command 5, `/d_recv`
 *    by number, which both count (E9-246).
 *
 *  - FIRST BYTE A SLASH, and an address that is none of the ones
 *    anything asks about. Not a bundle, so there is one address and it
 *    is the whole answer; if `decode` would have thrown on the
 *    arguments, the old logic arrives at `SERVER` as well.
 *
 * THE ADDRESS IS COMPARED AS BYTES. `decode` reads it as UTF-8 and this
 * reads it one byte to a character, which differ for anything outside
 * ASCII — but every string compared against is ASCII, a UTF-8 decoder
 * can only produce an ASCII character from that same byte, and so a
 * prefix or an equality holds for one reading exactly when it holds for
 * the other.
 */
export function routeLangPacket(bytes: Uint8Array): LangRoute {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return routeByDecoding(bytes);
  const first = bytes[0];
  if (first === 0) return defsInPacket(bytes) === 1 ? ONE_DEF : SERVER;
  if (first !== SLASH) return routeByDecoding(bytes);
  let end = 1;
  while (end < bytes.length && bytes[end] !== 0) end++;
  let addr = "/";
  for (let i = 1; i < end; i++) addr += String.fromCharCode(bytes[i]!);
  if (addr === "/sync" || addr === "/d_recv" || toMatron(addr)) return routeByDecoding(bytes);
  return SERVER;
}
