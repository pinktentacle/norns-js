// E5-24 — `_norns.osc_send`.
//
// `core/osc.lua:33` calls it as `osc_send(to, path, args)` where `to` is the
// table `{host, port}` and `args` is a sequence. weaver.cc:1558-1588 checks
// that `to` has exactly two entries and that both are strings, and raises an
// argument error otherwise — a script that passes a number for the port is
// told so on hardware, and should be told so here.

import type { NornsRegistry } from "../norns/registry.js";
import type { OscRemote } from "./remote.js";

export interface OscRegisterOptions {
  /** Null when no relay was configured: see `remote.ts` for why that is a state. */
  readonly remote: OscRemote | null;
  readonly log?: (line: string) => void;
}

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
    const values = (Array.isArray(args) ? args : []).filter(
      (a): a is number | string => typeof a === "number" || typeof a === "string",
    );
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
