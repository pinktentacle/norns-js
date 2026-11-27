// E9-267 — the programs some catalogue scripts install for themselves.
//
// None of these ships with norns. A script downloads or builds an aarch64
// binary and runs it, and a browser can run no binary at all, so each one
// was refused by name. Three are small enough to be what they are, here:
//
//   sendosc        one OSC message (schollz/sendosc): sampswap, makebreakbeat
//   oscnotify      OSC when a file under a folder is written
//                  (schollz/oscnotify): amenbreak, graintopia, zxcvbn
//   audiowaveform  peaks and pictures of a sound file (src/fs/audiowaveform.ts)
//
// Each follows its own source: sendosc's flags, defaults and argument
// order (ints, then floats, then strings, whatever the command line said);
// oscnotify's 500 ms debounce, its one string argument, and the folders it
// leaves alone. Where the original would wait for ever — sendosc with
// `--recv-port`, waiting for a `/quit` nothing here will send — the run is
// refused and says so, instead of pretending it was answered.
//
// AND A PROCESS TABLE, because the scripts manage these as processes: the
// `run.sh` that starts oscnotify first kills any running one with
// `ps -ef | grep 'oscnotify' | … | xargs -r kill -9`, and a script's
// cleanup is `pkill -f oscnotify`. Both are answered from the programs the
// page itself started — which is every process there is here — so `pkill`
// of something never started finds nothing and exits 1, as it would.

import { basename, currentCwd, dirname, normalise, withCwd, type Vfs } from "./vfs.js";
import type { ShellResult } from "./shell.js";
import { parseSoundHeader } from "./wav-header.js";
import { runSox, soxReady, soxUnavailable } from "./sox.js";
import { luaCommand, type LuaProcessHost } from "./lua-cli.js";
import { luaReady } from "../lua/lua.js";
import {
  HELP,
  VERSION,
  decodeDat,
  decodeWav16,
  floatToPcm16,
  kindOf,
  parseAwfArgs,
  produce,
  type AwfArgs,
  type Pcm16,
  type Peaks,
} from "./audiowaveform.js";

/** What the page lends these programs. Set by main.ts; null in most tests. */
export interface ProgramHost {
  /**
   * One OSC message: "here" when a program on this norns took it (E9-239),
   * "relay" when the OSC relay sent it on, false when it went nowhere —
   * which is what UDP to a port nothing listens on does.
   */
  oscSend(host: string, port: number, path: string, args: ReadonlyArray<number | string>): "here" | "relay" | false;
  /** A sound file the shell cannot read itself (anything but WAV), at its own rate when known. */
  decodeAudio?(bytes: Uint8Array, sampleRate: number | null): Promise<{ sampleRate: number; channels: Float32Array[] } | null>;
  log?(line: string): void;
}

let host: ProgramHost | null = null;
export function setProgramHost(h: ProgramHost | null): void {
  host = h;
}

const said = new Set<string>();
/** A line for the log, once: a script asking every frame says it once. */
function sayOnce(line: string): void {
  if (said.has(line)) return;
  said.add(line);
  host?.log?.(line);
}

const OK = (out: string): ShellResult => ({ out, ok: true });
const NO = (refused: string): ShellResult => ({ out: "", ok: false, refused });
/** It ran and failed: a non-zero exit, not a refusal. */
const FAILED = (why: string): ShellResult => {
  sayOnce(why);
  return { out: "", ok: false, failed: true };
};

// --- processes ---------------------------------------------------------------

interface Process {
  readonly pid: number;
  /** argv[0]'s name, what `pkill` without -f matches. */
  readonly name: string;
  /** The whole command line, what `pkill -f` and `ps -ef` show. */
  readonly cmdline: string;
  readonly stop: () => void;
}
const processes = new Map<number, Process>();
let nextPid = 4000;

function spawn(name: string, cmdline: string, stop: () => void): number {
  const pid = nextPid++;
  processes.set(pid, { pid, name, cmdline, stop });
  return pid;
}

/** A process that ended by itself: it leaves the table, as a reaped child does. */
function reap(pid: number): void {
  processes.delete(pid);
}

function killWhere(test: (p: Process) => boolean): number {
  let n = 0;
  for (const p of [...processes.values()]) {
    if (!test(p)) continue;
    try {
      p.stop();
    } catch {
      /* stopping is best effort, like a signal */
    }
    processes.delete(p.pid);
    n++;
  }
  return n;
}

/** What is running, as `ps` would list it. */
export function runningPrograms(): Array<{ pid: number; cmdline: string }> {
  return [...processes.values()].map((p) => ({ pid: p.pid, cmdline: p.cmdline }));
}

/** Everything stops: for tests, and for a page that is going away. */
export function stopAllPrograms(): void {
  killWhere(() => true);
}

const matches = (pattern: string, s: string): boolean => {
  try {
    return new RegExp(pattern).test(s);
  } catch {
    return s.includes(pattern);
  }
};

// --- the command line --------------------------------------------------------

/** Words as sh splits them: quotes group and are removed, no expansion. */
export function shellWords(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: string | null = null;
  for (const ch of cmd) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
      continue;
    }
    cur += ch;
    inWord = true;
  }
  if (inWord) out.push(cur);
  return out;
}

/** `>/dev/null`, `2>&1` and friends say where output goes; there is nowhere else here. */
function dropRedirects(w: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const a = w[i]!;
    if (/^(\d?>|&>)\/dev\/null$/.test(a) || a === "2>&1") continue;
    if ((a === ">" || a === "1>" || a === "2>" || a === "&>") && w[i + 1] === "/dev/null") {
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Go's `flag` package: `-name value`, `--name value`, `-name=value`, stopping at the first operand. */
function goFlags(
  argv: readonly string[],
  spec: Readonly<Record<string, "string" | "int" | "list">>,
): { values: Map<string, string>; lists: Map<string, string[]>; error?: string } {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    if (!a.startsWith("-") || a === "-") break;
    const body = a.replace(/^--?/, "");
    const eq = body.indexOf("=");
    const name = eq >= 0 ? body.slice(0, eq) : body;
    const kind = spec[name];
    if (kind === undefined) return { values, lists, error: `flag provided but not defined: -${name}` };
    const value = eq >= 0 ? body.slice(eq + 1) : argv[++i];
    if (value === undefined) return { values, lists, error: `flag needs an argument: -${name}` };
    if (kind === "int" && !/^[+-]?(0x[0-9a-f]+|\d+)$/i.test(value)) {
      return { values, lists, error: `invalid value "${value}" for flag -${name}: parse error` };
    }
    if (kind === "list") lists.set(name, [...(lists.get(name) ?? []), value]);
    else values.set(name, value);
  }
  return { values, lists };
}

// --- sendosc -----------------------------------------------------------------

function sendosc(argv: readonly string[]): ShellResult {
  const f = goFlags(argv, {
    host: "string",
    port: "int",
    addr: "string",
    i: "list",
    f: "list",
    s: "list",
    "recv-host": "string",
    "recv-port": "int",
    "recv-addr": "string",
  });
  if (f.error !== undefined) return FAILED(`sendosc: ${f.error}`);
  const to = f.values.get("host") ?? "localhost";
  const port = Number(f.values.get("port") ?? "57120");
  const addr = f.values.get("addr") ?? "/osc/address";
  const args: Array<number | string> = [];
  // Its own order: every -i, then every -f, then every -s.
  for (const v of f.lists.get("i") ?? []) {
    if (!/^[+-]?\d+$/.test(v)) {
      // strconv.Atoi failed: printed, nothing sent, and still exit 0.
      sayOnce(`sendosc: error: strconv.Atoi: parsing "${v}": invalid syntax`);
      return OK("");
    }
    args.push(Number(v) | 0);
  }
  for (const v of f.lists.get("f") ?? []) {
    const n = Number(v);
    if (v.trim() === "" || !Number.isFinite(n)) {
      sayOnce(`sendosc: error: strconv.ParseFloat: parsing "${v}": invalid syntax`);
      return OK("");
    }
    args.push(n);
  }
  for (const v of f.lists.get("s") ?? []) args.push(v);
  const where = host?.oscSend(to, port, addr, args) ?? false;
  if (where === false) sayOnce(`sendosc: ${addr} to ${to}:${port} — nothing takes it here, so it went nowhere (as UDP does)`);
  const recvPort = Number(f.values.get("recv-port") ?? "-1");
  if (recvPort > 0) {
    return NO(
      `sendosc: sent ${addr}, but --recv-port ${recvPort} waits for a /quit that nothing here will send ` +
        "(the real one would wait for ever)",
    );
  }
  return OK("");
}

// --- oscnotify ---------------------------------------------------------------

function oscnotify(vfs: Vfs, argv: readonly string[], cmdline: string): ShellResult {
  const f = goFlags(argv, { host: "string", path: "string", port: "int", addr: "string" });
  if (f.error !== undefined) return FAILED(`oscnotify: ${f.error}`);
  const to = f.values.get("host") ?? "localhost";
  const port = Number(f.values.get("port") ?? "10111");
  const addr = f.values.get("addr") ?? "/oscnotify";
  const root = normalise(f.values.get("path") ?? ".", vfs.home).replace(/\/+$/, "") || "/";
  let changed = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = (): void => {
    timer = null;
    const where = host?.oscSend(to, port, addr, [changed]) ?? false;
    if (where === false) sayOnce(`oscnotify: ${addr} to ${to}:${port} went nowhere`);
  };
  const unwatch = vfs.watch((p) => {
    if (p !== root && !p.startsWith(root === "/" ? "/" : `${root}/`)) return;
    // It watches every folder under the path except those with ".git" in
    // their path, and only for writes: a removal is not a write.
    if (dirname(p).includes(".git")) return;
    if (!vfs.exists(p)) return;
    changed = p;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(send, 500);
  });
  spawn("oscnotify", cmdline, () => {
    unwatch();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  });
  return OK("");
}

// --- pkill, and the ps | grep | xargs kill of a run.sh -----------------------

function pkill(argv: readonly string[]): ShellResult {
  let full = false;
  const patterns: string[] = [];
  for (const a of argv) {
    if (a === "-f" || a === "--full") full = true;
    else if (/^-(\d+|[A-Z]+|SIG[A-Z]+)$/.test(a) || a.startsWith("--signal")) continue;
    else if (a.startsWith("-")) return NO(`pkill: ${a} is not known here`);
    else patterns.push(a);
  }
  if (patterns.length !== 1) return NO("pkill: one pattern");
  const n = killWhere((p) => matches(patterns[0]!, full ? p.cmdline : p.name));
  return n > 0 ? OK("") : { out: "", ok: false, failed: true };
}

/** `ps -ef | grep 'x' | grep -v grep | … | xargs -r kill -9` */
function psKill(cmd: string): ShellResult {
  const want: string[] = [];
  const not: string[] = [];
  for (const seg of cmd.split("|").slice(1)) {
    const w = shellWords(seg.trim());
    if (w[0] !== "grep") continue;
    if (w[1] === "-v" && w[2] !== undefined) not.push(w[2]);
    else if (w[1] !== undefined && !w[1].startsWith("-")) want.push(w[1]);
  }
  if (want.length === 0) return NO("ps | xargs kill without a grep for what to kill");
  killWhere((p) => want.every((x) => matches(x, p.cmdline)) && !not.some((x) => matches(x, p.cmdline)));
  // xargs -r with nothing to kill runs nothing, and the pipeline exits 0.
  return OK("");
}

// --- audiowaveform -----------------------------------------------------------

/** Outputs being made right now: amenbreak asks for the same picture every frame until it exists. */
const making = new Set<string>();

function audiowaveform(vfs: Vfs, argv: readonly string[], background: boolean): ShellResult {
  let a: AwfArgs;
  try {
    a = parseAwfArgs(argv);
  } catch (e) {
    return FAILED(`audiowaveform: ${(e as Error).message}`);
  }
  if (a.help) return OK(HELP);
  if (a.version) return OK(`${VERSION}\n`);
  if (a.input === undefined || a.output === undefined) return FAILED("audiowaveform: Missing input and output file names");
  const input = normalise(a.input, vfs.home);
  const output = normalise(a.output, vfs.home);
  const ik = kindOf(input);
  if (ik !== "dat" && ik !== "audio") return FAILED(`audiowaveform: Unknown file type: ${input}`);
  const ok = kindOf(output);
  if (ok !== "dat" && ok !== "png") return FAILED(`audiowaveform: Unknown file type: ${output} (only .dat and .png are made here)`);
  const args: AwfArgs = { ...a, input, output };
  // What a background job's failure looks like from here: the shell already
  // returned, the exit status is lost, and stderr goes to the log.
  const fail = (why: string): ShellResult => (background ? (sayOnce(why), OK("")) : FAILED(why));
  if (making.has(output)) return background ? OK("") : NO(`audiowaveform: ${basename(output)} is still being made`);
  // Its input is still being made by an earlier run: on a norns this one
  // would fail to open it and the script would ask again. Quietly the same.
  if (making.has(input)) return background ? OK("") : FAILED(`audiowaveform: Failed to read file: ${input}`);
  const bytes = vfs.read(input);
  if (bytes === null && vfs.remoteAt(input) === null) {
    return fail(`audiowaveform: Failed to read file: ${input}: No such file or directory`);
  }
  // Synchronously when it can be: a .dat, or a WAV that is already here.
  if (bytes !== null) {
    let src: { pcm?: Pcm16; peaks?: Peaks } | null = null;
    try {
      if (ik === "dat") src = { peaks: decodeDat(bytes) };
      else {
        const pcm = decodeWav16(bytes);
        if (pcm !== null) src = { pcm };
      }
      if (src !== null) {
        vfs.write(output, produce(args, src));
        return OK("");
      }
    } catch (e) {
      return fail(`audiowaveform: ${input}: ${(e as Error).message}`);
    }
  }
  // Otherwise the browser decodes it, which takes a moment: a FLAC (all of
  // amenbreak's breaks), an mp3, or a file not downloaded yet.
  if (ik === "audio" && host?.decodeAudio === undefined) {
    return NO(`audiowaveform: ${basename(input)} needs the page's decoder, which is not here`);
  }
  making.add(output);
  void (async (): Promise<void> => {
    try {
      const b = bytes ?? (await vfs.fetchRemote(input));
      if (b === null) throw new Error("Failed to read file");
      let src: { pcm?: Pcm16; peaks?: Peaks };
      if (ik === "dat") src = { peaks: decodeDat(b) };
      else {
        const wav = decodeWav16(b);
        if (wav !== null) src = { pcm: wav };
        else {
          const d = await host!.decodeAudio!(b, parseSoundHeader(b)?.sampleRate ?? null);
          if (d === null) throw new Error("could not decode it");
          src = { pcm: floatToPcm16(d.sampleRate, d.channels) };
        }
      }
      vfs.write(output, produce(args, src));
    } catch (e) {
      sayOnce(`audiowaveform: ${input}: ${(e as Error).message}`);
    } finally {
      making.delete(output);
    }
  })();
  return background
    ? OK("")
    : NO(`audiowaveform: ${basename(input)} is decoded in the background; ${basename(output)} appears when it is done`);
}

// --- sox -----------------------------------------------------------------------

/**
 * E9-275 — `sox` / `soxi`, the real program (src/fs/sox.ts). `mergeErr` is
 * a `2>&1` on the line: sox writes `stat` and its warnings to stderr, and
 * `sox f -n stat 2>&1 | grep Length` reads them from there.
 */
export function soxCommand(vfs: Vfs, name: string, argv: readonly string[], mergeErr: boolean): ShellResult {
  // E9-276: from a lua process, its working directory.
  const r = runSox(vfs, argv, name, currentCwd() ?? "/home/we");
  if (r === null) return NO(`${name}: ${soxUnavailable()}`);
  const out = mergeErr ? r.stdout + r.stderr : r.stdout;
  if (r.code !== 0) {
    const why = r.stderr.trim().split("\n")[0] ?? "";
    if (why !== "") sayOnce(why);
    return { out, ok: false, failed: true };
  }
  return OK(out);
}

/** What `command -v` and `which` answer for the programs here. */
export function programPath(name: string): string | null {
  if ((name === "sox" || name === "soxi") && soxReady()) return `/usr/bin/${name}`;
  // E9-276: norns has Lua 5.3 on the command line; the scripts take it for granted.
  if ((name === "lua" || name === "lua5.3") && luaReady()) return `/usr/bin/${name}`;
  return null;
}

// --- lua -------------------------------------------------------------------------

const luaHost: LuaProcessHost = {
  spawn: (name, cmdline, stop) => spawn(name, cmdline, stop),
  exit: (pid) => reap(pid),
  log: (line) => host?.log?.(line),
};

/** The programs a leading `cd X &&` may lead to: those that read relative paths. */
const CD_PROGRAMS = new Set(["lua", "lua5.3", "sox", "soxi"]);

// --- dispatch ----------------------------------------------------------------

/**
 * One of these programs, or null for the shell to go on. `background` is a
 * trailing `&`: the shell has already taken it off.
 */
export function runProgram(vfs: Vfs, cmd: string, background: boolean): ShellResult | null {
  if (/^ps\s/.test(cmd) && /\|\s*xargs\b[^|]*\bkill\b/.test(cmd)) return psKill(cmd);
  // E9-276 — `cd …/sampswap/lib/ && lua sampswap.lua …`: the program runs
  // from there. Only for the programs here that read relative paths; any
  // other `cd X && …` is the shell's, as before.
  {
    const cd = /^cd\s+('[^']*'|"[^"]*"|\S+)\s*&&\s*([\s\S]+)$/.exec(cmd);
    if (cd !== null) {
      const rest = cd[2]!.trim();
      const head = shellWords(rest)[0];
      if (head !== undefined && CD_PROGRAMS.has(basename(head)) && !/&&|\|\||;|\|/.test(rest)) {
        const dir = normalise(shellWords(cd[1]!)[0] ?? "", vfs.home);
        if (!vfs.isDir(dir)) return FAILED(`sh: 1: cd: can't cd to ${dir}`);
        return withCwd(dir, () => runProgram(vfs, rest, background));
      }
    }
  }
  let w = shellWords(cmd);
  if (w.some((x) => x === "|" || x === ";" || x === "&&" || x === "||")) return null;
  if (w[0] === "nohup") w = w.slice(1);
  w = dropRedirects(w);
  if (w.length === 0) return null;
  const name = basename(w[0]!);
  const argv = w.slice(1);
  switch (name) {
    case "sox":
    case "soxi":
      return soxCommand(vfs, name, argv, false);
    case "lua":
    case "lua5.3":
      return luaCommand(vfs, argv, background, w.join(" "), currentCwd() ?? "/home/we", luaHost);
    case "sendosc":
      return sendosc(argv);
    case "oscnotify":
      return oscnotify(vfs, argv, w.join(" "));
    case "audiowaveform":
      return audiowaveform(vfs, argv, background);
    case "pkill":
      return w[0] === "pkill" ? pkill(argv) : null;
    default:
      return null;
  }
}
