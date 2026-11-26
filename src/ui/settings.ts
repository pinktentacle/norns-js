// E6-10 — what this browser remembers about this page.
//
// Two things, and they are the two the user can change: which keys do what,
// and where the devices sit and how big they are.
//
// NOT A COOKIE, although that is the word people reach for. A cookie is sent
// to the server with every single request, is capped at about 4 KB, and is
// readable by anything served from the same origin -- three costs paid for a
// delivery nobody here wants, because this page has no server that cares. Web
// Storage was added for exactly this: per-origin, stays in the browser, and
// big enough that a layout and a keymap are not worth counting.
//
// IT CAN FAIL, and the failure is not exotic. Storage throws rather than
// returns null in a private window with site data blocked, and it comes back
// empty after the user clears their data. So every read and every write is
// wrapped, the store works perfectly well with nothing behind it, and
// `persisted` says which of the two situations the user is in -- the panel
// tells them, because "I set this and it did not stick" deserves a reason.
//
// VERSIONED, because the shape here will change. A key with a version in it
// means a future format is a new key rather than a migration: the old value
// is ignored, the user gets the defaults once, and nothing has to parse a
// shape it predates.

import { DEFAULT_KEYMAP, sanitise, type Keymap } from "./keymap.js";
import { DEFAULT_MAX_AUDIO_MB, DEFAULT_MAX_FILES } from "../community/install.js";
import type { MachinePreference } from "./machine.js";

export const STORAGE_KEY = "norns-js/settings/v1";

/**
 * The editor's own four settings, kept here rather than in a second store.
 *
 * They belong beside the zoom and the keymap: one place that is cleared by
 * one RESET, and one shape to read back.
 */
export interface EditorSettings {
  readonly theme: "dark" | "light";
  readonly keymap: "default" | "vim" | "emacs";
  readonly tabSize: number;
  readonly fontSize: number;
}

export const DEFAULT_EDITOR: EditorSettings = {
  theme: "dark",
  keymap: "default",
  tabSize: 2,
  fontSize: 13,
};

/**
 * `console` is in here with the hardware on purpose.
 *
 * It is the only one that is not a device, and it is the one most likely
 * to be in the way — a log under a norns on an 800-pixel screen is a log
 * you scroll to. Arranging it is the same problem as arranging the grid.
 */
export type DeviceId =
  | "norns"
  | "grid"
  | "arc"
  | "keys"
  | "faders"
  | "knobs"
  | "console";

export const DEVICES: readonly DeviceId[] = [
  "norns",
  "grid",
  "arc",
  "keys",
  "faders",
  "knobs",
  "console",
];

/** Where a device sits in the stage, and how wide it is. All in CSS pixels. */
export interface Placement {
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

/**
 * Partial on purpose: a device with no entry has never been placed, and the
 * page stacks it under the others rather than guessing a position for it.
 * That is what makes "attach the arc for the first time" land somewhere
 * sensible instead of on top of the norns.
 */
export type Layout = Partial<Record<DeviceId, Placement>>;

/**
 * Which norns is drawn: the official box, or the shield.
 *
 * E9-108 — BOTH ARE REAL NORNS. The official one is the wide aluminium
 * unit; the shield is a Raspberry Pi hat in a nearly square case with the
 * screen across the middle. They run the same scripts and the same
 * `_norns.key` and `_norns.enc` reach them, so this decides a picture and
 * nothing else — no script can tell the difference, which is why it is a
 * setting rather than a mode.
 *
 * NOT `auto`, unlike `machine`. The page cannot detect which norns somebody
 * owns, and an `auto` that always meant one of them would be a third name
 * for a choice with two answers.
 */
export type PanelKind = "norns" | "shield";

export const PANEL_KINDS: readonly PanelKind[] = ["norns", "shield"];

export interface Settings {
  readonly keymap: Keymap;
  readonly layout: Layout;
  /**
   * The master mute, and it starts OFF — the output is live (user, 2026-11-10).
   *
   * It used to start muted, on the reasoning that a page which makes noise
   * the moment it opens is a page people close. That reasoning was weaker
   * than it looked here: a browser will not start an AudioContext before a
   * user gesture anyway, so nothing can sound until somebody has already
   * touched the page. The mute was asking permission twice and costing a
   * click before anyone could hear a norns at all.
   */
  readonly muted: boolean;
  /**
   * The master level in DECIBELS, 0 being unity and the default.
   *
   * IN dB AND NOT A PERCENTAGE, because the thing it adjusts is a sound.
   * Half the amplitude is −6 dB, and a slider that reads 50% there tells
   * you a number that has nothing to do with what you hear.
   *
   * IT GOES ABOVE ZERO, which a master volume normally should not, and the
   * reason is a measured one: `amen` comes out of the engine about 17 dB
   * quieter in the desktop shell than in a tab (E9-13), and a control that
   * stops at unity could not make it audible. Above 0 dB can clip, which
   * the panel says.
   */
  readonly volumeDb: number;
  /**
   * Which sound cards, by `deviceId`, and whether the input is running.
   *
   * STORED BY ID AND NOT BY NAME, which is the only thing that survives a
   * reboot — but a `deviceId` is scoped to the origin and is rotated when
   * site data is cleared, so a stored id can stop matching anything. That
   * is not an error state: it means the system default, which is what an
   * empty string means too.
   */
  readonly audioOut: string;
  readonly audioIn: string;
  /** Whether to capture at all. Off, because a microphone is a decision. */
  readonly audioInOn: boolean;
  /**
   * How far an encoder turns for a given gesture, as a multiplier.
   *
   * 1 is the measured default. Higher means a drag or a key press moves
   * the value further; lower means finer control. It is one number for all
   * three encoders because the hardware's three feel the same — norns'
   * own per-encoder `set_sens` is a SCRIPT's business, and scripts set it
   * themselves; this is the hand on the knob, not the script's idea of it.
   */
  readonly encoderSensitivity: number;
  /**
   * Which machine the page should lay itself out for.
   *
   * CALLED `machine`, NOT `device`, everywhere a reader can see it. A
   * device in this file is a norns, a grid or an arc — the things
   * "arrange devices" moves around the stage — and one word for both was a
   * gear panel offering "device" twice, meaning two unrelated things.
   *
   * `auto` uses the detection in `machine.ts`, and the other three force
   * it. Forcing has to exist rather than being a fallback for a bug: the
   * one unambiguous Steam Deck signal appears only in Steam's own browser,
   * so anybody running this from desktop mode is relying on a GUESS made
   * from the screen's shape. A guess the user can overrule is fine; a
   * guess they cannot is a page that has decided it knows better.
   */
  readonly machine: MachinePreference;
  /**
   * Which body the norns is drawn as. See `PanelKind`.
   *
   * THE SHIELD IS THE DEFAULT, on every machine and not only on a phone.
   * The phone is where it was asked for and where it matters most — at one
   * device width the shield's screen is 1.58x wider and its encoders 1.73x
   * bigger — but the same is true of a mouse on a desk, and a page that
   * laid itself out differently depending on what you opened it with would
   * be two applications wearing one name.
   */
  readonly panel: PanelKind;
  /**
   * How big everything on the stage is drawn, as a multiplier.
   *
   * Not a CSS transform. A transform would scale the norns screen's canvas
   * bitmap and blur it; this multiplies the DEVICE WIDTHS instead, so the
   * screen re-renders at a higher integer scale and stays sharp. Positions
   * are multiplied too, so an arrangement keeps its shape.
   */
  readonly zoom: number;
  /** The virtual MIDI keyboard's lowest octave, and how hard it strikes. */
  readonly midiOctave: number;
  readonly midiVelocity: number;
  /** The editor's own four, see `EditorSettings`. */
  readonly editor: EditorSettings;
  /**
   * How many files an install will take before it refuses.
   *
   * E9-72. It was a constant, 400, and measuring it against the catalogue
   * showed the guess inside it: of 351 repositories that list, exactly one
   * is over 400 — `mosaic`, at 1209 — and the next largest is 239. So it
   * refused one script in 355 and stopped nothing else. What actually
   * stops a repository that is a sample library counts bytes, not files.
   *
   * Here rather than in the installer because the number is a judgement
   * about somebody's connection and somebody's storage, and those are not
   * ours to make for them.
   */
  readonly installMaxFiles: number;
  /** E9-261 — and the MB of audio one install will take. Same reasoning. */
  readonly installMaxAudioMb: number;
}

export interface SettingsStore {
  readonly keymap: Keymap;
  readonly layout: Layout;
  readonly muted: boolean;
  setMuted(muted: boolean): void;
  readonly volumeDb: number;
  setVolume(db: number): void;
  readonly audioOut: string;
  readonly audioIn: string;
  readonly audioInOn: boolean;
  setAudio(v: { out?: string; in?: string; inOn?: boolean }): void;
  readonly encoderSensitivity: number;
  setEncoderSensitivity(value: number): void;
  readonly machine: MachinePreference;
  setMachine(value: MachinePreference): void;
  readonly panel: PanelKind;
  setPanel(value: PanelKind): void;
  readonly zoom: number;
  setZoom(value: number): void;
  readonly midiOctave: number;
  setMidiOctave(value: number): void;
  readonly midiVelocity: number;
  setMidiVelocity(value: number): void;
  readonly editor: EditorSettings;
  setEditor(value: EditorSettings): void;
  readonly installMaxFiles: number;
  setInstallMaxFiles(value: number): void;
  readonly installMaxAudioMb: number;
  setInstallMaxAudioMb(value: number): void;
  /** False when this browser refused storage: the settings are session-only. */
  readonly persisted: boolean;
  setKeymap(map: Keymap): void;
  setPlacement(id: DeviceId, p: Placement): void;
  clearLayout(): void;
  resetKeymap(): void;
  /** Called after every change, with what the page should now show. */
  subscribe(
    fn: (s: Settings, what: "keymap" | "layout" | "muted" | "volume" | "audio" | "encoder" | "machine" | "panel" | "zoom" | "midi" | "editor" | "files") => void,
  ): () => void;
}

/** A Storage without the parts this file does not use, so a test can be one. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * What SETTINGS > FILES will let the install limit be.
 *
 * The floor is low enough to be a real refusal and high enough to still
 * install a script: the largest repository in the catalogue that is not
 * `mosaic` is 239 files. The ceiling is not a measurement, it is a hand on
 * the brake — nothing in the catalogue is near it, and a repository that
 * is would be a mistake somebody should look at rather than wait through.
 */
export const INSTALL_FILES_MIN = 50;
export const INSTALL_FILES_MAX = 10000;
export const INSTALL_AUDIO_MB_MIN = 16;
export const INSTALL_AUDIO_MB_MAX = 4096;

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;
/** Velocity 0 is a note OFF on the wire, so the floor is 1 and not 0. */
export const VELOCITY_MIN = 1;
export const VELOCITY_MAX = 127;
/**
 * The master level, in dB.
 *
 * −60 rather than −∞: silence is what the mute button is for, and a slider
 * whose bottom is also a mute gives two controls for one state. +12 is a
 * deliberate, useful lie about what a master fader is: it exists so that a
 * script the engine delivers too quietly can still be heard.
 */
export const VOLUME_MIN_DB = -60;
export const VOLUME_MAX_DB = 12;
/** A level in dB as a gain. −60 dB is 0.001, 0 dB is 1, +12 dB is ~4. */
export const dbToGain = (db: number): number => 10 ** (db / 20);

const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.max(lo, Math.min(hi, n));
};

/** An unknown value means a version that no longer exists: fall back. */
function readMachine(v: unknown): MachinePreference {
  return v === "normal" || v === "phone" || v === "steamdeck" || v === "auto" ? v : "auto";
}

/** Sensitivity is bounded, because zero means the knob does nothing. */
export const SENS_MIN = 0.25;
export const SENS_MAX = 4;

function clampSens(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 1;
  return Math.max(SENS_MIN, Math.min(SENS_MAX, n));
}

function readPlacement(v: unknown): Placement | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const n = (k: string): number | null =>
    typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : null;
  const x = n("x");
  const y = n("y");
  const w = n("w");
  if (x === null || y === null || w === null) return null;
  // A width of zero is a device nobody can see or grab again, which is a trap
  // rather than a setting. Negative coordinates are allowed: a device parked
  // half off the left edge is the user's business, and the stage clamps on
  // load anyway.
  if (w < 40) return null;
  return { x, y, w };
}

/**
 * The editor settings as they come back from storage.
 *
 * Every field is checked against what it is allowed to be, because what is
 * in `localStorage` is whatever was last written there — by a version of
 * this page that may be older than this one, or by somebody with the
 * console open.
 */
function readEditor(v: unknown): EditorSettings {
  if (typeof v !== "object" || v === null) return DEFAULT_EDITOR;
  const o = v as Record<string, unknown>;
  const theme = o["theme"] === "light" ? "light" : "dark";
  const keymap = o["keymap"] === "vim" || o["keymap"] === "emacs" ? o["keymap"] : "default";
  return {
    theme,
    keymap,
    tabSize: Math.round(clampNum(o["tabSize"], 1, 8, DEFAULT_EDITOR.tabSize)),
    fontSize: Math.round(clampNum(o["fontSize"], 9, 28, DEFAULT_EDITOR.fontSize)),
  };
}

function readLayout(v: unknown): Layout {
  if (typeof v !== "object" || v === null) return {};
  const o = v as Record<string, unknown>;
  const out: Record<string, Placement> = {};
  for (const id of DEVICES) {
    const p = readPlacement(o[id]);
    if (p) out[id] = p;
  }
  return out as Layout;
}

/**
 * The settings of a page that has never stored any.
 *
 * ONE of these, where there were four identical literals — no storage, a
 * throwing storage, an empty key, and a corrupt value all answer with the
 * same thing, and adding a field meant getting it right in four places or
 * shipping a defaulted field that is `undefined` in three of them.
 */
const fallback = (): Settings => ({
  keymap: DEFAULT_KEYMAP,
  layout: {},
  muted: false,
  volumeDb: 0,
  audioOut: "",
  audioIn: "",
  audioInOn: false,
  encoderSensitivity: 1,
  machine: "auto",
  panel: "shield",
  zoom: 1,
  midiOctave: 4,
  midiVelocity: 100,
  editor: DEFAULT_EDITOR,
  installMaxFiles: DEFAULT_MAX_FILES,
  installMaxAudioMb: DEFAULT_MAX_AUDIO_MB,
});

export function createSettings(storage: StorageLike | null): SettingsStore {
  let persisted = storage !== null;

  const read = (): Settings => {
    if (!storage) return fallback();
    let raw: string | null = null;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch {
      // A browser that throws on getItem will throw on setItem too, so stop
      // claiming the settings are kept.
      persisted = false;
      return fallback();
    }
    if (raw === null) return fallback();
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        keymap: sanitise(parsed["keymap"]) ?? DEFAULT_KEYMAP,
        layout: readLayout(parsed["layout"]),
        // Only an explicit `true` mutes, so a value stored by the version
        // that defaulted to muted does not keep a page silent for someone
        // who never chose that.
        muted: parsed["muted"] === true,
        volumeDb: clampNum(parsed["volumeDb"], VOLUME_MIN_DB, VOLUME_MAX_DB, 0),
        audioOut: typeof parsed["audioOut"] === "string" ? parsed["audioOut"] : "",
        audioIn: typeof parsed["audioIn"] === "string" ? parsed["audioIn"] : "",
        audioInOn: parsed["audioInOn"] === true,
        encoderSensitivity: clampSens(parsed["encoderSensitivity"]),
        // E9-108 — AND IT NEVER CAME BACK, which measuring the stored blob
        // is what showed: `write` is `JSON.stringify(state)` and the field
        // on `Settings` is `machine`, so what is on disk has always been
        // `{"machine":"phone"}` while this line read `device`. No key
        // called `device` exists in any stored settings — checked in the
        // page — so forcing a machine in the gear lasted exactly until the
        // next reload.
        //
        // Both are read, and the new one wins. The fallback is what the
        // original comment was for and costs one `??`.
        machine: readMachine(parsed["machine"] ?? parsed["device"]),
        panel: parsed["panel"] === "norns" ? "norns" : "shield",
        zoom: clampNum(parsed["zoom"], ZOOM_MIN, ZOOM_MAX, 1),
        midiOctave: clampNum(parsed["midiOctave"], -1, 7, 4),
        midiVelocity: Math.round(clampNum(parsed["midiVelocity"], VELOCITY_MIN, VELOCITY_MAX, 100)),
        editor: readEditor(parsed["editor"]),
        installMaxFiles: Math.round(
          clampNum(parsed["installMaxFiles"], INSTALL_FILES_MIN, INSTALL_FILES_MAX, DEFAULT_MAX_FILES),
        ),
        installMaxAudioMb: Math.round(
          clampNum(parsed["installMaxAudioMb"], INSTALL_AUDIO_MB_MIN, INSTALL_AUDIO_MB_MAX, DEFAULT_MAX_AUDIO_MB),
        ),
      };
    } catch {
      // Corrupt or hand-edited. The defaults are a better answer than a
      // broken page, and the next write replaces it.
      return fallback();
    }
  };

  let state = read();
  const listeners = new Set<
    (s: Settings, what: "keymap" | "layout" | "muted" | "volume" | "audio" | "encoder" | "machine" | "panel" | "zoom" | "midi" | "editor" | "files") => void
  >();

  const write = (what: "keymap" | "layout" | "muted" | "volume" | "audio" | "encoder" | "machine" | "panel" | "zoom" | "midi" | "editor" | "files"): void => {
    if (storage) {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        // Quota, or a browser that allows reads and refuses writes. The page
        // keeps working on the in-memory copy.
        persisted = false;
      }
    }
    for (const fn of listeners) fn(state, what);
  };

  return {
    get keymap(): Keymap {
      return state.keymap;
    },
    get layout(): Layout {
      return state.layout;
    },
    get persisted(): boolean {
      return persisted;
    },
    get muted(): boolean {
      return state.muted;
    },
    get volumeDb(): number {
      return state.volumeDb;
    },
    get audioOut(): string {
      return state.audioOut;
    },
    get audioIn(): string {
      return state.audioIn;
    },
    get audioInOn(): boolean {
      return state.audioInOn;
    },
    get encoderSensitivity(): number {
      return state.encoderSensitivity;
    },
    setEncoderSensitivity(value: number): void {
      state = { ...state, encoderSensitivity: clampSens(value) };
      write("encoder");
    },
    get machine(): MachinePreference {
      return state.machine;
    },
    get panel(): PanelKind {
      return state.panel;
    },
    get zoom(): number {
      return state.zoom;
    },
    setZoom(value: number): void {
      state = { ...state, zoom: clampNum(value, ZOOM_MIN, ZOOM_MAX, 1) };
      write("zoom");
    },
    get midiOctave(): number {
      return state.midiOctave;
    },
    setMidiOctave(value: number): void {
      state = { ...state, midiOctave: Math.round(clampNum(value, -1, 7, 4)) };
      write("midi");
    },
    get midiVelocity(): number {
      return state.midiVelocity;
    },
    get editor(): EditorSettings {
      return state.editor;
    },
    setEditor(value: EditorSettings): void {
      state = { ...state, editor: readEditor(value) };
      write("editor");
    },
    get installMaxFiles(): number {
      return state.installMaxFiles;
    },
    setInstallMaxFiles(value: number): void {
      state = {
        ...state,
        installMaxFiles: Math.round(
          clampNum(value, INSTALL_FILES_MIN, INSTALL_FILES_MAX, DEFAULT_MAX_FILES),
        ),
      };
      write("files");
    },
    get installMaxAudioMb(): number {
      return state.installMaxAudioMb;
    },
    setInstallMaxAudioMb(value: number): void {
      state = {
        ...state,
        installMaxAudioMb: Math.round(
          clampNum(value, INSTALL_AUDIO_MB_MIN, INSTALL_AUDIO_MB_MAX, DEFAULT_MAX_AUDIO_MB),
        ),
      };
      write("files");
    },
    setMidiVelocity(value: number): void {
      state = { ...state, midiVelocity: Math.round(clampNum(value, VELOCITY_MIN, VELOCITY_MAX, 100)) };
      write("midi");
    },
    setMachine(value: MachinePreference): void {
      state = { ...state, machine: readMachine(value) };
      write("machine");
    },
    setPanel(value: PanelKind) {
      state = { ...state, panel: value === "norns" ? "norns" : "shield" };
      write("panel");
    },
    setMuted(muted: boolean): void {
      state = { ...state, muted };
      write("muted");
    },
    setAudio(v): void {
      state = {
        ...state,
        audioOut: v.out ?? state.audioOut,
        audioIn: v.in ?? state.audioIn,
        audioInOn: v.inOn ?? state.audioInOn,
      };
      write("audio");
    },
    setVolume(db: number): void {
      state = { ...state, volumeDb: clampNum(db, VOLUME_MIN_DB, VOLUME_MAX_DB, 0) };
      write("volume");
    },
    setKeymap(map: Keymap): void {
      state = { ...state, keymap: map };
      write("keymap");
    },
    setPlacement(id: DeviceId, p: Placement): void {
      state = { ...state, layout: { ...state.layout, [id]: p } };
      write("layout");
    },
    clearLayout(): void {
      state = { ...state, layout: {} };
      write("layout");
    },
    resetKeymap(): void {
      state = { ...state, keymap: DEFAULT_KEYMAP };
      write("keymap");
    },
    subscribe(fn): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** The page's storage, or null if this browser will not give us one. */
export function browserStorage(): StorageLike | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    // Touching it is the only honest test: the object exists in a private
    // window that will throw on the first real access.
    const probe = `${STORAGE_KEY}/probe`;
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}
