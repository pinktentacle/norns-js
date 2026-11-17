// E5-10 — crow and serial, failing honestly.
//
// Neither is implemented, and this is what that should look like.
//
// WHY NOT. crow is a USB CDC serial device and matron talks to it with
// line-based Lua over a tty (`core/crow.lua:44` splits incoming lines on a
// separator and `crow_send` writes a command string). The browser's
// equivalent is Web Serial, and it is genuinely capable of this — so the gap
// here is work, not impossibility. Two things make it a story of its own
// rather than a detail of this one:
//
//   1. Web Serial requires `navigator.serial.requestPort()`, which needs a
//      user gesture and shows a device picker. There is nowhere in norns'
//      own UI for that to happen; it needs a button, which means it needs a
//      place in SYSTEM > DEVICES that upstream does not have.
//   2. crow is not a byte pipe. `norns.crow` drives a REPL — it sends Lua
//      source, reads `^^` event lines back, and `core/crow/*` is a protocol
//      implementation on top. Opening the port is the small half.
//
// `serial.lua` is the general case of the same thing: a handler registry
// matched on USB vendor and product, which Web Serial exposes through
// `getInfo()`. The same two obstacles apply.
//
// WHAT HAPPENS INSTEAD. A script calling `crow.output[1].volts = 5` never
// reaches here: `norns.crow.send` checks `norns.crow.dev` first, and with no
// crow attached it returns without calling `_norns.crow_send`. So reaching
// this code at all means a script held a device handle from somewhere, which
// is worth one clear line in the log rather than a silent return.
//
// IT COUNTS RATHER THAN REPEATS. A crow script sends on every encoder turn;
// a line per call would bury everything else in the log within seconds.

import type { NornsRegistry } from "../norns/registry.js";

export interface SerialRegisterOptions {
  readonly log?: (line: string) => void;
}

export interface SerialStats {
  crowSends: number;
  serialSends: number;
}

const CROW_WHY =
  "crow is not attached (Web Serial could carry it — E5-10 explains what that needs)";
const SERIAL_WHY =
  "no serial device is attached (Web Serial could carry one — E5-10 explains what that needs)";

export function registerSerial(
  registry: NornsRegistry,
  opts: SerialRegisterOptions = {},
): SerialStats {
  const log = opts.log ?? (() => {});
  const stats: SerialStats = { crowSends: 0, serialSends: 0 };
  const announced = new Set<string>();

  /** One full explanation, then silence with a count behind it. */
  const sayOnce = (what: string, why: string): void => {
    if (announced.has(what)) return;
    announced.add(what);
    log(`${what}: ${why}. Further calls are counted, not logged.`);
  };

  registry.implement("crow_send", (_dev, cmd) => {
    stats.crowSends++;
    // matron's `_crow_send` takes a string and writes it to the tty.
    // Anything else is the script's bug, and naming it is more use than a
    // generic "crow is missing".
    if (typeof cmd !== "string") {
      log(`crow_send: expected a string command, got ${typeof cmd}`);
      return;
    }
    sayOnce("crow_send", CROW_WHY);
  });

  registry.implement("serial_send", (_dev, data) => {
    stats.serialSends++;
    if (typeof data !== "string") {
      log(`serial_send: expected a string, got ${typeof data}`);
      return;
    }
    sayOnce("serial_send", SERIAL_WHY);
  });

  return stats;
}
