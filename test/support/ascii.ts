// E2-09 — render the 4-bit panel buffer as text.
//
// A hash would catch a change. It would not say WHAT changed, and a screen
// regression is exactly the kind you want to see rather than be told about:
// one row shifted, one glyph thinner, the whole page blank. So the fixture is
// a picture you can read in a diff.
//
// Each pixel is one character. Level 0 is a space, so the shape of the page
// is visible at a glance, and levels 1-15 are hex digits, so the comparison
// is exact rather than impressionistic. `screen_level(z)` lands on panel
// nibble `z` (measured in E0-17), which is what this prints — the bytes that
// would reach the SSD1322, not an approximation of how they look.

export const LEVEL_CHARS = " 123456789abcdef";

export function toAscii(grey: Uint8Array, width = 128, height = 64): string {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) {
      const v = grey[y * width + x] ?? 0;
      row += LEVEL_CHARS[Math.max(0, Math.min(15, v))];
    }
    // Trailing spaces are invisible in a diff and churn on every edit.
    rows.push(row.replace(/\s+$/, ""));
  }
  return rows.join("\n") + "\n";
}

/** A one-line summary, for a failure message that fits on a screen. */
export function describeFrame(grey: Uint8Array): string {
  const levels = new Map<number, number>();
  for (const v of grey) levels.set(v, (levels.get(v) ?? 0) + 1);
  const lit = grey.length - (levels.get(0) ?? 0);
  const distinct = [...levels.keys()].sort((a, b) => a - b);
  return `${lit} lit of ${grey.length}, levels [${distinct.join(",")}]`;
}
