// E5-04 — the sixteen brightnesses, as one table.
//
// **ASSUMPTION, unverified against hardware.** monome firmware is taken to
// drive its LEDs with a PWM duty roughly linear in level, so the light a pad
// emits is linear in level. An sRGB display is not linear, so rendering a
// linear quantity on one means encoding it through the transfer function:
//
//     alpha ≈ (level / 15) ** (1 / 2.2)
//
// Rendering `level / 15` directly instead makes levels 1 to 4 nearly
// indistinguishable, which is not a cosmetic complaint: scripts use the low
// levels as a background layer under a bright foreground, and a view that
// collapses them loses the layer.
//
// IT IS A TABLE, NOT A FORMULA, on purpose. The exponent is a guess about
// hardware nobody here has photographed. Written as sixteen numbers, it can
// be re-tuned against a photograph of a real grid by editing this file and
// nothing else; written as `Math.pow` in the renderer, re-tuning means
// touching the renderer and arguing about where the gamma belongs.

/** Level 0..15 → alpha 0..1, perceptually spaced. */
export const BRIGHTNESS: readonly number[] = [
  0.0, 0.284, 0.388, 0.467, 0.532, 0.59, 0.642, 0.689, 0.733, 0.774, 0.812,
  0.849, 0.884, 0.917, 0.949, 1.0,
];

/**
 * What to draw for a level, given the device's global intensity.
 *
 * `monome_intensity` scales the whole surface — on hardware it is the driver
 * current, so it multiplies the light rather than re-mapping the levels.
 * Multiplying the alpha after the ramp is the faithful order: a dim grid's
 * level 1 and level 15 stay in the same ratio to each other.
 */
export function alphaFor(level: number, intensity = 15): number {
  const l = level < 0 ? 0 : level > 15 ? 15 : level | 0;
  const i = intensity < 0 ? 0 : intensity > 15 ? 15 : intensity;
  return BRIGHTNESS[l]! * (i / 15);
}

/**
 * A grid that is not varibright has two states, and the threshold is 8.
 *
 * libmonome's non-varibright path sends a binary map, lighting anything at 8
 * or above. A script written for levels on a grid that has none should look
 * the way it looks on that grid, not like a dimmed version of itself.
 */
export function quantise(level: number, varibright: boolean): number {
  if (varibright) return level;
  return level >= 8 ? 15 : 0;
}
