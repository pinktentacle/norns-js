// E9-280 — an image is composited onto the screen in eight bits, as matron's
// cairo does, and a transparent part of it leaves the screen alone.
//
// It went through `screen_peek` and `screen_poke`, and upstream's peek reads
// the low nibble of a pixel (`& 0xF`): right only for a byte that is a whole
// level times 17. Antialiasing and the ADD operator leave bytes that are
// not, so a soft glow drawn before a PNG came back as a ring of bright dots
// (fireflies, its meadow drawn over its fireflies).

import { beforeAll, describe, expect, it } from "vitest";
import { createScreen, SCREEN_W, type Screen } from "../src/screen/screen.js";
import { loadScreenModule } from "../src/screen/screen-node.js";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { registerScreenImages } from "../src/screen/images.js";
import { encodePng } from "../src/screen/png-encode.js";
import { Vfs } from "../src/fs/vfs.js";

let screen: Screen;
let host: Host;
const vfs = new Vfs();

/** A 16x16 PNG: grey `level`, alpha `a`, everywhere. */
function png(level: number, a: number): Uint8Array {
  const px = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = px[i + 1] = px[i + 2] = level * 17;
    px[i + 3] = a;
  }
  return encodePng(16, 16, px, true);
}

beforeAll(async () => {
  screen = await createScreen(loadScreenModule, { onUpdate: () => {} });
  host = createHost({ sources: loadNornsLua(), vfs });
  screen.register(host.registry);
  registerScreenImages(host.registry, { screen, vfs });
  boot(host, loadConfig());
  vfs.write("/home/we/clear.png", png(0, 0));
  vfs.write("/home/we/solid.png", png(9, 255));
  vfs.write("/home/we/half.png", png(15, 128));
}, 60_000);

const glow = `
  screen.clear()
  screen.aa(0) screen.level(1) screen.rect(0, 0, 128, 64) screen.fill()
  screen.aa(1) screen.blend_mode("add")
  screen.level(1) screen.circle(8.3, 8.6, 5.5) screen.fill()
  screen.level(3) screen.circle(8.3, 8.6, 2.2) screen.fill()
  screen.blend_mode("over") screen.aa(0)
`;

/** The 16x16 corner's bytes. */
const corner = (): number[] => {
  const s = screen.surface();
  const out: number[] = [];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) for (let c = 0; c < 4; c++) out.push(s[(y * SCREEN_W + x) * 4 + c]!);
  return out;
};

describe("display_image composites in eight bits", () => {
  it("leaves a soft glow alone under a transparent image", () => {
    expect(host.run(glow)).toBeNull();
    const before = corner();
    // the glow really has bytes that are not whole levels: the case that broke
    expect(before.some((v, i) => i % 4 !== 3 && v % 17 !== 0)).toBe(true);
    expect(host.run(`screen.display_image(screen.load_png("/home/we/clear.png"), 0, 0)`)).toBeNull();
    expect(corner()).toEqual(before);
  });

  it("writes an opaque image's level, whatever was under it", () => {
    host.run(glow);
    host.run(`screen.display_image(screen.load_png("/home/we/solid.png"), 0, 0)`);
    const after = corner();
    for (let i = 0; i < after.length; i += 4) {
      expect([after[i], after[i + 1], after[i + 2], after[i + 3]]).toEqual([153, 153, 153, 255]);
    }
  });

  it("composites a half-transparent one OVER what is there", () => {
    host.run(`screen.clear() screen.aa(0) screen.level(4) screen.rect(0, 0, 128, 64) screen.fill()`);
    host.run(`screen.display_image(screen.load_png("/home/we/half.png"), 0, 0)`);
    const s = screen.surface();
    // 255 * 128/255 + 68 * (1 - 128/255) = 128 + 33.9
    expect(s[0]).toBe(162);
    expect(s[3]).toBe(255);
    expect(screen.greyscale()[0]).toBe(162 >> 4);
  });
});
