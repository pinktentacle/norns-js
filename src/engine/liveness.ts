// E9-219 — a dead audio server is said, on the page, and can be restarted.
//
// HOW IT DIED SILENTLY. On a Pixel, a recording in dronecaster killed
// scsynth (E9-218). Nothing said so: the next script loaded, drew its
// screen and made no sound, and the only trace was a log line nobody had
// open — "the server has stopped completing /d_recv" — written only once a
// SynthDef happened to be sent. A user reported "no sound in hachi", and
// hachi was the one script that was fine.
//
// TWO WAYS TO NOTICE, because the server can die two ways:
//
//   - `/d_recv` stops being acknowledged. `host.ts` already counts this
//     and calls `report`, but it only fires when a SynthDef is sent.
//   - Nothing is being sent at all. A `/sync` is asked every few seconds,
//     and a server that leaves it unanswered several times running is
//     dead. `/sync` passes through both of scsynth's threads, so it
//     notices either one gone.
//
// ONLY WHILE AN ANSWER IS OWED. The `/sync` is completed on the audio
// thread, so a suspended context — a hidden page stopped by E9-182, or the
// browser waiting for a first touch — answers nothing and is not dead. A
// probe that was in flight when the page went away is not counted.

export interface LivenessOptions {
  /** Ask the server; true when it answered in time. */
  readonly probe: () => Promise<boolean>;
  /** Can the server be expected to answer right now? */
  readonly active: () => boolean;
  /** Called once, the first time the server is found dead. */
  readonly onDead: (why: string) => void;
  /** How often to ask, at most. */
  readonly everyMs?: number;
  /**
   * Unanswered probes in a row that make a server dead. With a probe every
   * 4 s that waits 3, three misses is about twelve seconds: long past any
   * stall a living server has (a `/sync` comes back in milliseconds), and
   * short enough that the notice arrives while the user is still asking
   * why the sound stopped.
   */
  readonly strikes?: number;
}

export interface Liveness {
  /** Drive it from a timer; it asks when it is due. */
  tick(now: number): void;
  /** Another part of the page found the server dead. */
  report(why: string): void;
  readonly dead: boolean;
}

export function createLiveness(opts: LivenessOptions): Liveness {
  const everyMs = opts.everyMs ?? 4000;
  const strikes = opts.strikes ?? 3;
  let dead = false;
  let missed = 0;
  let asking = false;
  let lastAsked = -Infinity;

  const die = (why: string): void => {
    if (dead) return;
    dead = true;
    opts.onDead(why);
  };

  return {
    tick(now) {
      if (dead || asking) return;
      if (!opts.active()) {
        missed = 0;
        return;
      }
      if (now - lastAsked < everyMs) return;
      lastAsked = now;
      asking = true;
      opts.probe().then(
        (answered) => {
          asking = false;
          if (answered) {
            missed = 0;
            return;
          }
          // The page went away while it waited: not the server's fault.
          if (!opts.active()) return;
          missed++;
          if (missed >= strikes) {
            die(`it left ${missed} /sync in a row unanswered`);
          }
        },
        () => {
          asking = false;
        },
      );
    },
    report: die,
    get dead() {
      return dead;
    },
  };
}
