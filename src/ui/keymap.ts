// E6-10 — the keyboard map, as data the user can change.
//
// It used to be a constant in `input-core.ts`, which was right while it was
// the only map there would ever be. It is a VALUE now: the default lives
// here, the session's copy lives in `settings.ts`, and the core reads
// whichever one it was handed. Nothing else about the input path changes --
// a remapped key is still just a code arriving at the same `handle`.
//
// WHY CODES AND NOT CHARACTERS. `e.code` is the physical key: `KeyQ` is the
// key where Q sits on a US keyboard, and it is the same key on AZERTY, where
// it prints A. `e.key` would move the binding with the layout, which sounds
// helpful until you remember what the map is FOR -- three columns of keys
// standing in for three encoders, left turning down and right turning up.
// The arrangement is spatial, so it has to be bound to positions. A user on
// AZERTY who wants A/Z/E rebinds them, which is the whole point of this file
// existing.

import type { Side } from "./input-core.js";

export interface Binding {
  readonly key?: Side;
  readonly enc?: Side;
  readonly dir?: -1 | 1;
}

/** Code (`e.code`) → what it does. */
export type Keymap = Readonly<Record<string, Binding>>;

/**
 * The nine things a norns panel can be told to do from a keyboard.
 *
 * An encoder is TWO actions, not one with a sign: the user binds a key to
 * "E2 down" and another to "E2 up", and a row in the editor that tried to
 * hold both would have to explain which half a key belongs to.
 */
export type ActionId =
  | "k1" | "k2" | "k3"
  | "e1-" | "e1+"
  | "e2-" | "e2+"
  | "e3-" | "e3+";

export interface Action {
  readonly id: ActionId;
  /** What the editor shows in the row. */
  readonly label: string;
  readonly binding: Binding;
}

export const ACTIONS: readonly Action[] = [
  { id: "k1", label: "K1", binding: { key: 1 } },
  { id: "k2", label: "K2", binding: { key: 2 } },
  { id: "k3", label: "K3", binding: { key: 3 } },
  { id: "e1-", label: "E1 −", binding: { enc: 1, dir: -1 } },
  { id: "e1+", label: "E1 +", binding: { enc: 1, dir: 1 } },
  { id: "e2-", label: "E2 −", binding: { enc: 2, dir: -1 } },
  { id: "e2+", label: "E2 +", binding: { enc: 2, dir: 1 } },
  { id: "e3-", label: "E3 −", binding: { enc: 3, dir: -1 } },
  { id: "e3+", label: "E3 +", binding: { enc: 3, dir: 1 } },
];

/**
 * The default map.
 *
 * Three columns of a QWERTY keyboard stand in for the three encoders, left
 * turning down and right turning up — q/w, a/s, z/x — so the arrangement is
 * learnable rather than arbitrary. Digits are the keys, left to right. Arrows
 * and Enter/Backspace/Shift are aliases for what people reach for untold.
 *
 * Note that several codes map to the SAME action, which is the reason holds
 * are tracked per code rather than per key: Shift and 1 are both K1, and
 * releasing one while the other is held must not tell norns the key came up.
 */
export const DEFAULT_KEYMAP: Keymap = {
  Digit1: { key: 1 },
  Digit2: { key: 2 },
  Digit3: { key: 3 },
  ShiftLeft: { key: 1 },
  ShiftRight: { key: 1 },
  Backspace: { key: 2 },
  Escape: { key: 2 },
  Enter: { key: 3 },
  Space: { key: 3 },

  KeyQ: { enc: 1, dir: -1 },
  KeyW: { enc: 1, dir: 1 },
  KeyA: { enc: 2, dir: -1 },
  KeyS: { enc: 2, dir: 1 },
  KeyZ: { enc: 3, dir: -1 },
  KeyX: { enc: 3, dir: 1 },

  ArrowUp: { enc: 2, dir: -1 },
  ArrowDown: { enc: 2, dir: 1 },
  ArrowLeft: { enc: 3, dir: -1 },
  ArrowRight: { enc: 3, dir: 1 },
};

/** Which action a binding is, or null if it is not one of the nine. */
export function actionOf(b: Binding | undefined): ActionId | null {
  if (!b) return null;
  for (const a of ACTIONS) {
    if (a.binding.key !== undefined && a.binding.key === b.key) return a.id;
    if (
      a.binding.enc !== undefined &&
      a.binding.enc === b.enc &&
      a.binding.dir === b.dir
    ) {
      return a.id;
    }
  }
  return null;
}

export function bindingOf(id: ActionId): Binding {
  const a = ACTIONS.find((x) => x.id === id);
  if (!a) throw new Error(`keymap: no action ${id}`);
  return a.binding;
}

/** Every code bound to one action, in the order the map lists them. */
export function codesFor(map: Keymap, id: ActionId): string[] {
  return Object.keys(map).filter((code) => actionOf(map[code]) === id);
}

/**
 * Bind a code, taking it away from whatever had it.
 *
 * A code that does two things is not a map, it is a bug waiting for the
 * moment two different actions both fire. So this is a MOVE, and the editor
 * says so when the code was already in use.
 */
export function bind(map: Keymap, code: string, id: ActionId): Keymap {
  const next: Record<string, Binding> = { ...map };
  next[code] = bindingOf(id);
  return next;
}

export function unbind(map: Keymap, code: string): Keymap {
  const next: Record<string, Binding> = { ...map };
  delete next[code];
  return next;
}

/**
 * A map read back from storage, with anything unrecognised dropped.
 *
 * Storage is not a trusted input: it survives a release, so a map written by
 * a version that had different actions has to come back as something this
 * version can use rather than as a key that silently does nothing.
 */
export function sanitise(value: unknown): Keymap | null {
  if (typeof value !== "object" || value === null) return null;
  const out: Record<string, Binding> = {};
  for (const [code, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof code !== "string" || code === "") continue;
    const id = actionOf(raw as Binding);
    if (id === null) continue;
    out[code] = bindingOf(id);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** `KeyQ` → `Q`, `ArrowUp` → `↑`: what is printed on the key, near enough. */
export function keyLabel(code: string): string {
  const named: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Space: "space",
    Enter: "enter",
    Backspace: "bksp",
    Escape: "esc",
    Tab: "tab",
    // Left and right share a legend because the KEYBOARD does. Two chips
    // reading "shift" in the editor is not a bug: there are two shift keys,
    // and each chip's title names the code it will remove.
    ShiftLeft: "shift",
    ShiftRight: "shift",
    ControlLeft: "ctrl",
    ControlRight: "ctrl",
    AltLeft: "alt",
    AltRight: "alt",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
    Backslash: "\\",
    Comma: ",",
    Period: ".",
    Slash: "/",
  };
  const n = named[code];
  if (n !== undefined) return n;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `num ${code.slice(6)}`;
  return code;
}
