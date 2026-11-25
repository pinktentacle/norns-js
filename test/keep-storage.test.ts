// E9-217 — the first install of a session asks the browser to keep the
// origin's storage; nothing else does.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createKeepStorage } from "../src/fs/keep-storage.js";

describe("keeping what is installed", () => {
  it("asks once, however many installs follow", async () => {
    let asks = 0;
    const lines: string[] = [];
    const keep = createKeepStorage({
      storage: { persist: () => (asks++, Promise.resolve(true)) },
      log: (l) => lines.push(l),
    });
    keep();
    keep();
    keep();
    await Promise.resolve();
    await Promise.resolve();
    expect(asks).toBe(1);
    expect(lines).toEqual([
      "storage: persistent now — the browser will not clear installed scripts to make room",
    ]);
  });

  it("asks before anything is awaited, so the click still counts", () => {
    let asked = false;
    const keep = createKeepStorage({ storage: { persist: () => ((asked = true), Promise.resolve(false)) } });
    keep();
    expect(asked, "persist() was not called synchronously").toBe(true);
  });

  it("says so when the browser declines, and stays quiet when it cannot answer", async () => {
    const lines: string[] = [];
    createKeepStorage({ storage: { persist: () => Promise.resolve(false) }, log: (l) => lines.push(l) })();
    createKeepStorage({ storage: { persist: () => Promise.reject(new Error("no")) }, log: (l) => lines.push(l) })();
    createKeepStorage({
      storage: {
        persist: () => {
          throw new Error("no");
        },
      },
      log: (l) => lines.push(l),
    })();
    createKeepStorage({ storage: null, log: (l) => lines.push(l) })();
    createKeepStorage({ storage: {}, log: (l) => lines.push(l) })();
    await new Promise((r) => setTimeout(r, 0));
    expect(lines).toEqual(["storage: the browser declined to keep it for good; it stays best-effort"]);
  });
});

describe("where the page asks", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.ts"), "utf8");
  const bodyOf = (key: string): string => {
    const at = main.indexOf(`${key}: async (`);
    expect(at, `${key} not found`).toBeGreaterThan(-1);
    return main.slice(at, at + 400);
  };

  it("asks at the start of every install from the store, a url or a zip", () => {
    for (const key of ["install", "installUrl", "addScript", "addScriptFromUrl"]) {
      expect(bodyOf(key), `${key} does not ask`).toMatch(/keepStorage\(\);/);
    }
  });

  it("does not ask at boot: only install paths call it", () => {
    const calls = main.match(/keepStorage\(\);/g) ?? [];
    // install, installUrl, addScript, addScriptFromUrl, samples, maiden's ;install,
    // and (E9-227) a script's own download and the store's "get it here"
    expect(calls.length).toBe(8);
  });
});
