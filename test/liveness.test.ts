// E9-219 — a dead audio server is found, said once, and never mistaken for
// a page that is merely asleep.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createLiveness } from "../src/engine/liveness.js";

/** Let the probe's promise settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe("finding a dead server", () => {
  it("is dead after enough unanswered probes in a row, and says so once", async () => {
    const said: string[] = [];
    const l = createLiveness({
      probe: () => Promise.resolve(false),
      active: () => true,
      onDead: (why) => said.push(why),
      everyMs: 1000,
      strikes: 3,
    });
    for (let t = 0; t <= 10_000; t += 1000) {
      l.tick(t);
      await settle();
    }
    expect(l.dead).toBe(true);
    expect(said).toEqual(["it left 3 /sync in a row unanswered"]);
  });

  it("forgives a miss that is followed by an answer", async () => {
    const answers = [false, false, true, false, false, true];
    let i = 0;
    const l = createLiveness({
      probe: () => Promise.resolve(answers[i++ % answers.length]!),
      active: () => true,
      onDead: () => {},
      everyMs: 1000,
      strikes: 3,
    });
    for (let t = 0; t <= 6000; t += 1000) {
      l.tick(t);
      await settle();
    }
    expect(l.dead).toBe(false);
  });

  it("does not ask, or count, while no answer is owed", async () => {
    let asked = 0;
    let active = false;
    const l = createLiveness({
      probe: () => (asked++, Promise.resolve(false)),
      active: () => active,
      onDead: () => {},
      everyMs: 1000,
      strikes: 2,
    });
    for (let t = 0; t <= 5000; t += 1000) {
      l.tick(t);
      await settle();
    }
    expect(asked, "a suspended page was probed").toBe(0);
    active = true;
    l.tick(6000);
    await settle();
    expect(l.dead).toBe(false);
  });

  it("does not count a probe the page went away during", async () => {
    let active = true;
    const l = createLiveness({
      probe: () => {
        active = false; // hidden while waiting
        return Promise.resolve(false);
      },
      active: () => active,
      onDead: () => {},
      everyMs: 1000,
      strikes: 1,
    });
    l.tick(0);
    await settle();
    expect(l.dead).toBe(false);
  });

  it("takes a report from elsewhere, once", () => {
    const said: string[] = [];
    const l = createLiveness({
      probe: () => Promise.resolve(true),
      active: () => true,
      onDead: (why) => said.push(why),
    });
    l.report("it stopped completing /d_recv");
    l.report("again");
    expect(said).toEqual(["it stopped completing /d_recv"]);
  });

  it("asks one at a time, however often it is ticked", async () => {
    let asked = 0;
    let answer: (v: boolean) => void = () => {};
    const l = createLiveness({
      probe: () => (asked++, new Promise<boolean>((r) => (answer = r))),
      active: () => true,
      onDead: () => {},
      everyMs: 10,
    });
    for (let t = 0; t < 1000; t += 10) l.tick(t);
    expect(asked).toBe(1);
    answer(true);
    await settle();
  });
});

describe("the page", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.ts"), "utf8");
  const onDead = main.slice(main.indexOf("const liveness = createLiveness("), main.indexOf("let freeMb = 0;"));

  it("tells the user, with a restart, when the server dies", () => {
    expect(onDead).toMatch(/showServerDeadNotice\(/);
    expect(main).toMatch(/onDead: \(why\) => liveness\.report\(why\)/);
  });

  it("restarts the way norns does, into NO script, so a script that kills the server cannot loop", () => {
    expect(onDead).toMatch(/doRestart\(\)/);
    expect(onDead, "a clean shutdown would resume the script").not.toMatch(/clean_shutdown/);
  });

  it("restarts only when asked", () => {
    // doRestart is inside the button's callback, not run on death.
    const call = onDead.indexOf("doRestart()");
    const button = onDead.indexOf("showServerDeadNotice(() => {");
    expect(button).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(button);
  });
});
