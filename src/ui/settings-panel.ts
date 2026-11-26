// E6-10 — the gear.
//
// Two things to set, and they are different enough to deserve different
// shapes. Keys are a LIST: nine actions, each with however many keys the user
// wants on it, added by pressing the key rather than by picking its name out
// of a menu of two hundred codes. Layout is a MODE: you arrange it on the
// page itself, because a dialog with four number fields per device is a worse
// way to say "put the grid over there" than putting the grid over there.
//
// THE PANEL IS NOT MODAL. A modal dialog traps focus, and arranging needs the
// panel open and the devices reachable at the same time -- the toggle is in
// here and the dragging is out there. So it floats, and clicking outside it
// does not close it either, for the same reason: the first thing you do after
// turning arranging on is click on a device.
//
// CAPTURING A KEY IS A MODE TOO, and a short one: while it is on, a
// capture-phase listener on the window takes the keystroke before anything
// else sees it, so pressing Escape to cancel does not also press K2, and
// pressing 1 to bind it does not press K1 on the way in.

import {
  ACTIONS,
  bind,
  codesFor,
  keyLabel,
  unbind,
  type ActionId,
} from "./keymap.js";
import { COMPONENTS, COPYRIGHT, LICENCE, TRADEMARK, sourceUrl } from "./about.js";
import {
  INSTALL_AUDIO_MB_MAX,
  INSTALL_AUDIO_MB_MIN,
  INSTALL_FILES_MAX,
  INSTALL_FILES_MIN,
  VELOCITY_MAX,
  VELOCITY_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
  type SettingsStore,
  type PanelKind,
} from "./settings.js";
import { DEFAULT_MAX_AUDIO_MB, DEFAULT_MAX_FILES } from "../community/install.js";
import type { Stage } from "./stage.js";
import type { Detection, MachineKind, MachinePreference } from "./machine.js";

/**
 * EVERY FUNCTION IN HERE IS CALLED ON OPEN, NEVER AT CONSTRUCTION.
 *
 * The page builds this panel early — the gear has to work before the audio
 * graph, the MIDI manager or the editor exist, because the settings are
 * most wanted when something did not boot. So every option is a function
 * rather than a value, and none of them may be called while the panel is
 * being built: `main.ts` is still halfway through declaring itself, and a
 * `const` it has not reached yet is a temporal dead zone, not an undefined.
 *
 * That is not a theory. `paintPorts()` ran at construction, reached a
 * `const` declared 236 lines later, and the ReferenceError took the whole
 * rest of the boot with it — MIDI included — while the page still looked
 * perfectly normal. The same bug was put back within the hour by a
 * `markLoop()` in the same place. If you add an option here, paint it from
 * `setOpen(true)`.
 */
export interface SettingsPanelOptions {
  /** The gear button that opens it. */
  readonly button: HTMLElement;
  /** An empty container; everything inside it is built here. */
  readonly panel: HTMLElement;
  readonly settings: SettingsStore;
  readonly stage: Stage;
  /**
   * What `machine.ts` guessed, and what the page is using.
   *
   * Both are shown, because the guess is sometimes only a screen shape and
   * a user who can see WHY it chose is one who can tell whether to overrule
   * it. Optional, so a host without detection still gets a panel.
   */
  readonly machine?: {
    /** Read fresh: a gamepad appearing late can change the answer. */
    readonly detected: () => Detection;
    readonly effective: () => MachineKind;
  };
  /**
   * Getting the dust tree out and back in (E6-08). Optional, because the
   * panel is useful without it and a host that has no filesystem should not
   * have to invent one.
   */
  /**
   * The sound cards, and what to do when one is chosen.
   *
   * Passed IN rather than reached for: this file knows about lists and
   * buttons, and `main.ts` owns the audio graph the choice has to be
   * applied to. A panel that called `setSinkId` itself would be a panel
   * that had to be given the context.
   */
  readonly audio: {
    list(): Promise<{ outputs: { id: string; label: string }[]; inputs: { id: string; label: string }[]; named: boolean }>;
    canChooseOutput(): boolean;
    applyOutput(): Promise<void>;
    applyInput(): Promise<void>;
    grant(): Promise<void>;
    watch(fn: () => void): () => void;
    /** What went wrong last, for the line under the pickers. Empty when nothing did. */
    lastError(): string;
  };
  /**
   * The virtual loopback: a cable with both ends in the same box.
   *
   * IT LIVES HERE AND NOT IN THE RAIL (user, 2026-11-13). Its icon was a
   * cable looping back on itself, which reads as a circular arrow, and the
   * restart button is a circular arrow — two round arrows in one column of
   * six is a rail you read instead of recognise. It is also the rarer of
   * the two and a setting rather than a gesture.
   */
  readonly loopback?: {
    on(): boolean;
    toggle(): void;
  };
  /**
   * Called as the panel OPENS, before it is shown (E9-93).
   *
   * One rail panel at a time. The rail's other panels are popovers that
   * close each other through a document click listener; this one is not a
   * popover — it stays open while you click on a device, because arranging
   * needs it to. So the host is told when it opens, and closes the rest.
   */
  readonly onOpen?: () => void;
  /** Every MIDI port Web MIDI can see. Read-only: see the ports section. */
  readonly midiPorts?: () => { name: string; direction: string }[];
  readonly files?: {
    /** `everything` includes the files the build supplies. */
    export(everything: boolean): Promise<void>;
    /** Put an export back: the zip's own paths, under `~/dust`. */
    restore(bytes: Uint8Array, name: string): Promise<void>;
    /** Add ONE script: the wrapper folder stripped, rehomed under `code/`. */
    addScript(bytes: Uint8Array, name: string): Promise<void>;
    /** E9-211 — a sample pack: the zip's own paths, under `~/dust/audio`. */
    addSamples?(bytes: Uint8Array, name: string): Promise<void>;
    /** The same, from a URL. */
    addScriptFromUrl(url: string): Promise<void>;
    /**
     * E9-142 — put `~/dust/code` back to what the build ships, and restart.
     *
     * Optional like the rest of `files`: a host with no dust tree has
     * nothing to reset, and the section is simply not built.
     */
    resetScripts?(): Promise<{ scripts: number; files: number }>;
    /** How many are installed, for the confirm button to name. */
    installed?(): number;
    /**
     * E9-143 — every script's presets and MIDI mappings, then a restart.
     *
     * `system.state` and `system.pset` are spared: they live in the same
     * directory and they are not a script's.
     */
    resetParams?(): Promise<{ files: number }>;
    /**
     * E9-143 — erase this origin entirely and reload.
     *
     * Answers `{ ok: false }` when the browser refuses to give up its
     * storage, so the panel can say so instead of appearing to work.
     */
    factoryReset?(): Promise<{ ok: boolean }>;
    /**
     * E9-143 — the clock tempo, which lives at PARAMS > CLOCK > tempo.
     *
     * Here as well because that path is four panels into a screen that a
     * struggling page cannot draw, and this panel is HTML.
     */
    tempo?: {
      /** 0 when Lua has not answered — the row hides itself. */
      get(): number;
      set(bpm: number): void;
    };
  };
}

export interface SettingsPanel {
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
  destroy(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls !== undefined) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function createSettingsPanel(opts: SettingsPanelOptions): SettingsPanel {
  const { panel, settings, stage } = opts;
  const ac = new AbortController();
  const signal = ac.signal;

  /** Which action is waiting for a keystroke, or null. */
  let capturing: ActionId | null = null;
  let open = false;

  // --- structure --------------------------------------------------------

  panel.textContent = "";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "settings");

  const head = el("div", "sp-head");
  head.append(el("strong", undefined, "settings"));
  const closeBtn = el("button", "sp-x", "×");
  closeBtn.setAttribute("aria-label", "close settings");
  head.append(closeBtn);
  panel.append(head);

  // --- tabs --------------------------------------------------------------
  //
  // The panel grew past the point where scrolling it was navigation. Five
  // categories, one visible at a time, and the tab strip is the whole
  // table of contents -- which a long scroll never was.
  //
  // A SECTION IS STILL A SECTION. Each tab holds the markup that used to be
  // stacked, unchanged, so nothing here has to know what is inside one.
  const tabBar = el("div", "sp-tabs");
  tabBar.setAttribute("role", "tablist");
  const panes = new Map<string, HTMLElement>();
  const tabs = new Map<string, HTMLElement>();
  let active = "controls";

  const showTab = (id: string): void => {
    active = id;
    for (const [key, pane] of panes) pane.hidden = key !== id;
    for (const [key, tab] of tabs) {
      tab.setAttribute("aria-selected", String(key === id));
      tab.tabIndex = key === id ? 0 : -1;
    }
  };

  const addTab = (id: string, label: string): HTMLElement => {
    const tab = el("button", "sp-tab", label);
    tab.setAttribute("role", "tab");
    tab.addEventListener("click", () => showTab(id));
    tabBar.append(tab);
    tabs.set(id, tab);
    const pane = el("div", "sp-pane");
    pane.setAttribute("role", "tabpanel");
    panes.set(id, pane);
    return pane;
  };

  const controlsPane = addTab("controls", "controls");
  const displayPane = addTab("display", "display");
  const audioPane = addTab("audio", "audio");
  const midiPane = addTab("midi", "midi");
  const filesPane = addTab("files", "files");
  const aboutPane = addTab("about", "about");
  panel.append(tabBar);
  for (const pane of panes.values()) panel.append(pane);

  // --- keyboard ---------------------------------------------------------

  const keysSection = el("section", "sp-section");
  const keysHead = el("div", "sp-section-head");
  // "shortcuts", not "keyboard": there is a MIDI keyboard now, and one
  // word for both would be the `device` mistake again.
  keysHead.append(el("h2", undefined, "shortcuts"));
  const keysReset = el("button", "sp-reset", "reset");
  keysHead.append(keysReset);
  keysSection.append(keysHead);

  const rows = el("div", "sp-rows");
  keysSection.append(rows);

  const hint = el(
    "p",
    "sp-hint",
    "bindings are by key POSITION, so they hold on any layout. add a key, then press it.",
  );
  keysSection.append(hint);
  controlsPane.append(keysSection);

  // --- layout -----------------------------------------------------------

  const layoutSection = el("section", "sp-section");
  const layoutHead = el("div", "sp-section-head");
  layoutHead.append(el("h2", undefined, "layout"));
  const layoutReset = el("button", "sp-reset", "reset");
  layoutHead.append(layoutReset);
  layoutSection.append(layoutHead);

  // Encoder feel lives with the other things your hands do, not with the
  // layout: norns' own per-encoder `set_sens` is a script's business and
  // scripts set it themselves, while this is the hand on the knob.
  const sensSection = el("section", "sp-section");
  sensSection.append(el("h2", undefined, "knobs"));
  sensSection.append(el("p", "sp-sub", "knob sensitivity"));
  const sensRow = el("div", "sp-row");
  const sens = el("input", "sp-range") as HTMLInputElement;
  sens.type = "range";
  sens.min = "0.25";
  sens.max = "4";
  sens.step = "0.25";
  sens.value = String(settings.encoderSensitivity);
  const sensValue = el("span", "sp-num", `${settings.encoderSensitivity}×`);
  const markSens = (): void => {
    sens.value = String(settings.encoderSensitivity);
    sensValue.textContent = `${settings.encoderSensitivity}×`;
  };
  sens.addEventListener("input", () => {
    settings.setEncoderSensitivity(Number(sens.value));
    markSens();
  });
  sensRow.append(sens, sensValue);
  sensSection.append(sensRow);
  controlsPane.append(sensSection);

  // WHICH NORNS, and it comes before `machine` because it is the more
  // visible of the two: one changes a picture you are looking at, the other
  // changes defaults you may never notice.
  //
  // The note carries the numbers rather than an adjective. "Bigger" is not
  // a reason to change what your instrument looks like; 1.58x of screen is.
  layoutSection.append(el("p", "sp-sub", "body"));
  const panelRow = el("div", "sp-row sp-choice");
  const panelNote = el(
    "div",
    "sp-note",
    "at the same width the shield's screen is 1.58x wider and its encoders " +
      "1.73x bigger; its body is squarer, so it is taller too",
  );
  const panelButtons = new Map<PanelKind, HTMLElement>();
  const markPanel = (): void => {
    for (const [value, b] of panelButtons) {
      b.setAttribute("aria-pressed", String(settings.panel === value));
    }
  };
  for (const [value, label] of [
    ["shield", "shield"],
    ["norns", "norns"],
  ] as ReadonlyArray<[PanelKind, string]>) {
    const b = el("button", "sp-toggle", label);
    b.addEventListener("click", () => {
      settings.setPanel(value);
      markPanel();
    });
    panelButtons.set(value, b);
    panelRow.append(b);
  }
  markPanel();
  layoutSection.append(panelRow, panelNote);

  // Which machine to lay out for. `auto` first, because it is right most of
  // the time and the other three exist for when it is not.
  //
  // The word is "machine" and not "device" because this panel already has
  // "arrange devices", which moves the norns and the grid around the stage.
  // One word for both meanings made a panel that offered `device` twice.
  if (opts.machine) {
    const { detected, effective } = opts.machine;
    layoutSection.append(el("p", "sp-sub", "machine"));
    const deviceRow = el("div", "sp-row sp-choice");
    const note = el("div", "sp-note", "");
    const choices: ReadonlyArray<[MachinePreference, string]> = [
      ["auto", "auto"],
      ["normal", "normal"],
      ["phone", "phone"],
      ["steamdeck", "steam deck"],
    ];
    const buttons = new Map<MachinePreference, HTMLElement>();
    const markDevice = (): void => {
      for (const [value, b] of buttons) {
        b.setAttribute("aria-pressed", String(settings.machine === value));
      }
      const d = detected();
      note.textContent =
        settings.machine === "auto"
          ? `detected ${d.kind} — ${d.why}`
          : `forced — ${effective()} layout${d.kind === settings.machine ? ", which is also what was detected" : `, detected ${d.kind}`}`;
    };
    for (const [value, label] of choices) {
      const b = el("button", "sp-toggle", label);
      b.addEventListener("click", () => {
        settings.setMachine(value);
        markDevice();
      });
      buttons.set(value, b);
      deviceRow.append(b);
    }
    markDevice();
    layoutSection.append(deviceRow, note);
  }

  // How big everything is drawn. Beside `machine` because the two answer
  // the same question from different ends: what this screen is, and how
  // much of it to use.
  //
  // E9-61 — A BAR, the same control as the one under the magnifier in the
  // rail. It was − % + fit, which is four presses to cross the range and
  // no sense of where in it you are; zoom is a thing you overshoot and come
  // back from. The two are the same setting and move together, because
  // both read and write `settings.zoom` and the store tells everyone.
  layoutSection.append(el("p", "sp-sub", "zoom"));
  const zoomRow = el("div", "sp-row");
  const zoomBar = el("input", "sp-range") as HTMLInputElement;
  zoomBar.type = "range";
  zoomBar.min = String(Math.round(ZOOM_MIN * 100));
  zoomBar.max = String(Math.round(ZOOM_MAX * 100));
  zoomBar.step = "5";
  zoomBar.setAttribute("aria-label", "page zoom, in percent");
  const zoomLabel = el("span", "sp-num", "");
  const zoomReset = el("button", "sp-toggle", "100%");
  const markZoom = (): void => {
    const pct = Math.round(settings.zoom * 100);
    zoomBar.value = String(pct);
    zoomLabel.textContent = `${pct}%`;
  };
  zoomBar.addEventListener("input", () => {
    settings.setZoom(Number(zoomBar.value) / 100);
    markZoom();
  });
  zoomReset.addEventListener("click", () => {
    settings.setZoom(1);
    markZoom();
  });
  zoomRow.append(zoomBar, zoomLabel, zoomReset);
  markZoom();
  layoutSection.append(zoomRow);
  layoutSection.append(
    el("p", "sp-hint", "ctrl and the wheel, or a pinch, do the same thing anywhere on the page."),
  );
  // The rail's bar and this one are two views of one number, so a change
  // made in either has to show in the other the next time it is opened.
  settings.subscribe((_s, what) => {
    if (what === "zoom") markZoom();
  });

  const arrangeRow = el("div", "sp-row");
  const arrangeBtn = el("button", "sp-toggle", "arrange devices");
  arrangeBtn.setAttribute("aria-pressed", "false");
  arrangeRow.append(arrangeBtn);
  layoutSection.append(arrangeRow);
  layoutSection.append(
    el(
      "p",
      "sp-hint",
      "while arranging, drag a device to move it and its corner to resize it. " +
        "the controls are inert until you turn it off. arrows nudge, [ and ] resize.",
    ),
  );
  displayPane.append(layoutSection);

  // --- the virtual MIDI keyboard ------------------------------------------
  //
  // The controls live HERE and not on the keyboard itself, which now only
  // reads out what they say. A device whose face is half instrument and
  // half control panel is two things; the panel is where settings go.
  //
  // They work whether or not the keyboard is plugged in, because they are
  // settings rather than commands — plug it in afterwards and it starts
  // where you left it.
  const midiSection = el("section", "sp-section");
  const midiHead = el("div", "sp-section-head");
  midiHead.append(el("h2", undefined, "keyboard"));
  const midiReset = el("button", "sp-reset", "reset");
  midiHead.append(midiReset);
  midiSection.append(midiHead);
  midiSection.append(
    el("p", "sp-hint", "the two-octave keyboard in the toolbar. these are remembered."),
  );

  /**
   * A slider between two labelled ends, with its value beside it.
   *
   * The ends are SHOWN rather than discovered by pushing a button until it
   * stops. A stepper hides the range: you learn that velocity cannot go
   * below 1 by finding the button greyed out, which is the interface
   * teaching you by refusing you.
   */
  const slider = (
    label: string,
    lo: number,
    hi: number,
    lowEnd: string,
    highEnd: string,
    read: () => number,
    show: () => string,
    write: (value: number) => void,
  ): (() => void) => {
    midiSection.append(el("p", "sp-sub", label));
    const row = el("div", "sp-row");
    const input = el("input", "sp-range") as HTMLInputElement;
    input.type = "range";
    input.min = String(lo);
    input.max = String(hi);
    input.step = "1";
    const value = el("span", "sp-num", "");
    const paint = (): void => {
      input.value = String(read());
      value.textContent = show();
    };
    input.addEventListener("input", () => {
      write(Number(input.value));
      paint();
    });
    row.append(el("span", "sp-lim", lowEnd), input, el("span", "sp-lim", highEnd), value);
    midiSection.append(row);
    paint();
    return paint;
  };

  const markOctave = slider(
    "octave",
    -1,
    7,
    "C-1",
    "C7",
    () => settings.midiOctave,
    () => `C${settings.midiOctave}`,
    (v) => settings.setMidiOctave(v),
  );
  const markVelocity = slider(
    "velocity",
    VELOCITY_MIN,
    VELOCITY_MAX,
    String(VELOCITY_MIN),
    String(VELOCITY_MAX),
    () => settings.midiVelocity,
    () => String(settings.midiVelocity),
    (v) => settings.setMidiVelocity(v),
  );

  // No sentence here about velocity never reaching zero: the slider's own
  // low end says `1`, and a line explaining a bound the user can see is
  // the interface talking about itself.
  // Back to middle C and a middling strike. Notes already sounding are the
  // keyboard's business, not this button's: velocity rides on the note on,
  // and a reset that silenced what was playing would be a panic button
  // wearing a reset's label.
  midiReset.addEventListener("click", () => {
    settings.setMidiOctave(4);
    settings.setMidiVelocity(100);
    markOctave();
    markVelocity();
  });
  midiPane.append(midiSection);

  // --- files (E6-08) ------------------------------------------------------
  //
  // TWO JOBS, NOT THREE BUTTONS. This used to read `export`, `import…` and
  // `install`, which named mechanisms and hid the difference that matters:
  //
  //   import   writes a zip's files AT THE PATHS THEY HAVE, under ~/dust.
  //            It is the inverse of export, for putting a backup back.
  //   install  strips the archive's wrapper folder and rehomes everything
  //            under code/<name>. It is for a zip as GitHub hands it over.
  //
  // Nothing said so, and a second difference was bolted on top: import took
  // only a FILE and install took only a URL. So the hint under install --
  // "download the zip yourself and use import" -- gave advice that produced
  // a broken result: a GitHub zip imported that way lands in
  // ~/dust/myscript-main/, outside code/, where SELECT never looks.
  //
  // So: two groups named after what somebody wants to do, and adding a
  // script can now start from a file, which is what that hint needed all
  // along.

  if (opts.files) {
    const f = opts.files;

    const busy = async (b: HTMLElement, label: string, job: () => Promise<void>): Promise<void> => {
      const was = b.textContent;
      b.textContent = label;
      (b as HTMLButtonElement).disabled = true;
      try {
        await job();
      } finally {
        b.textContent = was;
        (b as HTMLButtonElement).disabled = false;
      }
    };

    /**
     * A real file input behind a button.
     *
     * The browser will not open a picker for anything else, and it must be
     * the user who chooses. One per use: sharing a single input between two
     * buttons means the second one inherits whatever the first selected.
     */
    const chooser = (
      button: HTMLElement,
      take: (bytes: Uint8Array, name: string) => Promise<void>,
    ): HTMLInputElement => {
      const picker = el("input") as HTMLInputElement;
      picker.type = "file";
      picker.accept = ".zip,application/zip";
      picker.hidden = true;
      button.addEventListener("click", () => picker.click(), { signal });
      picker.addEventListener(
        "change",
        () => {
          const file = picker.files?.[0];
          if (!file) return;
          void busy(button, "…", async () => {
            const bytes = new Uint8Array(await file.arrayBuffer());
            await take(bytes, file.name);
            // Cleared so choosing the SAME file again fires `change` again.
            picker.value = "";
          });
        },
        { signal },
      );
      return picker;
    };

    // --- back up and restore
    const backup = el("section", "sp-section");
    backup.append(el("h2", undefined, "back up and restore"));

    const row1 = el("div", "sp-row");
    const expBtn = el("button", "sp-toggle", "export");
    expBtn.title = "a zip of everything you have changed";
    const expAllBtn = el("button", "sp-reset", "export all");
    expAllBtn.title = "the whole tree, bundled scripts included";
    row1.append(expBtn, expAllBtn);
    backup.append(row1);
    backup.append(
      el("p", "sp-hint", "saves your scripts, presets and tapes to a zip file."),
    );

    const row2 = el("div", "sp-row");
    const restoreBtn = el("button", "sp-toggle", "restore from a zip…");
    row2.append(restoreBtn, chooser(restoreBtn, (b, n) => f.restore(b, n)));
    backup.append(row2);
    backup.append(el("p", "sp-hint", "puts an export back, exactly as it was."));
    filesPane.append(backup);

    // --- add a script
    const add = el("section", "sp-section");
    add.append(el("h2", undefined, "add a script"));

    const row3 = el("div", "sp-row");
    const addFileBtn = el("button", "sp-toggle", "from a zip…");
    row3.append(addFileBtn, chooser(addFileBtn, (b, n) => f.addScript(b, n)));
    add.append(row3);
    add.append(
      el("p", "sp-hint", "a script you have downloaded, for example from github."),
    );

    const row4 = el("div", "sp-row");
    const url = el("input", "sp-url") as HTMLInputElement;
    url.type = "url";
    url.placeholder = "https://…/script.zip";
    const fetchBtn = el("button", "sp-reset", "fetch");
    row4.append(url, fetchBtn);
    add.append(row4);
    add.append(
      el("p", "sp-hint", "most sites refuse this. if it fails, download the zip and use the button above."),
    );
    filesPane.append(add);

    // --- add samples (E9-211)
    if (f.addSamples !== undefined) {
      const addSamples = f.addSamples;
      const samples = el("section", "sp-section");
      samples.append(el("h2", undefined, "add samples"));
      const row5 = el("div", "sp-row");
      const samplesBtn = el("button", "sp-toggle", "from a zip…");
      row5.append(samplesBtn, chooser(samplesBtn, (b, n) => addSamples(b, n)));
      samples.append(row5);
      samples.append(
        el(
          "p",
          "sp-hint",
          "a sample pack a script tells you to unzip in ~/dust/audio — moonraker's, for example. it goes there, folders and all.",
        ),
      );
      filesPane.append(samples);
    }

    expBtn.addEventListener("click", () => void busy(expBtn, "…", () => f.export(false)), { signal });
    expAllBtn.addEventListener("click", () => void busy(expAllBtn, "…", () => f.export(true)), { signal });
    fetchBtn.addEventListener(
      "click",
      () => {
        const u = url.value.trim();
        if (u === "") return;
        void busy(fetchBtn, "…", () => f.addScriptFromUrl(u));
      },
      { signal },
    );
  }

  // --- installing (E9-72) -------------------------------------------------
  //
  // A judgement rather than a fact, like the audio limit below it (E9-261);
  // the others in `install.ts` count BYTES of images and data.
  // This one counted FILES, at 400, and measuring it against the catalogue
  // showed what was inside the guess: of the 351 repositories that list,
  // exactly one is over 400 — `mosaic`, at 1209 — and the next largest is
  // `pirate-radio` at 239. It refused one script in 355 and stopped
  // nothing else.
  //
  // So it is here, where the person whose connection and whose storage it
  // is can move it, and it starts at 2000.
  const install = el("section", "sp-section");
  install.append(el("h2", undefined, "installing"));
  install.append(el("p", "sp-sub", "most files an install will take"));
  const maxRow = el("div", "sp-row");
  const maxFiles = el("input", "sp-count") as HTMLInputElement;
  maxFiles.type = "number";
  maxFiles.min = String(INSTALL_FILES_MIN);
  maxFiles.max = String(INSTALL_FILES_MAX);
  maxFiles.step = "50";
  maxFiles.value = String(settings.installMaxFiles);
  const maxUnit = el("span", "sp-sub", "files");
  const maxReset = el("button", "sp-reset", "default");
  const markMax = (): void => {
    maxFiles.value = String(settings.installMaxFiles);
    maxReset.disabled = settings.installMaxFiles === DEFAULT_MAX_FILES;
  };
  // ON `change`, NOT ON `input`. A number field is typed INTO: "1500" is
  // "1", "15", "150", "1500", and clamping each of those to the minimum as
  // it is typed takes the field away from the person using it.
  maxFiles.addEventListener(
    "change",
    () => {
      settings.setInstallMaxFiles(Number(maxFiles.value));
      markMax();
    },
    { signal },
  );
  maxReset.addEventListener(
    "click",
    () => {
      settings.setInstallMaxFiles(DEFAULT_MAX_FILES);
      markMax();
    },
    { signal },
  );
  maxRow.append(maxFiles, maxUnit, maxReset);
  install.append(maxRow);
  install.append(
    el(
      "p",
      "sp-hint",
      "a repository with more files than this is refused before anything is downloaded. " +
        "the largest script in the catalogue is mosaic, at 1209 files; the next is 239.",
    ),
  );
  markMax();

  // E9-261 — the sound one install will take. Past it, the rest of the
  // samples are skipped and the install says which.
  install.append(el("p", "sp-sub", "most audio an install will take"));
  const audioRow = el("div", "sp-row");
  const maxAudio = el("input", "sp-count") as HTMLInputElement;
  maxAudio.type = "number";
  maxAudio.min = String(INSTALL_AUDIO_MB_MIN);
  maxAudio.max = String(INSTALL_AUDIO_MB_MAX);
  maxAudio.step = "64";
  const audioUnit = el("span", "sp-sub", "MB");
  const audioReset = el("button", "sp-reset", "default");
  const markAudio = (): void => {
    maxAudio.value = String(settings.installMaxAudioMb);
    audioReset.disabled = settings.installMaxAudioMb === DEFAULT_MAX_AUDIO_MB;
  };
  // On `change`, for the same reason as the count above.
  maxAudio.addEventListener(
    "change",
    () => {
      settings.setInstallMaxAudioMb(Number(maxAudio.value));
      markAudio();
    },
    { signal },
  );
  audioReset.addEventListener(
    "click",
    () => {
      settings.setInstallMaxAudioMb(DEFAULT_MAX_AUDIO_MB);
      markAudio();
    },
    { signal },
  );
  audioRow.append(maxAudio, audioUnit, audioReset);
  install.append(audioRow);
  install.append(
    el(
      "p",
      "sp-hint",
      "samples past this are left on the server and the install says so. " +
        "the most in the catalogue is nc01-drone, at 118 MB.",
    ),
  );
  markAudio();
  filesPane.append(install);

  // --- starting again (E9-142, E9-143) ------------------------------------
  //
  // THREE BUTTONS AND THEY ARE NOT THE SAME SIZE. Asked for one at a time
  // (user, 2026-11-19) and each with its own scope, which is the point:
  // "reset" with no object is the kind of button people press once and
  // regret, so each says what it takes and the hint under it says what it
  // leaves.
  //
  //   the scripts        ~/dust/code         presets and settings stay
  //   their parameters   ~/dust/data/*       the scripts themselves stay
  //   factory defaults   everything          nothing stays
  //
  // ONE PATTERN FOR ALL THREE. Two clicks in place: the rail's restart
  // earns a popover because it is a rail button with no room for a
  // sentence, and these sit in a pane that can hold one. The second label
  // says what is about to happen rather than "are you sure", and it
  // disarms itself after six seconds, because a button left armed behind
  // a closed panel is a trap.
  const danger = (
    into: HTMLElement,
    safe: string,
    confirm: () => string,
    run: () => Promise<unknown>,
  ): HTMLButtonElement => {
    const row = el("div", "sp-row");
    const btn = el("button", "sp-toggle sp-danger", safe) as HTMLButtonElement;
    row.append(btn);
    into.append(row);
    let armed: ReturnType<typeof setTimeout> | null = null;
    const disarm = (): void => {
      if (armed !== null) clearTimeout(armed);
      armed = null;
      btn.textContent = safe;
      btn.classList.remove("sp-armed");
    };
    btn.addEventListener(
      "click",
      () => {
        if (armed === null) {
          btn.textContent = confirm();
          btn.classList.add("sp-armed");
          armed = setTimeout(disarm, 6000);
          return;
        }
        disarm();
        btn.disabled = true;
        btn.textContent = "…";
        // The page restarts or reloads on success, so there is no success
        // branch to write. A failure has to put the button back, or the
        // only way out is a reload the user did not ask for.
        void run().catch(() => {
          btn.disabled = false;
          btn.textContent = safe;
        });
      },
      { signal },
    );
    return btn;
  };

  if (opts.files?.resetScripts || opts.files?.resetParams || opts.files?.factoryReset) {
    const reset = el("section", "sp-section");
    reset.append(el("h2", undefined, "starting again"));

    if (opts.files?.resetScripts) {
      danger(
        reset,
        "remove every installed script",
        () => {
          const n = opts.files?.installed?.() ?? 0;
          return n === 0 ? "yes, empty it" : `yes, remove ${n} script${n === 1 ? "" : "s"}`;
        },
        async () => await opts.files?.resetScripts?.(),
      );
      reset.append(
        el(
          "p",
          "sp-hint",
          "empties ~/dust/code and any half-finished downloads, then restarts. " +
            "presets, tapes and settings are not touched.",
        ),
      );
    }

    if (opts.files?.resetParams) {
      danger(
        reset,
        "reset every script's parameters",
        () => "yes, forget every preset",
        async () => await opts.files?.resetParams?.(),
      );
      reset.append(
        el(
          "p",
          "sp-hint",
          "empties ~/dust/data, so every script comes back at its defaults. " +
            "the scripts themselves stay installed, and so do the clock, the " +
            "mixer and your devices.",
        ),
      );
    }

    if (opts.files?.factoryReset) {
      danger(
        reset,
        "factory defaults",
        () => "yes, erase everything",
        async () => await opts.files?.factoryReset?.(),
      );
      reset.append(
        el(
          "p",
          "sp-hint",
          "erases everything this page has saved — scripts, presets, tapes, " +
            "recordings and every setting — and reloads. there is nothing left " +
            "to undo it with, so export first if you want any of it back.",
        ),
      );
    }

    filesPane.append(reset);
  }

  // --- about (E7-08) ------------------------------------------------------
  //
  // The AGPL's §13: software interacted with over a network must OFFER its
  // source to the people using it. A licence file in a repository nobody
  // can find does not do that; a link from the running program does.

  const about = el("section", "sp-section");
  about.append(el("h2", undefined, "about"));
  const line = el("p", "sp-about");
  line.append(el("strong", undefined, "norns-js"));
  line.append(document.createTextNode(` — ${LICENCE}, ${COPYRIGHT}. `));
  const src = sourceUrl();
  if (src === null) {
    // Said plainly rather than hidden: a deploy without this is a deploy
    // that does not meet the licence it ships under.
    const warn = el("span", "sp-nosource", "source: not configured (VITE_SOURCE_URL)");
    line.append(warn);
  } else {
    const a = el("a", "sp-link", "source");
    a.href = src;
    a.target = "_blank";
    a.rel = "noreferrer";
    line.append(a);
  }
  about.append(line);
  // E9-75 — the long form, linked rather than summarised.
  //
  // `public/NOTICES.txt` is generated from what the build actually links
  // and carries every licence text in full, read out of the tree the
  // binaries were built from. The line below used to end "listed in the
  // source", which asked somebody to go and find a repository to read a
  // file that is already being served to them.
  const notices = el("p", "sp-hint");
  notices.append(
    document.createTextNode(`built on ${COMPONENTS.map((c) => c.what).join(", ")} — each `),
  );
  const nlink = el("a", "sp-link", "under its own licence");
  nlink.href = "NOTICES.txt";
  nlink.target = "_blank";
  nlink.rel = "noreferrer";
  notices.append(nlink);
  notices.append(
    document.createTextNode(
      ". A script you install is its author's work and keeps its own terms.",
    ),
  );
  about.append(notices);
  about.append(el("p", "sp-hint", TRADEMARK));
  aboutPane.append(about);

  const storageNote = el(
    "p",
    "sp-warn",
    "this browser is not keeping settings (private window, or site data blocked) — " +
      "changes last until the page is reloaded.",
  );
  storageNote.hidden = settings.persisted;
  panel.append(storageNote);

  // --- the keyboard rows, rebuilt whenever the map changes ---------------

  function drawRows(): void {
    rows.textContent = "";
    const map = settings.keymap;
    for (const action of ACTIONS) {
      const row = el("div", "sp-row");
      row.append(el("span", "sp-act", action.label));

      const chips = el("span", "sp-chips");
      const codes = codesFor(map, action.id);
      if (codes.length === 0) chips.append(el("span", "sp-none", "unbound"));
      for (const code of codes) {
        const chip = el("button", "sp-chip");
        chip.append(el("kbd", undefined, keyLabel(code)));
        chip.append(el("span", "sp-chip-x", "×"));
        chip.title = `remove ${code}`;
        chip.addEventListener("click", () => {
          settings.setKeymap(unbind(settings.keymap, code));
          drawRows();
        });
        chips.append(chip);
      }
      row.append(chips);

      const add = el("button", "sp-add", capturing === action.id ? "press a key…" : "+");
      add.title = `bind a key to ${action.label}`;
      if (capturing === action.id) add.classList.add("capturing");
      add.addEventListener("click", () => {
        capturing = capturing === action.id ? null : action.id;
        drawRows();
      });
      row.append(add);
      rows.append(row);
    }
  }

  /**
   * The keystroke that binds.
   *
   * Capture phase and `stopImmediatePropagation`, so norns never sees it: the
   * key being bound is almost always one that already does something, and
   * binding it by pressing it should not also press it.
   */
  globalThis.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (capturing === null) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const code = e.code;
      if (code === "Escape") {
        capturing = null;
        drawRows();
        return;
      }
      // A bare modifier can be bound (shift is K1 by default), but a
      // modifier COMBINATION cannot: the core ignores those, so binding one
      // would produce a row that never fires.
      const isModifierItself = /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code);
      if (!isModifierItself && (e.ctrlKey || e.metaKey || e.altKey)) return;
      settings.setKeymap(bind(settings.keymap, code, capturing));
      capturing = null;
      drawRows();
    },
    { capture: true, signal },
  );

  keysReset.addEventListener(
    "click",
    () => {
      settings.resetKeymap();
      capturing = null;
      drawRows();
    },
    { signal },
  );

  layoutReset.addEventListener(
    "click",
    () => {
      stage.reset();
      settings.setEncoderSensitivity(1);
      markSens();
    },
    { signal },
  );

  arrangeBtn.addEventListener(
    "click",
    () => {
      const on = !stage.arranging;
      stage.setArranging(on);
      arrangeBtn.setAttribute("aria-pressed", String(on));
    },
    { signal },
  );

  // --- opening ----------------------------------------------------------

  /**
   * Painted when the panel opens, for the same reason `paintPorts` is.
   *
   * A section built after this point cannot be named inside `setOpen`
   * without hoisting it, and the file's own rule is that nothing calls
   * back into the host at construction time.
   */
  const onOpenHooks: Array<() => void> = [];

  const setOpen = (on: boolean): void => {
    open = on;
    // PAINTED ON OPENING AND NOT AT CONSTRUCTION, which is not a style
    // choice. The panel is built early — before the MIDI manager and the
    // audio graph exist — and calling back into the host from a
    // constructor couples this file to the ORDER its host declares things
    // in. It did: `paintPorts()` ran at construction, reached a `const`
    // that main.ts declares two hundred lines later, and the temporal dead
    // zone threw a ReferenceError that took the whole of the rest of the
    // boot with it, MIDI included. A panel nobody is looking at has
    // nothing to paint anyway.
    if (on) {
      opts.onOpen?.();
      loopMark();
      paintPorts();
      void paintAudio();
      for (const h of onOpenHooks) h();
    }
    panel.hidden = !on;
    opts.button.setAttribute("aria-expanded", String(on));
    if (!on) {
      capturing = null;
      // Leaving the panel leaves arrange mode: the devices are inert while
      // it is on, and a user who closed the panel and found nothing worked
      // would have no way to guess why.
      if (stage.arranging) {
        stage.setArranging(false);
        arrangeBtn.setAttribute("aria-pressed", "false");
      }
      drawRows();
    }
  };

  opts.button.addEventListener("click", () => setOpen(!open), { signal });
  closeBtn.addEventListener("click", () => setOpen(false), { signal });

  drawRows();
  setOpen(false);

  // --- audio devices (E9-15) ---------------------------------------------
  //
  // Which sound card plays, and which one records.
  //
  // THE MICROPHONE PERMISSION IS THE WHOLE OF THE DESIGN HERE, and it is
  // stated on screen rather than worked around. Device enumeration is gated
  // on it even when all you want is to choose a SPEAKER: refused, the
  // browser hands back one output and one input with an empty id and no
  // name, which is a list with nothing in it. `selectAudioOutput()` is the
  // native picker that would avoid the whole problem and it does not exist
  // in Chromium 156, so there is no better door to take.
  //
  // So the panel asks, and says why it is asking. In a tab that is a
  // browser prompt; in the desktop application the shell has granted it
  // already and nothing appears. The button disappears once it has worked.
  const audioSection = el("section", "sp-section");
  audioSection.append(el("h2", undefined, "devices"));
  const audioHint = el("p", "sp-hint", "");
  const outRow = el("div", "sp-row");
  outRow.append(el("span", "sp-sub", "out"));
  const outSelect = el("select", "sp-dev");
  outRow.append(outSelect);
  const inRow = el("div", "sp-row");
  inRow.append(el("span", "sp-sub", "in"));
  const inSelect = el("select", "sp-dev");
  inRow.append(inSelect);
  const inToggleRow = el("div", "sp-row");
  const inToggle = el("button", "sp-reset", "capture off");
  inToggleRow.append(inToggle);
  const grantRow = el("div", "sp-row");
  const grantButton = el("button", "sp-reset", "allow the microphone");
  grantRow.append(grantButton);
  const audioNote = el("p", "sp-note", "");
  audioSection.append(audioHint, outRow, inRow, inToggleRow, grantRow, audioNote);
  audioPane.append(audioSection);

  // --- the clock (E9-143) -------------------------------------------------
  //
  // IT ALREADY HAS A HOME and this is not it: PARAMS > CLOCK > tempo,
  // confirmed in a running page with no script loaded —
  //
  //     panels = MIX, TAPE, HOME, PARAMS
  //     groups = LEVELS | REVERB | COMPRESSOR | SOFTCUT | CLOCK
  //
  // which is one of four panels reached with E1, and NOT under SYSTEM,
  // where this file's author first sent somebody looking.
  //
  // It is here as well because of how the need was found: a phone whose
  // clock was at 220, playing a 136 bpm break at 1.62x, and an interface
  // too slow to navigate four panels into. A setting you cannot reach
  // when the page is struggling is a setting that does not exist on the
  // day you need it — and this panel is HTML, so it answers when the
  // norns screen does not.
  //
  // 90 IS THE DEFAULT because `core/state.lua:50` says so, not because it
  // is a nice number.
  const tempoApi = opts.files?.tempo;
  if (tempoApi) {
    const clockSection = el("section", "sp-section");
    clockSection.append(el("h2", undefined, "clock"));

    const tempoRow = el("div", "sp-row");
    tempoRow.append(el("span", "sp-sub", "tempo"));
    const tempoInput = el("input", "sp-num") as HTMLInputElement;
    tempoInput.type = "number";
    tempoInput.min = "1";
    tempoInput.max = "300";
    tempoInput.step = "1";
    const tempoUnit = el("span", "sp-sub", "bpm");
    const tempoReset = el("button", "sp-reset", "default");

    const markTempo = (): void => {
      // ZERO MEANS THE PARAMS ARE NOT BUILT YET, not a tempo of zero.
      // `clock.add_params()` runs in `Script.clear()`, which is part of
      // the boot gate, so a panel opened in the first ten seconds asks
      // for a parameter that does not exist and Lua says so. Measured:
      // "core/paramset.lua:491: invalid paramset index: clock_tempo" at
      // 9.7 s, and 90 at 12.1 s. An empty box would read as a broken
      // field; a disabled one reads as not yet.
      const now = tempoApi.get();
      const ready = now > 0;
      tempoInput.disabled = !ready;
      tempoInput.value = ready ? String(now) : "";
      tempoInput.placeholder = ready ? "" : "…";
      tempoReset.disabled = !ready || now === 90;
    };
    // ON `change`, NOT ON `input`, for the same reason as the install
    // limit above: a number field is typed INTO, and "136" passes through
    // "1", "13" on the way.
    tempoInput.addEventListener(
      "change",
      () => {
        tempoApi.set(Number(tempoInput.value));
        markTempo();
      },
      { signal },
    );
    tempoReset.addEventListener(
      "click",
      () => {
        tempoApi.set(90);
        markTempo();
      },
      { signal },
    );
    tempoRow.append(tempoInput, tempoUnit, tempoReset);
    clockSection.append(tempoRow);
    clockSection.append(
      el(
        "p",
        "sp-hint",
        "the same number as PARAMS > CLOCK > tempo, which is four panels along " +
          "with E1. it belongs to this machine rather than to a script, so it " +
          "survives every script you load — which is how a break meant for 136 " +
          "ends up playing at 220.",
      ),
    );
    // Read when the panel opens: Lua may not have answered at build time,
    // and a script can move the tempo while this is closed.
    // NOT called here: this asks Lua, and the rule above is that nothing
    // reaches into the host while the panel is being built.
    onOpenHooks.push(markTempo);
    audioPane.append(clockSection);
  }


  /** Fill one picker, keeping the stored choice selected if it is still there. */
  const fillSelect = (
    select: HTMLSelectElement,
    devices: readonly { id: string; label: string }[],
    chosen: string,
  ): void => {
    select.textContent = "";
    const def = el("option", undefined, "system default");
    def.value = "";
    select.append(def);
    for (const d of devices) {
      const option = el("option", undefined, d.label);
      option.value = d.id;
      select.append(option);
    }
    // A STORED ID THAT NO LONGER MATCHES IS NOT AN ERROR. Ids are scoped to
    // the origin and rotate when site data is cleared, and a card can be
    // unplugged. Falling back to the default and showing that is the truth;
    // keeping a dead name selected is not.
    select.value = devices.some((d) => d.id === chosen) ? chosen : "";
    select.disabled = devices.length === 0;
  };

  const paintAudio = async (): Promise<void> => {
    const list = await opts.audio.list();
    fillSelect(outSelect, list.outputs, settings.audioOut);
    fillSelect(inSelect, list.inputs, settings.audioIn);
    const canOut = opts.audio.canChooseOutput();
    if (!canOut) outSelect.disabled = true;
    inToggle.textContent = settings.audioInOn ? "capture on" : "capture off";
    inToggle.setAttribute("aria-pressed", String(settings.audioInOn));
    grantRow.hidden = list.named;
    audioHint.textContent = list.named
      ? `${list.outputs.length} out, ${list.inputs.length} in`
      : "device names need the microphone allowed — even to pick an output. nothing is recorded.";
    audioNote.textContent = !canOut
      ? "this browser cannot choose an output; it uses the system default"
      : opts.audio.lastError();
  };

  outSelect.addEventListener(
    "change",
    () => {
      settings.setAudio({ out: outSelect.value });
      void opts.audio.applyOutput().then(() => void paintAudio());
    },
    { signal },
  );
  inSelect.addEventListener(
    "change",
    () => {
      settings.setAudio({ in: inSelect.value });
      void opts.audio.applyInput().then(() => void paintAudio());
    },
    { signal },
  );
  inToggle.addEventListener(
    "click",
    () => {
      settings.setAudio({ inOn: !settings.audioInOn });
      void opts.audio.applyInput().then(() => void paintAudio());
    },
    { signal },
  );
  grantButton.addEventListener(
    "click",
    () => {
      grantButton.disabled = true;
      void opts.audio.grant().finally(() => {
        grantButton.disabled = false;
        void paintAudio();
      });
    },
    { signal },
  );
  // A card plugged in while the panel is open should appear in it.
  const stopWatching = opts.audio.watch(() => void paintAudio());

  // --- the MIDI ports -----------------------------------------------------
  //
  // A LIST TO READ, NOT A LIST TO CHOOSE FROM, and that is the decision.
  // Web MIDI has nothing to select: `requestMIDIAccess` exposes every port
  // at once. What gets chosen is the MAPPING — which port is device 1, 2, 3
  // or 4 — and norns already owns that at SYSTEM > DEVICES > MIDI, which is
  // what `midi.connect(n)` addresses. A second picker here would be a rival
  // mechanism for the same state, and the two would disagree.
  //
  // So this answers the question the gear is actually opened for: is my
  // interface detected at all, and under what name. The assignment is one
  // line away, on the instrument.
  const portsSection = el("section", "sp-section");
  portsSection.append(el("h2", undefined, "ports"));
  const portsList = el("ul", "sp-ports");
  portsSection.append(portsList);
  midiPane.append(portsSection);

  const paintPorts = (): void => {
    portsList.textContent = "";
    const ports = opts.midiPorts ? opts.midiPorts() : [];
    if (ports.length === 0) {
      const none = el("li");
      none.append(el("span", "sp-none", "no midi ports"));
      portsList.append(none);
      return;
    }
    for (const p of ports) {
      const row = el("li");
      row.append(el("span", "sp-dir", p.direction));
      row.append(el("span", undefined, p.name));
      portsList.append(row);
    }
  };

  /** Repaints the loopback button, when there is one. */
  let loopMark: () => void = () => {};

  // The loopback sits ABOVE the port list, because turning it on puts a
  // port in that list — the cause reads better before the effect.
  if (opts.loopback !== undefined) {
    const loopSection = el("section", "sp-section");
    loopSection.append(el("h2", undefined, "loopback"));
    const loopRow = el("div", "sp-row");
    const loopButton = el("button", "sp-reset", "off");
    loopRow.append(loopButton);
    loopSection.append(loopRow);
    loopSection.append(
      el("p", "sp-hint", "a virtual port that sends back to itself, for a script to play another script."),
    );
    // BEFORE the port list in the DOM, though it is built after it: the
    // handler below calls `paintPorts`, so the code order is forced and the
    // reading order should not be.
    midiPane.insertBefore(loopSection, portsSection);
    const markLoop = (): void => {
      const on = opts.loopback?.on() ?? false;
      loopButton.textContent = on ? "on" : "off";
      loopButton.setAttribute("aria-pressed", String(on));
    };
    loopButton.addEventListener(
      "click",
      () => {
        opts.loopback?.toggle();
        markLoop();
        paintPorts();
      },
      { signal },
    );
    // NOT CALLED HERE. Every one of these options reaches back into the
    // host, and the host builds this panel long before it has finished
    // declaring itself — `paintPorts` learned that the expensive way
    // (E9-16) and this put the same bug back within the hour. They are
    // called on OPEN, which is the only moment any of them matters.
    loopMark = markLoop;
  }

  showTab(active);

  // Something else can move these: the keyboard reads them, a reset writes
  // them, an import replaces the lot. Repainting on every change costs
  // nothing and beats a panel that disagrees with the instrument.
  settings.subscribe((_s, what) => {
    if (what === "midi") {
      markOctave();
      markVelocity();
    } else if (what === "zoom") {
      markZoom();
    } else if (what === "audio") {
      void paintAudio();
    }
  });

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    get isOpen(): boolean {
      return open;
    },
    destroy: () => ac.abort(),
  };
}
