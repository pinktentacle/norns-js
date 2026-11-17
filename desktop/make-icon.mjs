// The application icon, drawn rather than fetched.
//
//   npm run desktop:icon      # -> desktop/resources/icon.png (512x512)
//
// DRAWN, AND BY ELECTRON. The page draws every device in CSS from the
// product photographs rather than shipping pictures of them, and an icon
// taken from somewhere else would be the one image in the project with no
// account of where it came from. Electron is already a dependency and
// already has a renderer, so the icon is a page it screenshots: no image
// library, no binary checked in that nothing can regenerate.
//
// IT IS THE NORNS, SEEN FROM ABOVE, cropped to a square: the body, the
// screen, and the four controls in their real arrangement. A 16x16 taskbar
// icon cannot show a 128x64 screen's contents, so the shapes have to carry
// it — a pale body, a black rectangle, two round highlights.

import { app, BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "resources");
const SIZE = 512;

// The colours are the page's own, from index.html's :root.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; background: transparent; }
  .body {
    position: absolute; inset: 6%;
    border-radius: 13%;
    background:
      radial-gradient(120% 90% at 30% 10%, #cfccc0 0%, #b9b6aa 45%, #97958b 100%);
    box-shadow:
      inset 0 6px 14px rgba(255,255,255,.45),
      inset 0 -10px 22px rgba(0,0,0,.28),
      0 18px 34px rgba(0,0,0,.45);
  }
  /* The screen: 128x64 is 2:1, and it sits low and left on the real body. */
  .screen {
    position: absolute; left: 9%; top: 46%; width: 48%; height: 24%;
    border-radius: 3%;
    background: #0a0a0c;
    box-shadow: inset 0 2px 6px rgba(0,0,0,.9), 0 1px 0 rgba(255,255,255,.35);
  }
  /* Two lit rows, so the black rectangle reads as a screen and not a hole. */
  .screen::before, .screen::after {
    content: ""; position: absolute; left: 10%; height: 9%; border-radius: 2px;
    background: #e8e4d8;
  }
  .screen::before { top: 24%; width: 52%; }
  .screen::after  { top: 52%; width: 30%; opacity: .55; }
  .knob {
    position: absolute; border-radius: 50%;
    background: radial-gradient(70% 60% at 35% 25%, #4a4a4c 0%, #232325 55%, #0e0e10 100%);
    box-shadow: 0 3px 7px rgba(0,0,0,.55), inset 0 2px 3px rgba(255,255,255,.22);
  }
  /* e1 small and e2/e3 large, laid out as they are on the device. */
  .k1 { left: 10%; top: 20%; width: 11%; height: 11%; }
  .k2 { left: 24%; top: 16%; width: 15%; height: 15%; }
  .k3 { left: 66%; top: 44%; width: 16%; height: 16%; }
  .k4 { left: 66%; top: 68%; width: 12%; height: 12%; }
</style>
<div class="body">
  <div class="screen"></div>
  <div class="knob k1"></div><div class="knob k2"></div>
  <div class="knob k3"></div><div class="knob k4"></div>
</div>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  // One frame, then capture: an offscreen window reports ready before it has
  // painted, and a capture taken then is a transparent square.
  await new Promise((r) => setTimeout(r, 600));
  const image = await win.capturePage();
  await mkdir(OUT, { recursive: true });
  const png = image.toPNG();
  await writeFile(join(OUT, "icon.png"), png);
  process.stdout.write(`icon: ${join(OUT, "icon.png")} — ${image.getSize().width}px, ${png.length} bytes\n`);
  app.exit(0);
});
