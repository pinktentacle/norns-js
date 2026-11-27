// E5-24 — `_norns.osc_send`.
//
// `core/osc.lua:33` calls it as `osc_send(to, path, args)` where `to` is the
// table `{host, port}` and `args` is a sequence. weaver.cc:1558-1588 checks
// that `to` has exactly two entries and that both are strings, and raises an
// argument error otherwise — a script that passes a number for the port is
// told so on hardware, and should be told so here.

import type { NornsRegistry } from "../norns/registry.js";
import type { OscRemote } from "./remote.js";
import { OscFloat } from "../engine/osc.js";

/** One argument as matron's `_osc_send` writes it (E9-274). */
export type OscOut = string | boolean | null | OscFloat;

export interface OscRegisterOptions {
  /** Null when no relay was configured: see `remote.ts` for why that is a state. */
  readonly remote: OscRemote | null;
  /**
   * E9-239 — a message for a program on THIS norns: sclang (57120),
   * scsynth (57110) or matron itself (10111). True when it was delivered.
   * E9-274 — with the arguments as matron types them: every number a float
   * (`OscFloat`), a boolean T or F, nil N.
   */
  readonly local?: (port: number, path: string, args: OscOut[]) => boolean;
  readonly log?: (line: string) => void;
}

/** The names a norns answers to as itself. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|::1)$/i;

export function registerOsc(registry: NornsRegistry, opts: OscRegisterOptions): void {
  const log = opts.log ?? ((): void => {});
  /** Said once. A sequencer sending clock would otherwise say it every tick. */
  let warned = false;

  registry.implement("osc_send", (to, path, args) => {
    const addr = Array.isArray(to) ? to : [];
    const host = addr[0];
    const port = addr[1];
    if (typeof host !== "string" || (typeof port !== "string" && typeof port !== "number")) {
      // Upstream raises `luaL_argerror`. Raising from here would need a raw
      // implementation and would take down a script for a mistake it can do
      // nothing about in this environment; the message is the useful half.
      log("osc_send: address should be a table in the form {host, port}");
      return;
    }
    const p = Number(port);
    if (!Number.isFinite(p)) {
      log(`osc_send: ${String(port)} is not a port`);
      return;
    }
    const where = `${host}:${p}`;
    const raw: unknown[] = Array.isArray(args) ? args : [];
    const values = raw.filter((a): a is number | string => typeof a === "number" || typeof a === "string");
    // E9-274 — AS weaver.cc's `_osc_send` TYPES THEM: a number is
    // `lo_message_add_float` whatever its value, a boolean `add_true` /
    // `add_false`, nil `add_nil`, a string a string. Only numbers and
    // strings went through, so a boolean simply vanished: hs010's voice
    // sends {note, vel, forceslide} and its SuperCollider half got two
    // arguments and nil for the third. A table or a function is an error
    // on hardware (`invalid osc argument type`) and is left out here.
    const typed: OscOut[] = [];
    for (const a of raw) {
      if (typeof a === "number") typed.push(new OscFloat(a));
      else if (typeof a === "string" || typeof a === "boolean") typed.push(a);
      else if (a === null || a === undefined) typed.push(null);
    }
    // E9-239 — LOCALHOST IS NOT THE NETWORK. On a norns, `osc.send` to
    // localhost:57120 is how a mod or an nb voice talks to its own
    // SuperCollider half: nb_smpKit loads and triggers its samples that way.
    // Here every send needed a relay, so those went nowhere and the voice
    // was silent; the three programs on this "machine" are in this page.
    if (LOCAL_HOST.test(host) && opts.local?.(p, String(path ?? ""), typed)) return;
    if (!opts.remote) {
      if (!warned) {
        warned = true;
        log(
          `osc_send: no relay, so ${String(path)} to ${where} went nowhere. ` +
            "A browser cannot open a UDP socket; run `node spike/osc/relay.mjs` " +
            "and reload with ?osc-relay=ws://localhost:7777",
        );
      }
      return;
    }
    opts.remote.send(host, p, String(path ?? ""), values);
  });
}
