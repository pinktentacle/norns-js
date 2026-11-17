// E4-10 — a microphone into scsynth's worklet input.
//
// E0-32 settled the behaviour (5/5) and the one finding that changes how this
// is written: **Chrome grants echo cancellation, automatic gain control and
// noise suppression unless you refuse them.** For a telephone that is right;
// for a sampler it is a gate, a compressor and a filter that ducks the input
// whenever the output sounds. norns is a sampler and a looper as much as a
// synthesiser, so the defaults are refused explicitly here.
//
// Refusing them also changes the capture MODE, which is worth knowing rather
// than discovering: the same microphone went from 1 channel at 48 kHz
// processed to 2 channels at its native 44.1 kHz. The browser resamples on
// the way in and scsynth never sees the device rate.

export interface AudioInputOptions {
  /** Where the samples go. crone's worklet node, whose input 1 is the adc. */
  readonly destination: AudioNode;
  /**
   * WHICH input of it, and the default is not good enough here.
   *
   * crone has two inputs and keeps them apart on purpose: 0 is `ext` (the
   * engine) and 1 is `adc` (the hardware in). `connect(node)` means input
   * 0, so a microphone connected without this lands on the engine bus and
   * `level_adc` and `level_ext` become the same control — which is the one
   * thing crone's topology exists to prevent.
   */
  readonly destinationInput?: number;
  readonly context: AudioContext;
  /** Ask for the browser's processing instead of refusing it. Default false. */
  readonly processed?: boolean;
  /**
   * Which capture device, from `listAudioDevices`. Empty or absent is the
   * system default.
   *
   * `exact` rather than a preference: a soft constraint silently falls back
   * to the default when the device is gone, which is a picker that lies
   * about what it is recording. Failing is the honest answer and the caller
   * shows it.
   */
  readonly deviceId?: string;
  readonly log?: (line: string) => void;
}

export interface AudioInput {
  readonly stream: MediaStream;
  /** The granted settings, which are not always what was asked for. */
  readonly settings: MediaTrackSettings;
  /** Stop capturing and release the device. */
  stop(): void;
}

export interface InputAvailability {
  /** `granted`, `denied`, `prompt`, or `unknown` if the browser will not say. */
  readonly permission: string;
  /** How many capture devices are visible — which is itself gated on consent. */
  readonly devices: number | null;
}

/**
 * What can be asked for, before asking.
 *
 * `NotAllowedError` is returned both when a human clicks Block and when the
 * embedder forbids capture outright — E0-32 hit the second in an in-app
 * browser that never showed a prompt. Those are different situations and the
 * caller should be able to say which.
 *
 * Device enumeration is itself gated: before permission one input was
 * visible, after it three. Anything that builds a device picker has to do it
 * after consent or show a list missing most of the hardware.
 */
export async function inputAvailability(): Promise<InputAvailability> {
  let permission = "unknown";
  try {
    permission = (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
  } catch {
    /* Firefox and Safari do not answer for the microphone */
  }
  let devices: number | null = null;
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput")
      .length;
  } catch {
    devices = null;
  }
  return { permission, devices };
}

export async function openAudioInput(opts: AudioInputOptions): Promise<AudioInput> {
  const log = opts.log ?? (() => {});

  const pick = opts.deviceId !== undefined && opts.deviceId !== ""
    ? { deviceId: { exact: opts.deviceId } }
    : {};
  const constraints: MediaStreamConstraints = opts.processed
    ? { audio: { ...pick }, video: false }
    : {
        audio: {
          ...pick,
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
        },
        video: false,
      };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("getUserMedia returned no audio track");
  }
  const settings = track.getSettings();

  // Report what was GRANTED, not what was asked for: a browser may ignore a
  // constraint silently, and the difference changes what the samples mean.
  // The device label and deviceId are deliberately not logged — a microphone
  // label is frequently a person's name and nothing here needs it.
  log(
    `audio in: ${settings.channelCount ?? "?"} ch at ${settings.sampleRate ?? "?"} Hz, ` +
      `ec=${settings.echoCancellation} agc=${settings.autoGainControl} ns=${settings.noiseSuppression}`,
  );
  if (settings.sampleRate && settings.sampleRate !== opts.context.sampleRate) {
    log(
      `audio in: device ${settings.sampleRate} Hz vs context ${opts.context.sampleRate} Hz — ` +
        `the browser resamples on the way in, invisibly`,
    );
  }

  // The node is kept on the returned object, not only in this scope: Chrome
  // has historically collected a MediaStreamAudioSourceNode whose only
  // reference was a local, and a collected source goes SILENT rather than
  // erroring (E0-32 §6.4).
  const source = opts.context.createMediaStreamSource(stream);
  source.connect(opts.destination, 0, opts.destinationInput ?? 0);

  return {
    stream,
    settings,
    stop() {
      source.disconnect(opts.destination, 0, opts.destinationInput ?? 0);
      for (const t of stream.getTracks()) t.stop();
      log("audio in: released");
    },
  };
}
