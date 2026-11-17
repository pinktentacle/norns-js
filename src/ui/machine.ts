// What kind of machine is this page on, and what should it look like there.
//
// Three profiles, because three shapes of screen want three different pages:
// a desk, a phone held in one hand, and a Steam Deck's 1280x800 landscape
// with a gamepad instead of a keyboard.
//
// DETECTION IS A GUESS AND IS TREATED AS ONE. There is no browser API that
// says "this is a Steam Deck". What exists is a handful of signals of very
// different quality, so each rule carries its own confidence and the result
// is always overridable from the gear -- which is why the setting has
// `normal`, `phone` and `steamdeck` beside `auto` rather than only `auto`.
//
// WHAT THE SIGNALS ARE WORTH, which is the whole of the design:
//
//   Steam's own browser, in Game Mode, puts the machine in its user agent:
//
//       Mozilla/5.0 (X11; Linux x86_64; Valve Steam Client/Steam Deck
//       [Steam Deck Stable]/default/0) AppleWebKit/537.36 ... Chrome/126
//
//   That is unambiguous, and it is the ONLY unambiguous signal. A browser
//   started from desktop mode -- which is how anyone would actually run
//   this -- sends an ordinary Linux Chrome string with no marker of any
//   kind. So desktop mode has to be inferred from shape: Linux, a screen
//   that is exactly 1280x800, and a touchscreen. That is the Deck's panel
//   (LCD and OLED are both 1280x800) and it is a rare combination, but it
//   is a GUESS, and this says so rather than pretending.
//
//   A connected gamepad naming Valve or a Steam controller raises it back
//   to confident. It is not required, because Steam Input only presents the
//   pad to a browser once something has pressed a control.
//
// NONE OF THE STEAM DECK PATH HAS BEEN RUN ON A STEAM DECK. The rules below
// are built from documented user-agent strings and the panel's published
// resolution. They are written to be wrong SAFELY: the worst case is a page
// that looks like a desk until someone picks the profile themselves.

export type MachineKind = "normal" | "phone" | "steamdeck";
/** What the gear stores. `auto` means "use the detection". */
export type MachinePreference = "auto" | MachineKind;

export const MACHINE_KINDS: readonly MachineKind[] = ["normal", "phone", "steamdeck"];

export interface MachineSignals {
  readonly userAgent: string;
  readonly screenW: number;
  readonly screenH: number;
  readonly maxTouchPoints: number;
  /** `matchMedia("(pointer: coarse)")`: a finger rather than a mouse. */
  readonly coarsePointer: boolean;
  /** `id` of every connected gamepad. Often empty until a control is used. */
  readonly gamepadIds: readonly string[];
}

export interface Detection {
  readonly kind: MachineKind;
  /** One line, shown in the gear, so a wrong guess can be understood. */
  readonly why: string;
  /** False when the rule that fired is a shape, not a statement. */
  readonly confident: boolean;
}

/** The Deck's panel, both the LCD and the OLED. */
const DECK_W = 1280;
const DECK_H = 800;
/** Wider than this in its short dimension and it is not a phone. */
const PHONE_SHORT_EDGE = 500;

const STEAM_CLIENT = /Valve Steam Client\/Steam Deck/i;
const DECK_PAD = /steam\s*deck|valve software|steam controller/i;
const PHONE_UA = /\b(iPhone|iPod)\b|Android.*\bMobile\b/i;
const LINUX_UA = /\b(Linux|X11|CrOS)\b/i;

export function detect(s: MachineSignals): Detection {
  if (STEAM_CLIENT.test(s.userAgent)) {
    return { kind: "steamdeck", why: "Steam's own browser says so", confident: true };
  }
  const pad = s.gamepadIds.find((id) => DECK_PAD.test(id));
  if (pad !== undefined) {
    return { kind: "steamdeck", why: `a gamepad called "${pad}"`, confident: true };
  }

  const short = Math.min(s.screenW, s.screenH);
  const long = Math.max(s.screenW, s.screenH);
  const deckPanel = short === DECK_H && long === DECK_W;
  if (deckPanel && LINUX_UA.test(s.userAgent) && s.maxTouchPoints > 0) {
    return {
      kind: "steamdeck",
      // A shape, not a statement. See the header.
      why: "Linux, a 1280×800 screen and a touchscreen — a guess",
      confident: false,
    };
  }

  if (PHONE_UA.test(s.userAgent)) {
    return { kind: "phone", why: "a phone user agent", confident: true };
  }
  if (s.coarsePointer && s.maxTouchPoints > 0 && short <= PHONE_SHORT_EDGE) {
    return {
      kind: "phone",
      why: `a touchscreen ${short} px across — a guess`,
      confident: false,
    };
  }

  return { kind: "normal", why: "nothing said otherwise", confident: true };
}

/** Read the signals out of the browser this page is in. */
export function readSignals(): MachineSignals {
  const nav = globalThis.navigator as Navigator | undefined;
  const scr = globalThis.screen as Screen | undefined;
  let pads: string[] = [];
  try {
    pads = (nav?.getGamepads?.() ?? [])
      .filter((p): p is Gamepad => p !== null)
      .map((p) => p.id);
  } catch {
    // Some browsers throw rather than return an empty list without a
    // gesture. An empty list is the right answer either way.
  }
  return {
    userAgent: nav?.userAgent ?? "",
    screenW: scr?.width ?? 0,
    screenH: scr?.height ?? 0,
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    coarsePointer: globalThis.matchMedia?.("(pointer: coarse)").matches ?? false,
    gamepadIds: pads,
  };
}

/** What the page should actually use, given the stored preference. */
export function effectiveKind(pref: MachinePreference, detected: Detection): MachineKind {
  return pref === "auto" ? detected.kind : pref;
}
