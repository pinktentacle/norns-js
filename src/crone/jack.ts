// E9-240 — the JACK cables into SuperCollider's inputs that a script can move.
//
// On a norns, `crone:output_5/6` (the ADC, after `level_adc`) are connected
// to `SuperCollider:in_1/2`, and a script may change that with
// `jack_connect` / `jack_disconnect` — splnkr, otis, combos and tetrabotis
// all offer to put softcut (`softcut:output_1/2`) through their engine. The
// worklet keeps a 4 x 2 matrix of those cables (`crone_route`); this names
// its rows and columns. Any other port is one this build does not have, and
// the command is refused rather than half-done.

/** The four sources crone can plug into SuperCollider, by JACK port name. */
export const JACK_SOURCES: Readonly<Record<string, number>> = {
  "crone:output_5": 0,
  "crone:output_6": 1,
  "softcut:output_1": 2,
  "softcut:output_2": 3,
};

/** SuperCollider's two inputs. */
export const JACK_INPUTS: Readonly<Record<string, number>> = {
  "SuperCollider:in_1": 0,
  "SuperCollider:in_2": 1,
};

/** Where one connection lands in the matrix, or null for a port this build has no cable for. */
export function jackRoute(from: string, to: string): { source: number; input: number } | null {
  const source = JACK_SOURCES[from];
  const input = JACK_INPUTS[to];
  return source === undefined || input === undefined ? null : { source, input };
}
