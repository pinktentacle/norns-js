/**
 * E9-163 — HOW LATE THE SOUND IS, WHICH NOTHING HERE HAS EVER ASKED.
 *
 * The project measures the main thread, the callbacks into Lua, the long
 * frames and the audio thread's own load. It has never once asked the
 * browser how long a sample takes to get from the graph to a speaker —
 * and on a phone that is routinely tens of milliseconds, sometimes over
 * a hundred. It is a FLOOR under every gesture: a key pressed on the
 * grid cannot sound sooner than this however fast everything above it
 * gets, so tuning the page without knowing it is working on the wrong
 * end of the problem.
 *
 * TWO NUMBERS AND THEY MEAN DIFFERENT THINGS. `baseLatency` is what the
 * AudioContext itself adds — essentially the render quantum, a property
 * of the graph. `outputLatency` is the browser's estimate of everything
 * after it, down through the OS mixer to the device, which is where
 * Bluetooth headphones put their eighty milliseconds.
 *
 * THE SECOND IS NOT KNOWN WHEN THE FIRST IS. `outputLatency` reads 0
 * until audio has actually flowed, so one reading at boot would report
 * the interesting half as zero and look like good news. The caller asks
 * again later; this file only has to turn numbers into a line, which is
 * the part worth testing.
 */

/** Seconds to a millisecond figure a person can read. */
function ms(seconds: number): string {
  return (seconds * 1000).toFixed(1);
}

/**
 * What the graph itself adds, said as soon as there is a context.
 *
 * The frame count goes with it because that is the number anyone
 * changing it would be changing: a quantum is 128 frames and the figure
 * in milliseconds depends on the rate the device chose.
 */
export function describeGraphLatency(baseSeconds: number, sampleRate: number): string {
  const frames = Math.round(baseSeconds * sampleRate);
  return (
    `audio latency: ${ms(baseSeconds)} ms in the graph at ${Math.round(sampleRate)} Hz` +
    ` (${frames} frame${frames === 1 ? "" : "s"})`
  );
}

/**
 * What the device adds on top, once the browser will say.
 *
 * A browser that never fills it in gets a line of its own rather than a
 * zero: an instrument that cannot measure something has to say so, or
 * the reader takes the zero for an answer. Firefox does not implement
 * `outputLatency` at all.
 */
export function describeDeviceLatency(baseSeconds: number, outSeconds: number): string {
  if (!(outSeconds > 0)) {
    return "audio latency: the browser does not say what the device adds on this machine";
  }
  return (
    `audio latency: ${ms(outSeconds)} ms more to the device — ` +
    `${ms(baseSeconds + outSeconds)} ms in all, which is the floor under every key you press`
  );
}
