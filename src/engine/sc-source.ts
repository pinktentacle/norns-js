// E9-66 — the three community classes that stopped sclang from booting.
//
// A `.sc` a script brings is compiled into the class library at startup, and
// the class library compiles as ONE unit: a single bad file does not fail by
// itself, it takes the whole interpreter with it. No sclang means no server,
// no engine and no sound — for every script, not just the one that shipped
// the file. That is why this module exists: three installed scripts each hit
// a different wall, and two of them are repairable in the source.
//
// Measured, one file at a time, in a fresh interpreter:
//
//   lissadron/lib/Engine_Lissadron.sc
//     Ends with `/*` and no `*/` — a block comment opened at the bottom of
//     the file and never closed. It is the last thing in the file, so on
//     hardware it is invisible: sclang's lexer reaches EOF inside a comment
//     and... crashes. `worker sent an error! Uncaught 10233416`, during
//     "Compiling directory '/sc/SCClassLibrary'", with no file named. A
//     four-line class ending in `/*` reproduces it exactly.
//
//   sway/lib/Norns_Sway.sc
//     ONE U+FEFF, at line 21, between a tab and `SynthDef`. A byte-order
//     mark that an editor wrote into the middle of the file. sclang says
//     "an unknown error has occurred right here!" and points at the line —
//     which is as much as it can say, because the character is invisible —
//     and then the same crash.
//
//   pirate-radio/lib/Mp3.sc
//     NOT repairable here, and not a crash: `MP3*initClass` runs
//     `("which" + execname).unixCmdGetStdOut` to find `lame`, `curl` and
//     `oggdec`. There is no fork in wasm, so `_FileReadLine` fails, the
//     error escapes `Class.initClassTree(Object)`, the class tree never
//     finishes initialising and sclang never says it is ready. The repair
//     is a `SystemOverwrites` override of `String:unixCmdGetStdOut` — see
//     INLINE_OVERRIDES in `host.ts`, beside the one norns already needs for
//     the same reason.
//
// Both repairs below are additive: a file that needs neither comes back
// character for character, and `repairs` is empty.

/**
 * E9-68 — ONE-LINE CORRECTIONS, and the bar for being in this list.
 *
 * Everything else in this file is LEXICAL: a stray character, a comment
 * nobody closed. This is the other kind, and it is deliberately a list of
 * exact strings rather than a rule, because there is no rule — each entry
 * is one line of somebody else's code that was read, understood and
 * measured before and after.
 *
 * To be in here a line must be ALL of:
 *
 *   1. broken everywhere, not just here. Not a thing norns has that a
 *      browser does not — that is a job for an override in `host.ts`, and
 *      `Pipe` is one. A line that no SuperCollider anywhere will build.
 *   2. unambiguous. Not "what did the author probably want" but "there is
 *      exactly one thing this can mean", shown from the rest of the file.
 *   3. fatal. The script does not work without it.
 *   4. measured. The script runs afterwards, and the measurement is
 *      written down.
 *
 * And it is applied ONLY when the exact text is still there, so the day
 * the repository fixes it, this quietly stops firing.
 *
 * It is said in the log every time, with the file name. A build that
 * silently rewrites what somebody installed would be worse than one that
 * refuses to.
 */
interface KnownBad {
  /** The end of the staged path, e.g. `splnkr/lib/Engine_Splnkr.sc`. */
  readonly file: string;
  readonly from: string;
  readonly to: string;
  /** What the log says after the file name. */
  readonly why: string;
}

const KNOWN_BAD: readonly KnownBad[] = [
  {
    // `Engine_Splnkr.alloc` has, eighteen lines apart:
    //
    //     # freq, hasFreq = Tartini.kr(wet);
    //     freq = Clip.ar(freq, 0.midicps, 127.midicps);
    //     SendReply.kr(Impulse.kr(10), '/triggerFreqPoll', freq);
    //
    // `Tartini.kr` is control rate, and `InRange:checkInputs` — which
    // `Clip` inherits — refuses an audio-rate UGen whose first input is
    // not audio rate. So the SynthDef does not build, `alloc` dies with
    // "Clip first input is not audio rate: an OutputProxy control", the
    // engine registers NOT ONE of its thirty commands, and `splnkr` dies
    // in `init` at `lib/envelope.lua:206` on `engine.set_numSegs` being
    // nil. Eighteen lines of grid interface, and no engine behind it.
    //
    // Unambiguous because `freq` has three uses in the whole file and the
    // other two are control rate: it is made by `Tartini.kr` and consumed
    // by `SendReply.kr`. Audio rate is not merely wrong here, it is the
    // one rate `freq` cannot be.
    //
    // Broken everywhere: this is sclang's own rate check, not a wasm
    // limit, and it has been in SuperCollider far longer than this file.
    // The line arrived with "reenable amp/freq detection" on 2021-12-30
    // and `main` has not been touched since 2022-01-04, so it has been
    // like this for four years.
    //
    // Measured after: 30 commands registered, init done, 1143 pixels, 21
    // grid keys lit.
    file: "splnkr/lib/Engine_Splnkr.sc",
    from: "Clip.ar(freq, 0.midicps, 127.midicps)",
    to: "Clip.kr(freq, 0.midicps, 127.midicps)",
    why:
      "Clip.ar on a control-rate signal, which no SuperCollider will build; " +
      "every use of `freq` in the file is control rate",
  },
];

/** A byte-order mark. Legal at the start of a file; lethal anywhere else. */
const BOM = "\uFEFF";

export interface ScSource {
  /** The source to compile — the original, unless something was repaired. */
  readonly text: string;
  /** One line per repair, for the log. Empty when the file was already fine. */
  readonly repairs: readonly string[];
}

/**
 * How deep in block comments the file ENDS.
 *
 * Counting the opens and the closes with a regex gets lissadron right and
 * lies about everything else. An opener inside a string literal is not a
 * comment; a closer inside a line comment does not close anything; and
 * SuperCollider's block comments NEST, so two opens need two closes. This
 * is a scanner rather than a pattern for those three reasons.
 *
 * `$x` is a character literal and the one that matters here: `$"` appears in
 * Mp3.sc, and a scanner that takes it for the start of a string reads the
 * rest of the file inside one.
 */
export function blockCommentDepth(s: string): number {
  let depth = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (depth > 0) {
      if (c === "/" && s[i + 1] === "*") { depth++; i += 2; continue; }
      if (c === "*" && s[i + 1] === "/") { depth--; i += 2; continue; }
      i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") { depth = 1; i += 2; continue; }
    // A character literal: `$a`, and `$\t` which is three.
    if (c === "$") { i += s[i + 1] === "\\" ? 3 : 2; continue; }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n) {
        if (s[i] === "\\") { i += 2; continue; }
        if (s[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    i++;
  }
  return depth;
}

/**
 * The source sclang should be given, and what had to be changed to get it.
 *
 * `name` is only ever used in the messages — it is what the log prints so the
 * person reading it knows WHICH script shipped the file.
 */
export function repairScSource(name: string, src: string): ScSource {
  const repairs: string[] = [];
  let text = src;

  const boms = text.split(BOM).length - 1;
  if (boms > 0) {
    text = text.split(BOM).join("");
    repairs.push(
      `${name}: removed ${boms} stray byte-order mark${boms === 1 ? "" : "s"} ` +
        `(U+FEFF), which sclang cannot lex`,
    );
  }

  const depth = blockCommentDepth(text);
  if (depth > 0) {
    if (!text.endsWith("\n")) text += "\n";
    text += "*/\n".repeat(depth);
    repairs.push(
      `${name}: closed ${depth} block comment${depth === 1 ? "" : "s"} left ` +
        `open at the end of the file, which crashes sclang's compiler`,
    );
  }

  for (const bad of KNOWN_BAD) {
    if (!name.endsWith(bad.file)) continue;
    if (!text.includes(bad.from)) continue;
    text = text.split(bad.from).join(bad.to);
    repairs.push(`${name}: ${bad.why}`);
  }

  return { text, repairs };
}
