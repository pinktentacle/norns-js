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

/**
 * How many `/d_recv` acknowledgements this packet will produce.
 *
 * Every `/d_recv` in a bundle gets its own `/done`, wherever it sits in
 * the bundle -- so this counts them all, not just the first message.
 */
const defsIn = (m: Decoded | null): number => {
  if (m === null) return 0;
  if (m.address !== undefined) return m.address === "/d_recv" ? 1 : 0;
  return (m.bundle ?? []).filter((x) => x.address === "/d_recv").length;
};

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
  return { matron: null, hasSync, defs: defsIn(msg) };
}

/** For the server, nothing to wait for and nothing to count. */
const SERVER: LangRoute = Object.freeze({ matron: null, hasSync: false, defs: 0 });

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
 *    `undefined` fail the same three tests.
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
  if (first === 0) return SERVER;
  if (first !== SLASH) return routeByDecoding(bytes);
  let end = 1;
  while (end < bytes.length && bytes[end] !== 0) end++;
  let addr = "/";
  for (let i = 1; i < end; i++) addr += String.fromCharCode(bytes[i]!);
  if (addr === "/sync" || addr === "/d_recv" || toMatron(addr)) return routeByDecoding(bytes);
  return SERVER;
}
