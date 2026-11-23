// E9-205 — the list of serial ports the desktop application shows.
//
// Electron has no port picker: it raises `select-serial-port` and waits to
// be told which. The main process hands the list to the page and the page
// answers with the id that was clicked — or with nothing, which is what a
// closed picker means to `requestPort()`.

import { describe, expect, it } from "vitest";
import { NOTHING_FOUND, createPortChooser, type ChooserElement } from "../src/ui/port-chooser.js";

interface Fake extends ChooserElement {
  tag: string;
  children: Fake[];
  click(): void;
}

function element(tag: string): Fake {
  const listeners: (() => void)[] = [];
  const e: Fake = {
    tag,
    hidden: false,
    textContent: "",
    title: "",
    dataset: {},
    children: [],
    replaceChildren: (...nodes) => void (e.children = nodes as Fake[]),
    append: (...nodes) => void e.children.push(...(nodes as Fake[])),
    addEventListener: (_type, l) => void listeners.push(l),
    click: () => listeners.forEach((l) => l()),
  };
  return e;
}

function chooser() {
  const host = element("div");
  host.hidden = true;
  let opened = 0;
  const c = createPortChooser({ host, create: (tag) => element(tag), onOpen: () => void opened++ });
  const ports = () => host.children.filter((n) => n.dataset["port"] !== undefined);
  const cancel = () => host.children.find((n) => "cancel" in n.dataset)!;
  const label = () => host.children.find((n) => n.dataset["role"] === "label")!;
  return { c, host, ports, cancel, label, opened: () => opened };
}

const GRID = { id: "p1", name: "FT230X Basic UART (COM5)", hint: "an FTDI serial chip — most grids and arcs are one" };
const CROW = { id: "p2", name: "USB Serial Device (COM7)" };

describe("choosing a serial port", () => {
  it("shows one button a port and answers with the one clicked", async () => {
    const t = chooser();
    const answer = t.c.choose([GRID, CROW]);
    expect(t.host.hidden).toBe(false);
    expect(t.opened()).toBe(1);
    expect(t.ports().map((b) => b.textContent)).toEqual([GRID.name, CROW.name]);
    expect(t.ports()[0]!.title).toBe(GRID.hint);
    expect(t.label().textContent).toBe("which one?");
    t.ports()[1]!.click();
    expect(await answer).toBe("p2");
    // Put away, and emptied: the next question starts from nothing.
    expect(t.host.hidden).toBe(true);
    expect(t.host.children).toEqual([]);
    expect(t.c.open).toBe(false);
  });

  it("answers with nothing when it is cancelled", async () => {
    const t = chooser();
    const answer = t.c.choose([GRID]);
    t.cancel().click();
    expect(await answer).toBe("");
    expect(t.host.hidden).toBe(true);
  });

  it("answers with nothing when the panel it lives in is put away", async () => {
    const t = chooser();
    const answer = t.c.choose([GRID]);
    t.c.cancel();
    expect(await answer).toBe("");
    // And cancelling what is not open is harmless.
    t.c.cancel();
  });

  it("says why when there is nothing to choose", async () => {
    const t = chooser();
    const answer = t.c.choose([]);
    expect(t.ports()).toEqual([]);
    expect(t.label().textContent).toBe(NOTHING_FOUND);
    expect(t.cancel().textContent).toBe("close");
    t.cancel().click();
    expect(await answer).toBe("");
  });

  it("follows a device plugged in while the list is open", async () => {
    const t = chooser();
    const answer = t.c.choose([]);
    t.c.update([GRID]);
    expect(t.ports().map((b) => b.dataset["port"])).toEqual(["p1"]);
    expect(t.label().textContent).toBe("which one?");
    t.ports()[0]!.click();
    expect(await answer).toBe("p1");
    // An update with no question open draws nothing.
    t.c.update([GRID, CROW]);
    expect(t.host.children).toEqual([]);
  });

  it("closes the first question unanswered when a second is asked", async () => {
    const t = chooser();
    const first = t.c.choose([GRID]);
    const second = t.c.choose([CROW]);
    expect(await first).toBe("");
    t.ports()[0]!.click();
    expect(await second).toBe("p2");
  });

  it("answers once: a click on a button already gone does nothing", async () => {
    const t = chooser();
    const answer = t.c.choose([GRID, CROW]);
    const [a, b] = t.ports();
    a!.click();
    b!.click();
    expect(await answer).toBe("p1");
  });
});
