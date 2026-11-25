// E9-222 — does an engine listen to the audio input?
//
// Reported from a Pixel as "no sound in leslie, but maybe I misunderstood".
// leslie is a rotary-speaker EFFECT: its README asks for "a stereo (or
// mono) source patched into the audio inputs", and it makes no sound of
// its own. In a browser the input is off until somebody turns it on, so
// leslie loaded, drew its rotors, answered every key and stayed silent —
// and nothing said why. E9-173 says it for a looper, but only when SOFTCUT
// asks for the input; an engine reads it inside SuperCollider, where crone
// never sees the question.
//
// So the engine's own source is read. A CroneEngine gets the input as
// `context.in_b`; a few engines use `SoundIn` directly. Either, anywhere in
// the script's SuperCollider files — an engine often builds its SynthDefs
// in a second class beside the `Engine_` one.
//
// This says only that the engine CAN hear the input, not that it needs it:
// dronecaster reads it to record and plays its drones without it. That is
// why the page says so only once a script has been silent for a while
// (see `main.ts`), not the moment the engine loads.

import type { Vfs } from "../fs/vfs.js";

const CODE = "/home/we/dust/code";
const READS_INPUT = /\bin_b\b|\bSoundIn\s*\.\s*ar\b/;

/** The `.sc` files of the script that defines `Engine_<name>`, or none. */
function scriptClassFiles(vfs: Vfs, engine: string): string[] {
  const defines = new RegExp(`^\\s*Engine_${engine.replace(/[^A-Za-z0-9_]/g, "")}\\s*:`, "m");
  const all = vfs.walk(CODE).filter((p) => p.endsWith(".sc"));
  const home = all.find((p) => defines.test(vfs.readText(p) ?? ""));
  if (home === undefined) return [];
  const script = home.split("/").slice(0, 6).join("/") + "/"; // /home/we/dust/code/<script>/
  return all.filter((p) => p.startsWith(script));
}

/** True when the engine's script reads the audio input anywhere in its classes. */
export function engineReadsInput(vfs: Vfs, engine: string): boolean {
  if (engine === "" || engine === "None") return false;
  return scriptClassFiles(vfs, engine).some((p) => READS_INPUT.test(stripComments(vfs.readText(p) ?? "")));
}

/** `//` and block comments out, so a commented-out SoundIn does not count. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
