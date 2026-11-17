// E9-15 — what sound cards are there, and may we know their names.
//
// THE ONE THING THAT DECIDES THE SHAPE OF THIS FILE: device enumeration is
// gated on the MICROPHONE permission, even when all you want is to choose a
// SPEAKER. Measured in the same build, both ways:
//
//   refused   1 output and 1 input, each with an empty deviceId and no
//             label — nothing a list could show, and nothing `setSinkId`
//             could be given.
//   granted   3 of each, with real ids and real names.
//
// `navigator.mediaDevices.selectAudioOutput()` is the native picker that
// would avoid this — one dialog, one device, no microphone. It is
// **undefined** in Chromium 156, here and in the shell, so it cannot be the
// route. It is checked for anyway: the day it lands, it is the better door
// and this file should take it.
//
// So the honest design is to say so and let the person decide. `grant()`
// asks for the microphone and immediately stops the track: nothing is
// recorded, the permission is the only thing wanted. In a tab that is a
// browser prompt, which is an awkward thing to put in front of someone who
// wanted to pick an output; in the desktop shell the application has
// already granted it and no prompt appears at all.
//
// NO LABEL IS EVER LOGGED. A microphone label is frequently a person's
// name, and the one in front of me reads "Remote Audio" only because this
// is an RDP session.

/** One sound card, as a picker needs it. */
export interface AudioDevice {
  readonly id: string;
  readonly label: string;
}

export interface AudioDeviceList {
  readonly outputs: AudioDevice[];
  readonly inputs: AudioDevice[];
  /**
   * Whether the browser is telling us what these devices ARE.
   *
   * False means the list is the placeholder one — a single entry with an
   * empty id — and a picker built on it would offer one nameless choice
   * that cannot be selected. It is the difference between "no devices" and
   * "not allowed to look", which are very different things to show.
   */
  readonly named: boolean;
  /** `granted`, `denied`, `prompt`, or `unknown` when the browser will not say. */
  readonly permission: string;
}

/** True when this browser has the native output picker. It has not, yet. */
export const hasNativePicker = (): boolean =>
  typeof (navigator.mediaDevices as { selectAudioOutput?: unknown } | undefined)
    ?.selectAudioOutput === "function";

/** True when the running context can be pointed at a chosen output at all. */
export const canChooseOutput = (): boolean =>
  typeof (AudioContext.prototype as { setSinkId?: unknown }).setSinkId === "function";

const permissionState = async (name: string): Promise<string> => {
  try {
    return (await navigator.permissions.query({ name: name as PermissionName })).state;
  } catch {
    // Firefox and Safari do not answer for the microphone. "unknown" is the
    // truthful answer and the panel says it rather than guessing "prompt".
    return "unknown";
  }
};

/**
 * What is plugged in, as far as this page is allowed to see.
 *
 * A device with an EMPTY id is dropped: it is the browser's placeholder for
 * "there is something here and you may not know what", and it cannot be
 * passed to `setSinkId` or to a `deviceId` constraint. Keeping it would put
 * a row in the picker that does nothing when chosen.
 */
export async function listAudioDevices(): Promise<AudioDeviceList> {
  const permission = await permissionState("microphone");
  let all: MediaDeviceInfo[] = [];
  try {
    all = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return { outputs: [], inputs: [], named: false, permission };
  }
  const take = (kind: string): AudioDevice[] =>
    all
      .filter((d) => d.kind === kind && d.deviceId !== "")
      .map((d) => ({ id: d.deviceId, label: d.label === "" ? d.deviceId : d.label }));
  const outputs = take("audiooutput");
  const inputs = take("audioinput");
  return { outputs, inputs, named: outputs.length + inputs.length > 0, permission };
}

/**
 * Ask for the microphone, and give it straight back.
 *
 * The track is stopped as soon as it arrives. Nothing is recorded here: the
 * permission is the whole point, because it is what makes the device list
 * readable. Capturing for real is `openAudioInput`, which is a different
 * decision made by a different button.
 */
export async function grantDeviceAccess(): Promise<{ ok: boolean; why?: string }> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    for (const t of stream.getTracks()) t.stop();
    return { ok: true };
  } catch (e) {
    const err = e as Error;
    return { ok: false, why: `${err.name}: ${err.message}` };
  }
}

/**
 * Point the context at a device. An empty id means the system default.
 *
 * Returns what went wrong rather than throwing: a sound card can be
 * unplugged between the list being drawn and the choice being made, and the
 * panel should say so and offer the list again, not break.
 */
export async function setOutputDevice(
  context: AudioContext,
  deviceId: string,
): Promise<{ ok: boolean; why?: string }> {
  const ctx = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (typeof ctx.setSinkId !== "function") {
    return { ok: false, why: "this browser cannot choose an output" };
  }
  try {
    await ctx.setSinkId(deviceId);
    return { ok: true };
  } catch (e) {
    const err = e as Error;
    return { ok: false, why: `${err.name}: ${err.message}` };
  }
}

/** Call `fn` whenever a device is plugged in or pulled out. */
export function watchDevices(fn: () => void): () => void {
  const md = navigator.mediaDevices as EventTarget | undefined;
  if (!md?.addEventListener) return () => {};
  md.addEventListener("devicechange", fn);
  return () => md.removeEventListener("devicechange", fn);
}
