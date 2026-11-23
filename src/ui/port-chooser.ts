// E9-205 — the list of serial ports, where the browser has none of its own.
//
// Chrome answers `navigator.serial.requestPort()` with a window of its own.
// The desktop application is Chromium without that window: Electron raises
// `select-serial-port` in the main process and waits to be told which. So
// the main process hands the list to the page (`window.__nornsChoosePort`),
// the page shows it in the panel the `usb` button is in, and the id that
// was clicked goes back.
//
// THE PAGE NEVER SEES A PORT IT WAS NOT SHOWN, and cannot open one from
// here: this returns a string, and the main process only accepts an id that
// was in the list it sent.
//
// A LIST THAT IS EMPTY SAYS WHY. The two reasons somebody is looking at an
// empty list are that nothing is plugged in and that the list is only of
// USB devices — a Bluetooth serial port is left out on purpose.

export interface PortChoice {
  /** What goes back to the main process. */
  readonly id: string;
  /** `FT230X Basic UART (COM5)`. */
  readonly name: string;
  /** What it might be, when the USB ids say. */
  readonly hint?: string;
}

/** The handful of DOM this needs, so a test can stand in for it. */
export interface ChooserElement {
  hidden: boolean;
  textContent: string | null;
  title: string;
  dataset: Record<string, string | undefined>;
  replaceChildren(...nodes: ChooserElement[]): void;
  append(...nodes: ChooserElement[]): void;
  addEventListener(type: "click", listener: () => void): void;
}

export interface PortChooser {
  /** Show the list; resolves with the id clicked, or "" for none. */
  choose(ports: readonly PortChoice[]): Promise<string>;
  /** A port was plugged in or pulled out while the list is open. */
  update(ports: readonly PortChoice[]): void;
  /** Close it with no choice. Harmless when it is not open. */
  cancel(): void;
  readonly open: boolean;
}

export const NOTHING_FOUND =
  "no usb serial device found — is it plugged in? (a grid or an arc: quit serialosc too)";

export function createPortChooser(opts: {
  /** The row that holds the list. Hidden when there is nothing to choose. */
  host: ChooserElement;
  create: (tag: "button" | "span") => ChooserElement;
  /** Called when the list opens, so the panel it lives in can be shown. */
  onOpen?: () => void;
}): PortChooser {
  let settle: ((id: string) => void) | null = null;

  const finish = (id: string): void => {
    const done = settle;
    settle = null;
    opts.host.hidden = true;
    opts.host.replaceChildren();
    done?.(id);
  };

  const draw = (ports: readonly PortChoice[]): void => {
    const nodes: ChooserElement[] = [];
    const label = opts.create("span");
    label.dataset["role"] = "label";
    label.textContent = ports.length === 0 ? NOTHING_FOUND : "which one?";
    nodes.push(label);
    for (const p of ports) {
      const b = opts.create("button");
      b.dataset["port"] = p.id;
      b.textContent = p.name;
      if (p.hint !== undefined) b.title = p.hint;
      b.addEventListener("click", () => finish(p.id));
      nodes.push(b);
    }
    const cancel = opts.create("button");
    cancel.dataset["cancel"] = "";
    cancel.textContent = ports.length === 0 ? "close" : "cancel";
    cancel.addEventListener("click", () => finish(""));
    nodes.push(cancel);
    opts.host.replaceChildren(...nodes);
  };

  return {
    get open() {
      return settle !== null;
    },
    choose(ports) {
      // One question at a time: a second one closes the first unanswered.
      if (settle !== null) finish("");
      draw(ports);
      opts.host.hidden = false;
      opts.onOpen?.();
      return new Promise<string>((resolve) => {
        settle = resolve;
      });
    },
    update(ports) {
      if (settle !== null) draw(ports);
    },
    cancel() {
      if (settle !== null) finish("");
    },
  };
}
