// maiden, phase 1: the activity rail, the file tree, and the editor.
//
// WHAT THIS IS FOR. On a real norns, maiden is the only authoring surface
// the instrument has — there is no screen to write Lua on and no keyboard
// attached. Here the gap is wider, not narrower: a norns also has ssh and
// SMB, and this page has neither. Until this existed you could run a
// bundled script and install one from a zip, and there was no way at all to
// change one line of one of them.
//
// THE SHAPE IS MAIDEN'S, deliberately. A rail of activities on the left, a
// file tree, tabs, the editor, a status line — because the people who would
// use this already know where everything is, and a different arrangement
// would be a different thing that does the same job worse.
//
// THE THEME IS MAIDEN'S TOO, WITHOUT COPYING IT. maiden ships a
// `norns_dark` Ace theme; reading its colours off, every one of them —
// #1D1F21, #C5C8C6, #B294BB, #81A2BE, #B5BD68, #CC6666, #F0C674, #DE935F,
// #8ABEB7, #969896, #373B41, #282A2E — is Ace's own built-in
// `tomorrow_night`, which maiden darkened the gutter of and renamed. So the
// built-in theme is used and the gutter is darkened in our stylesheet: the
// same face, with nothing lifted from a GPL repository into an AGPL one.
//
// WHAT PHASE 1 IS NOT. No run button, no REPL, no new/rename/delete, one
// buffer at a time. Each of those is its own phase, and each of them is
// easier against a thing that already opens and saves.

// THE PACKAGE ROOT, not `src-noconflict/ace`, and the difference is types
// rather than code: `ace-builds`' main IS `src-noconflict/ace.js`, so this
// loads the same file maiden loads, and it is the one specifier the
// package ships a declaration for. Importing the deep path gets an
// implicit `any` for the whole editor.
import ace from "ace-builds";
import "ace-builds/src-noconflict/ext-language_tools";
import "ace-builds/src-noconflict/ext-searchbox";
import "ace-builds/src-noconflict/mode-lua";
import "ace-builds/src-noconflict/mode-json";
import "ace-builds/src-noconflict/snippets/lua";
import "ace-builds/src-noconflict/theme-tomorrow_night";
// BOTH THEMES STATICALLY, unlike the keymaps. maiden offers dawn and its
// dark one, they are a couple of kilobytes each, and a theme that is only
// fetched when chosen is a theme that silently does not apply: Ace's
// `setTheme` falls back to its own loader, which a bundler has already
// taken away. Measured by choosing dawn and watching the editor stay dark.
import "ace-builds/src-noconflict/theme-dawn";
import type { EditorEntry, EditorStore } from "../editor/store.js";
import type { MaidenRunner } from "../editor/runner.js";
import { createMaidenRepl, type ReplSource } from "./maiden-repl.js";
import { createMaidenProject, type CommunityLibrary, type MaidenProjectOptions } from "./maiden-project.js";

/**
 * The configure activity's four settings.
 *
 * maiden has the same four and keeps them in the browser; here they come
 * in from the page's own store so that they sit beside the zoom and the
 * keymap rather than in a second place nobody would think to look.
 */
export interface EditorPrefs {
  readonly theme: "dark" | "light";
  readonly keymap: "default" | "vim" | "emacs";
  readonly tabSize: number;
  readonly fontSize: number;
}

export const EDITOR_PREFS: EditorPrefs = {
  theme: "dark",
  keymap: "default",
  tabSize: 2,
  fontSize: 13,
};

export interface MaidenPanelOptions {
  /** The overlay element, which this fills. */
  readonly host: HTMLElement;
  readonly store: EditorStore;
  /** Saves and loads the script. Absent means no play button. */
  readonly runner?: MaidenRunner;
  /** The consoles. Absent means no repl activity. */
  readonly repl?: readonly ReplSource[];
  /** The catalogue. Absent means no project activity. */
  readonly project?: MaidenProjectOptions;
  /** Where the editor's own settings start. */
  readonly prefs?: EditorPrefs;
  /** Told when they change, so the page can remember them. */
  readonly onPrefs?: (prefs: EditorPrefs) => void;
  /**
   * What to do about a restart the session has earned.
   *
   * ASKED ON THE WAY OUT, which is the moment it matters. Installing a
   * script with a SuperCollider engine, or saving a `.sc`, leaves the page
   * holding a class sclang has never compiled — the script loads, draws,
   * and has no engine. The note in the project activity says so, and then
   * the person closes the panel and goes to play the thing. So the panel
   * asks before it gets out of the way, rather than leaving a sentence
   * behind on a page nobody is looking at any more.
   *
   * `later` is a real answer and is remembered: the question is not asked
   * again until something new earns it.
   */
  readonly restart?: {
    /** Why one is wanted, empty when none is. */
    pending(): string[];
    /** Something in here has just earned one. */
    earned(why: string): void;
    now(): void;
    later(): void;
  };
  /** Told when the panel opens or closes, so the norns keymap can go quiet. */
  readonly onToggle?: (open: boolean) => void;
  readonly log?: (line: string) => void;
}

export interface MaidenPanel {
  readonly open: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
  /**
   * E9-109 — fetch these catalogue scripts, saying who wants them.
   *
   * Forwarded to the project activity, which owns the queue. Resolves to
   * the names it could not find. A panel built without a `project` has no
   * installer at all, and answers that every name is missing rather than
   * pretending to have queued them.
   */
  want(names: readonly string[], neededBy: string): Promise<string[]>;
  /** E9-208 — the installer's queue, shared with the script store. Null with no installer. */
  readonly library: CommunityLibrary | null;
  dispose(): void;
}

/** Lines come back from Lua however the host joined them. */
const NEWLINE = /\r?\n/;

/**
 * A handful of norns snippets, ours rather than maiden's.
 *
 * maiden ships `web/src/snippets.js`, and maiden is GPL-3 while this is
 * AGPL-3 — so these are written here from the five callbacks every script
 * has: `script.lua` calls `init`, `redraw`, `enc`, `key` and `cleanup` by
 * those names and no others. Ace's own `snippets/lua` is loaded beside
 * them for the language itself.
 *
 * Ace's snippet-file format: a `snippet` line, the body indented by one
 * tab, and `${1:…}` for a tab stop.
 */
const NORNS_SNIPPETS = [
  "snippet init",
  "\tfunction init()",
  "\t\t${1:-- set up}",
  "\tend",
  "snippet redraw",
  "\tfunction redraw()",
  "\t\tscreen.clear()",
  "\t\t${1:screen.move(0, 10)}",
  "\t\tscreen.update()",
  "\tend",
  "snippet enc",
  "\tfunction enc(n, d)",
  "\t\t${1:}",
  "\tend",
  "snippet key",
  "\tfunction key(n, z)",
  "\t\tif n == 2 and z == 1 then ${1:} end",
  "\tend",
  "snippet cleanup",
  "\tfunction cleanup()",
  "\t\t${1:-- put things back}",
  "\tend",
  "snippet metro",
  "\tlocal ${1:m} = metro.init()",
  "\t${1:m}.time = ${2:1}",
  "\t${1:m}.event = function() ${3:} end",
  "\t${1:m}:start()",
  "snippet param",
  '\tparams:add{type = "${1:number}", id = "${2:id}", name = "${3:name}",',
  "\t\tmin = ${4:0}, max = ${5:1}, default = ${6:0},",
  "\t\taction = function(x) ${7:} end}",
  "snippet grid",
  "\tlocal g = grid.connect()",
  "\tg.key = function(x, y, z)",
  "\t\t${1:}",
  "\tend",
].join("\n");

/** Which file extensions get which Ace mode. Everything else is plain. */
function modeFor(path: string): string {
  if (path.endsWith(".lua")) return "ace/mode/lua";
  if (path.endsWith(".json") || path.endsWith(".pset")) return "ace/mode/json";
  return "ace/mode/text";
}

/**
 * The inline bar the file actions ask through.
 *
 * Not `window.prompt`: a modal the browser owns cannot be styled, does not
 * follow the panel's theme, behaves differently in every browser and is
 * blocked outright in some contexts. This is three elements and an escape
 * key.
 */
function createAsk(): {
  element: HTMLElement;
  prompt(label: string, initial: string, ok: (value: string) => void): void;
  confirm(label: string, word: string, ok: () => void, no?: () => void): void;
  close(): void;
} {
  const element = document.createElement("div");
  element.className = "mdn-ask";
  element.hidden = true;
  const text = document.createElement("span");
  text.className = "mdn-ask-text";
  const input = document.createElement("input");
  input.className = "mdn-ask-input";
  input.type = "text";
  input.spellcheck = false;
  const go = document.createElement("button");
  go.className = "mdn-ask-go";
  go.type = "button";
  const no = document.createElement("button");
  no.className = "mdn-ask-no";
  no.type = "button";
  no.textContent = "cancel";
  element.append(text, input, go, no);

  let accept: (() => void) | null = null;
  /**
   * What CANCEL means, when it means more than forgetting it.
   *
   * Most of these dialogues have nothing to do when refused. The restart
   * question does: refusing it is "later", and later still has to let go of
   * the panel — otherwise answering "not now" traps you inside it.
   */
  let refuse: (() => void) | null = null;

  const close = (): void => {
    element.hidden = true;
    accept = null;
    refuse = null;
  };
  const cancel = (): void => {
    const f = refuse;
    close();
    f?.();
  };
  go.addEventListener("click", () => accept?.());
  no.addEventListener("click", () => cancel());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") accept?.();
    if (e.key === "Escape") cancel();
  });

  return {
    element,
    prompt(label, initial, ok) {
      text.textContent = label;
      input.hidden = false;
      input.value = initial;
      go.textContent = "ok";
      accept = () => {
        const v = input.value.trim();
        close();
        if (v !== "") ok(v);
      };
      element.hidden = false;
      input.focus();
      // The STEM, not the extension: renaming `awake.lua` almost never
      // means renaming it to something that is not Lua.
      const dot = initial.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    },
    confirm(label, word, ok, no) {
      text.textContent = label;
      input.hidden = true;
      go.textContent = word;
      refuse = no ?? null;
      accept = () => {
        close();
        ok();
      };
      element.hidden = false;
      go.focus();
    },
    close,
  };
}

export function createMaidenPanel(opts: MaidenPanelOptions): MaidenPanel {
  const { host, store } = opts;
  const log = opts.log ?? ((): void => {});
  const ac = new AbortController();
  const signal = ac.signal;

  host.textContent = "";
  host.classList.add("mdn");

  // --- the activity rail ------------------------------------------------
  //
  // Four, as maiden has four, and three of them are not built yet. Shown
  // and disabled rather than hidden: the shape of the thing is part of
  // knowing where you are in it, and a rail that grows buttons later moves
  // the one you were aiming at.
  const rail = document.createElement("div");
  rail.className = "mdn-rail";
  const activities: Array<[string, string, boolean]> = [
    ["edit", "M3 2h7l3 3v9H3z", true],
    ["repl", "M3 3h10v10H3zm2 3l2 2-2 2m4 1h3", opts.repl !== undefined],
    ["project", "M2 5l6-3 6 3-6 3zM2 5v6l6 3 6-3V5", opts.project !== undefined],
    ["config", "M8 5.5A2.5 2.5 0 108 10.5 2.5 2.5 0 008 5.5zM8 1v2m0 10v2M1 8h2m10 0h2", true],
  ];
  const actButtons: HTMLButtonElement[] = [];
  for (const [name, d, enabled] of activities) {
    const b = document.createElement("button");
    b.className = "mdn-act";
    b.type = "button";
    b.title = enabled ? name : `${name} — not built yet`;
    b.disabled = !enabled;
    b.innerHTML =
      `<svg viewBox="0 0 16 16" width="18" height="18" fill="none" ` +
      `stroke="currentColor" stroke-width="1.3"><path d="${d}"/></svg>`;
    rail.append(b);
    actButtons.push(b);
  }
  const spacer = document.createElement("div");
  spacer.className = "mdn-spacer";
  const closeButton = document.createElement("button");
  closeButton.className = "mdn-act mdn-close";
  closeButton.type = "button";
  closeButton.title = "close";
  closeButton.innerHTML =
    `<svg viewBox="0 0 16 16" width="18" height="18" fill="none" ` +
    `stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
  rail.append(spacer, closeButton);

  // --- the explorer -----------------------------------------------------
  const side = document.createElement("div");
  side.className = "mdn-side";
  const sideHead = document.createElement("div");
  sideHead.className = "mdn-side-head";
  const sideTitle = document.createElement("span");
  sideTitle.textContent = "dust";
  const sideTools = document.createElement("div");
  sideTools.className = "mdn-side-tools";
  sideHead.append(sideTitle, sideTools);

  // THE ACTIONS ARE IN THE HEADER, not on the rows. A row that grows
  // buttons when the pointer is over it is a row a finger cannot reach,
  // and this page runs on a handheld. They act on what is selected, and
  // each one says in its title what it would do to it.
  const fileActions: Array<[string, string]> = [
    ["new", "new file"],
    ["dir", "new folder"],
    ["ren", "rename"],
    ["dup", "duplicate"],
    ["del", "delete"],
    ["rev", "put the bundled version back"],
  ];
  const actionButtons = new Map<string, HTMLButtonElement>();
  for (const [key, title] of fileActions) {
    const b = document.createElement("button");
    b.className = "mdn-side-act";
    b.type = "button";
    b.textContent = key;
    b.title = title;
    sideTools.append(b);
    actionButtons.set(key, b);
  }

  // The inline bar the actions ask through. Not `window.prompt`: a modal
  // the browser owns cannot be styled, cannot be escaped consistently, and
  // is blocked outright in some contexts.
  const ask = createAsk();
  const tree = document.createElement("div");
  tree.className = "mdn-tree";
  side.append(sideHead, ask.element, tree);

  /**
   * Show or hide the file tree, from the keyboard or from the button.
   *
   * One function rather than two copies of three lines: `data-side` is
   * what the stylesheet reads, `hidden` is what keeps it out of the tab
   * order, and Ace has to be told because its own size changed.
   */
  const showSide = (on: boolean): void => {
    side.hidden = !on;
    host.dataset["side"] = on ? "on" : "off";
    filesButton.setAttribute("aria-pressed", String(on));
    editorRef?.resize(true);
  };
  /** Ace, once it exists. `showSide` can be called before it does. */
  let editorRef: { resize(force: boolean): void } | null = null;
  /** The same 720px the stylesheet uses, asked of the window. */
  const narrow = (): boolean => (globalThis.innerWidth || 0) <= 720;

  // --- the editor -------------------------------------------------------
  const main = document.createElement("div");
  main.className = "mdn-main";
  const editArea = document.createElement("div");
  editArea.className = "mdn-edit";
  const tabs = document.createElement("div");
  tabs.className = "mdn-tabs";
  const tools = document.createElement("div");
  tools.className = "mdn-tools";
  /**
   * E9-110 — THE TREE'S OWN BUTTON, because Ctrl-B is not a gesture.
   *
   * Under 720px the file tree is an overlay rather than a column (see the
   * stylesheet), and something has to open it again. maiden has had a
   * toggle since it had a sidebar and it is Ctrl-B, which is no use at all
   * on the machine this was reported from.
   *
   * It lives in the editor's own toolbar, on the left, where the thing it
   * covers is: press it and the tree comes over the editor, pick a file
   * and the tree goes away again. Hidden by the stylesheet on a screen
   * wide enough for three columns, where the tree is always there and a
   * button that said `files` beside it would be a button that lies.
   */
  const filesButton = document.createElement("button");
  filesButton.className = "mdn-files";
  filesButton.type = "button";
  filesButton.title = "the dust tree";
  filesButton.textContent = "files";
  tools.append(filesButton);
  const playButton = document.createElement("button");
  playButton.className = "mdn-play";
  playButton.type = "button";
  playButton.disabled = true;
  playButton.innerHTML =
    `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">` +
    `<path d="M4 2.5v11l9-5.5z"/></svg><span>run</span>`;
  tools.append(playButton);
  const editorHost = document.createElement("div");
  editorHost.className = "mdn-editor";
  const status = document.createElement("div");
  status.className = "mdn-status";
  tabs.append(tools);
  editArea.append(tabs, editorHost, status);
  main.append(editArea);

  const repl = opts.repl === undefined ? null : createMaidenRepl(opts.repl);
  if (repl !== null) main.append(repl.element);

  const project = opts.project === undefined ? null : createMaidenProject(opts.project);
  if (project !== null) {
    project.element.hidden = true;
    main.append(project.element);
  }

  // --- the configure activity --------------------------------------------
  //
  // maiden's four settings, in maiden's activity rather than folded into
  // the page's gear: the editor's own preferences belong next to the
  // editor, and somebody who has the panel open should not have to close
  // it to change the tab size.
  const configEl = document.createElement("div");
  configEl.className = "mdn-config";
  configEl.hidden = true;
  const configRows: Array<[keyof EditorPrefs, string, Array<[string, string | number]>]> = [
    ["theme", "theme", [["norns dark", "dark"], ["dawn", "light"]]],
    ["keymap", "keys", [["default", "default"], ["vim", "vim"], ["emacs", "emacs"]]],
    ["tabSize", "tab size", [["2", 2], ["3", 3], ["4", 4], ["8", 8]]],
    ["fontSize", "font size", [["11", 11], ["12", 12], ["13", 13], ["15", 15], ["18", 18]]],
  ];
  const configButtons = new Map<string, HTMLButtonElement[]>();
  for (const [key, label, choices] of configRows) {
    const row = document.createElement("div");
    row.className = "mdn-config-row";
    const name = document.createElement("span");
    name.className = "mdn-config-name";
    name.textContent = label;
    row.append(name);
    const group: HTMLButtonElement[] = [];
    for (const [text, value] of choices) {
      const b = document.createElement("button");
      b.className = "mdn-config-opt";
      b.type = "button";
      b.textContent = text;
      b.dataset["value"] = String(value);
      b.addEventListener(
        "click",
        () => {
          prefs = { ...prefs, [key]: value } as EditorPrefs;
          void applyPrefs();
          opts.onPrefs?.(prefs);
          paintConfig();
        },
        { signal },
      );
      row.append(b);
      group.push(b);
    }
    configButtons.set(key, group);
    configEl.append(row);
  }
  const configNote = document.createElement("p");
  configNote.className = "mdn-config-note";
  configNote.textContent =
    "vim and emacs are fetched the first time you choose them, so the page does not carry a keymap nobody set.";
  configEl.append(configNote);
  main.append(configEl);

  const paintConfig = (): void => {
    for (const [key, group] of configButtons) {
      for (const b of group) {
        b.setAttribute(
          "aria-pressed",
          String(b.dataset["value"] === String(prefs[key as keyof EditorPrefs])),
        );
      }
    }
  };

  /**
   * LAZY KEYMAPS, which is what keeps the default load honest.
   *
   * `keybinding-vim` and `keybinding-emacs` are 49 kB gzipped between them
   * and nobody has set one on first load, so they are fetched when they
   * are chosen. Vite splits each `import()` into its own chunk.
   */
  const applyPrefs = async (): Promise<void> => {
    editor.setTheme(prefs.theme === "dark" ? "ace/theme/tomorrow_night" : "ace/theme/dawn");
    editor.setFontSize(prefs.fontSize);
    for (const b of buffers.values()) b.session.setTabSize(prefs.tabSize);
    empty.setTabSize(prefs.tabSize);
    if (prefs.keymap === "default") {
      editor.setKeyboardHandler(null);
      // Vim leaves `normal-mode` on the element, and its CSS is what makes
      // the cursor a block — so turning the handler off left a block
      // cursor in an editor with no vim in it. Measured: 8.8 px wide after
      // choosing `default` again.
      editorHost.classList.remove("normal-mode", "insert-mode", "visual-mode");
      return;
    }
    try {
      if (prefs.keymap === "vim") {
        await import("ace-builds/src-noconflict/keybinding-vim");
        editor.setKeyboardHandler("ace/keyboard/vim");
      } else {
        await import("ace-builds/src-noconflict/keybinding-emacs");
        editor.setKeyboardHandler("ace/keyboard/emacs");
      }
    } catch {
      // A keymap that will not load is a keymap you do not have, not a
      // broken editor.
      editor.setKeyboardHandler(null);
      say(`${prefs.keymap} keys could not be loaded`);
    }
  };

  /**
   * The one question that belongs to the PANEL and not to the file tree.
   *
   * A SECOND ASK BAR, and the reason is a bug: the first one lives in the
   * sidebar, which `#maidenpanel[data-activity="project"] .mdn-side` hides
   * outright — so asking about a restart while the project activity was
   * showing drew the question inside a `display: none`, left the panel
   * open, and made the close button look broken. Reported exactly that way:
   * "les installations sont finies mais quand je clique sur la croix rien
   * ne se passe".
   *
   * The tree's questions are the tree's — rename, delete, overwrite — and
   * they belong beside it. This one is about leaving, so it hangs off the
   * panel itself and is visible from every activity.
   */
  const exitAsk = createAsk();
  exitAsk.element.classList.add("mdn-exit-ask");
  host.append(rail, side, main, exitAsk.element);

  const editor = ace.edit(editorHost);
  editorRef = editor;
  /** What the editor shows when nothing is open. */
  const empty = ace.createEditSession("", "ace/mode/text");
  editor.setSession(empty);
  editor.setOptions({
    enableBasicAutocompletion: true,
    enableSnippets: true,
    showPrintMargin: false,
    useSoftTabs: true,
    tabSize: 2,
    fontSize: 13,
    newLineMode: "unix",
  });
  editor.setReadOnly(true);

  // The norns snippets, added to the Lua mode's own set.
  //
  // `ace/snippets`, NOT `ace/ext/language_tools`. The extension owns the
  // completers — `snippetCompleter`, `textCompleter`, `keyWordCompleter` —
  // and the manager itself lives in `ace/snippets`. Registering against the
  // extension did nothing at all, silently: Tab kept inserting a tab, and
  // the Lua map held Ace's own six and none of ours.
  try {
    const tools = ace.require("ace/snippets") as {
      snippetManager?: {
        parseSnippetFile(text: string): unknown[];
        register(snippets: unknown[], scope: string): void;
      };
    };
    const manager = tools.snippetManager;
    if (manager !== undefined) {
      manager.register(manager.parseSnippetFile(NORNS_SNIPPETS), "lua");
    }
  } catch {
    /* no snippets, which is a smaller thing than no editor */
  }

  let prefs: EditorPrefs = { ...EDITOR_PREFS, ...(opts.prefs ?? {}) };

  /** Which directories are open in the tree. */
  const expanded = new Set<string>([store.root]);
  /** What the file actions act on. Not the same as what is being edited. */
  let selected: string | null = null;
  /**
   * One Ace session per open file, which is what makes the tabs real.
   *
   * A session carries the text, the mode, the undo stack and the cursor,
   * so switching tabs restores where you were rather than scrolling you to
   * the top of your own file with no way back.
   */
  interface Buffer {
    readonly path: string;
    readonly session: ReturnType<typeof ace.createEditSession>;
    /** The text as it is on disk, which is what makes a tab dirty or not. */
    clean: string;
  }
  const buffers = new Map<string, Buffer>();
  let current: string | null = null;
  let running = false;
  /** Something the editor has to say, until something else happens. */
  let note: string | null = null;

  const bufferAt = (path: string | null): Buffer | null =>
    path === null ? null : (buffers.get(path) ?? null);
  const dirtyAt = (path: string | null): boolean => {
    const b = bufferAt(path);
    return b !== null && b.session.getValue() !== b.clean;
  };
  const dirty = (): boolean => dirtyAt(current);

  const paint = (): void => {
    const name = current === null ? "no file" : current.slice(store.root.length + 1);
    // A NOTE OUTLIVES A REPAINT. The first version said the error and then
    // called `paint()`, which put the file name straight back over it --
    // the run failed, the line was marked, and the status bar said nothing
    // had happened. Anything the editor has to tell you has to survive the
    // next keystroke.
    status.textContent =
      note ?? (current === null ? "open a file from the tree" : `${name}${dirty() ? " ·" : ""}`);
    tabs.textContent = "";
    for (const b of buffers.values()) {
      const tab = document.createElement("div");
      tab.className = "mdn-tab";
      if (b.path === current) tab.classList.add("on");
      tab.title = b.path;
      const label = document.createElement("span");
      label.textContent = `${b.path.split("/").pop() ?? b.path}${dirtyAt(b.path) ? " •" : ""}`;
      const shut = document.createElement("button");
      shut.className = "mdn-tab-shut";
      shut.type = "button";
      shut.textContent = "×";
      shut.title = "close";
      shut.addEventListener(
        "click",
        (e) => {
          e.stopPropagation();
          closeBuffer(b.path);
        },
        { signal },
      );
      tab.addEventListener("click", () => showBuffer(b.path), { signal });
      tab.append(label, shut);
      tabs.append(tab);
    }
    tabs.append(tools);
    // The button says why it is off rather than only being off: "files
    // under lib/ are not scripts" is an answer, a grey button is not.
    if (opts.runner === undefined) {
      playButton.hidden = true;
    } else if (current === null) {
      playButton.disabled = true;
      playButton.title = "open a script first";
    } else {
      const why = opts.runner.refuse(current);
      playButton.disabled = why !== null || running;
      playButton.title = why ?? "save and run this script";
    }
  };

  const say = (line: string): void => {
    note = line;
    status.textContent = line;
  };

  const showBuffer = (path: string): void => {
    const b = buffers.get(path);
    if (b === undefined) return;
    current = path;
    note = null;
    editor.setSession(b.session);
    editor.setReadOnly(false);
    editor.focus();
    paint();
    drawTree();
  };

  const closeBuffer = (path: string): void => {
    const b = buffers.get(path);
    if (b === undefined) return;
    if (dirtyAt(path)) {
      // Unsaved work does not go without being asked about. The editor is
      // the only place some of this text has ever existed.
      ask.confirm(`close ${path.split("/").pop()} without saving?`, "close", () => {
        buffers.delete(path);
        afterClose(path);
      });
      return;
    }
    buffers.delete(path);
    afterClose(path);
  };

  function afterClose(path: string): void {
    if (current !== path) {
      paint();
      return;
    }
    const next = [...buffers.keys()].pop() ?? null;
    current = next;
    if (next === null) {
      editor.setSession(empty);
      editor.setReadOnly(true);
    } else {
      showBuffer(next);
      return;
    }
    paint();
    drawTree();
  }

  const openFile = (entry: EditorEntry): void => {
    note = null;
    // E9-110 — ON A NARROW SCREEN THE TREE IS OVER THE EDITOR, so choosing
    // a file is also the moment to get out of the way. Asked of the
    // stylesheet rather than of the machine profile, because what matters
    // is whether the tree is covering anything and that is a width.
    if (narrow()) showSide(false);
    if (buffers.has(entry.path)) {
      showBuffer(entry.path);
      return;
    }
    const r = store.open(entry.path);
    if (!r.ok) {
      // The reason, not a shrug. Three of the things in this tree cannot be
      // edited and each of them fails differently.
      say(`${entry.name}: ${r.why}`);
      return;
    }
    const session = ace.createEditSession(r.text, modeFor(entry.path));
    session.setUseSoftTabs(true);
    session.setTabSize(prefs.tabSize);
    session.on("change", () => paint());
    buffers.set(entry.path, { path: entry.path, session, clean: r.text });
    showBuffer(entry.path);
  };

  const save = (): void => {
    const b = bufferAt(current);
    if (b === null) return;
    const text = b.session.getValue();
    store.save(b.path, text);
    b.clean = text;
    // A SAVED SuperCollider CLASS IS A RESTART, for the same reason an
    // installed one is: sclang compiles its class library once, at boot,
    // from whatever is in `~/dust/code` then. Editing the file changes what
    // is on disk and nothing that is running.
    if (/\.scd?$/i.test(b.path)) {
      opts.restart?.earned(b.path.split("/").pop() ?? b.path);
    }
    log(`maiden: saved ${b.path}`);
    paint();
    drawTree();
  };

  /**
   * Save, then load it — and get out of the way.
   *
   * THE PANEL CLOSES ON SUCCESS, which maiden does not do and could not: on
   * a norns, maiden is on another machine and the instrument is in front of
   * you. Here the instrument is BEHIND this overlay, so a play button that
   * left it covered would be a play button you cannot watch. The tree and
   * the buffer are kept, so coming back is one click.
   *
   * On failure it stays open, with the error on the line that raised it.
   */
  const run = async (): Promise<void> => {
    const runner = opts.runner;
    if (runner === undefined || current === null || running) return;
    const path = current;
    if (dirty()) save();
    running = true;
    note = null;
    paint();
    editor.session.clearAnnotations();
    say(`running ${path.slice(store.root.length + 1)} …`);
    const out = await runner.run(path);
    running = false;
    if (out.ok) {
      log(`maiden: ran ${path}`);
      hide();
      return;
    }
    const first = (out.message ?? "it did not run").split(NEWLINE).slice(0, 2).join(" — ");
    say(first);
    log(`maiden: ${path} did not run — ${first}`);
    // The line, when the error named one AND it is the file on screen. An
    // annotation on line 217 of a file you are not looking at would point
    // at whatever happens to be there.
    if (out.at !== null && out.at.path === path) {
      editor.session.setAnnotations([
        { row: Math.max(0, out.at.line - 1), column: 0, text: out.message ?? "", type: "error" },
      ]);
      editor.gotoLine(out.at.line, 0, true);
    } else if (out.at !== null) {
      say(`${first}  (in ${out.at.path.slice(store.root.length + 1)}:${out.at.line})`);
    }
    paint();
  };

  playButton.addEventListener("click", () => void run(), { signal });

  // --- the tree ---------------------------------------------------------
  function rowFor(entry: EditorEntry, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "mdn-row";
    row.style.paddingLeft = `${6 + depth * 12}px`;
    if (entry.path === current) row.classList.add("on");
    if (entry.path === selected) row.classList.add("sel");

    const twist = document.createElement("span");
    twist.className = "mdn-twist";
    twist.textContent = entry.kind === "dir" ? (expanded.has(entry.path) ? "▾" : "▸") : "";
    const name = document.createElement("span");
    name.className = "mdn-name";
    name.textContent = entry.name;
    row.append(twist, name);

    // THE THREE STATES, SHOWN APART. A file that is declared and not here
    // looks exactly like one that is, until you open it — so it says so,
    // and a file the session wrote says that too, because that is what a
    // reset would take away.
    if (entry.presence === "remote") {
      const tag = document.createElement("span");
      tag.className = "mdn-tag mdn-remote";
      tag.textContent = entry.size === null ? "not here" : `${Math.round(entry.size / 1024)} kB · not here`;
      row.append(tag);
    } else if (entry.mine) {
      const tag = document.createElement("span");
      tag.className = "mdn-tag mdn-mine";
      tag.textContent = "edited";
      row.append(tag);
    }

    row.addEventListener(
      "click",
      () => {
        // SELECTED EITHER WAY. The actions act on a selection, and a
        // folder you cannot select is a folder you cannot make a file in.
        selected = entry.path;
        if (entry.kind === "dir") {
          if (expanded.has(entry.path)) expanded.delete(entry.path);
          else expanded.add(entry.path);
          drawTree();
        } else {
          openFile(entry);
        }
        paintActions();
      },
      { signal },
    );
    return row;
  }

  function drawTree(): void {
    tree.textContent = "";
    const walk = (path: string, depth: number): void => {
      for (const entry of store.list(path)) {
        tree.append(rowFor(entry, depth));
        if (entry.kind === "dir" && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk(store.root, 0);
  }

  // A change from anywhere — a script writing a PSET, an install, a
  // restore — and the tree is stale. The store's watch is the VFS's own.
  const unwatch = store.watch(() => {
    if (host.hidden) return;
    drawTree();
  });

  // No editor-level change listener: each session has its own, so one here
  // would paint twice for every keystroke on the active file and not at all
  // for the others.
  editor.commands.addCommand({
    name: "save",
    bindKey: { win: "Ctrl-S", mac: "Command-S" },
    exec: () => save(),
  });
  // MAIDEN'S OWN BINDINGS, read from `web/src/services.js` rather than
  // chosen: play is Ctrl-P, eval is Ctrl-Enter AND Ctrl-8, the repl toggle
  // is Ctrl-E and the sidebar is Ctrl-B. The first draft of phase 2 put run
  // on Ctrl-Enter, which is eval's — the two would have fought, and the one
  // that lost would have been the one people use most.
  editor.commands.addCommand({
    name: "run",
    bindKey: { win: "Ctrl-P", mac: "Command-P" },
    exec: () => void run(),
  });
  editor.commands.addCommand({
    name: "eval",
    bindKey: { win: "Ctrl-Enter|Ctrl-8", mac: "Command-Enter|Command-8" },
    exec: () => evalSelection(),
  });
  editor.commands.addCommand({
    name: "toggle repl",
    bindKey: { win: "Ctrl-E", mac: "Command-E" },
    exec: () => setActivity(activity === "repl" ? "edit" : "repl"),
  });
  filesButton.addEventListener("click", () => showSide(side.hidden === true), { signal });
  editor.commands.addCommand({
    name: "toggle sidebar",
    bindKey: { win: "Ctrl-B", mac: "Command-B" },
    exec: () => showSide(side.hidden === true),
  });

  // Ctrl-S belongs to the browser otherwise, and "save page as" over an
  // editor is a particularly bad joke.
  host.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") e.preventDefault();
      if (e.key === "Escape") hide();
      // The norns keymap is silenced while this is open (see `onToggle`),
      // but the event still bubbles to the page; stopping it here keeps a
      // keystroke meant for the editor out of everything else.
      e.stopPropagation();
    },
    { signal },
  );

  // --- the file actions ---------------------------------------------------
  //
  // Each one asks first and then does one thing. `store` is where the
  // judgement lives -- what is outside the tree, what would land on
  // something, what has no bytes to copy -- and this only has to show the
  // answer.
  const folderFor = (): string => {
    if (selected === null) return store.root;
    return store.isDir(selected) ? selected : selected.slice(0, selected.lastIndexOf("/"));
  };

  const after = (r: { ok: boolean; path?: string; why?: string }, did: string): void => {
    if (!r.ok) {
      say(r.why ?? "no");
      return;
    }
    say(`${did} ${(r.path ?? "").slice(store.root.length + 1)}`);
    drawTree();
    paintActions();
  };

  const paintActions = (): void => {
    const has = selected !== null;
    const isDir = has && store.isDir(selected as string);
    actionButtons.get("ren")?.toggleAttribute("disabled", !has);
    actionButtons.get("del")?.toggleAttribute("disabled", !has);
    actionButtons.get("dup")?.toggleAttribute("disabled", !has || isDir);
    const canRevert = has && store.canRevert(selected as string);
    const rev = actionButtons.get("rev");
    if (rev !== undefined) {
      rev.disabled = !canRevert;
      rev.title = canRevert
        ? "put the bundled version back"
        : "only a file the build supplies can be put back";
    }
  };

  actionButtons.get("new")?.addEventListener(
    "click",
    () => {
      const dir = folderFor();
      ask.prompt(`new file in ${dir.slice(store.root.length + 1) || "dust"}`, "untitled.lua", (name) => {
        const path = `${dir}/${name}`;
        const r = store.create(path, "file");
        // SELECTED, and that is not a nicety. Without it the selection
        // stayed on the FOLDER the file was made in, and the next action
        // acted on the folder: in testing, a rename straight after a new
        // file renamed `code` itself and moved 706 files under a name
        // meant for one. The actions act on a selection, so anything that
        // makes something has to move the selection to it.
        if (r.ok) selected = path;
        after(r, "made");
        if (r.ok) openFile({ name, path, kind: "file", presence: "here", size: 0, mine: true });
      });
    },
    { signal },
  );

  actionButtons.get("dir")?.addEventListener(
    "click",
    () => {
      const dir = folderFor();
      ask.prompt(`new folder in ${dir.slice(store.root.length + 1) || "dust"}`, "untitled", (name) => {
        const path = `${dir}/${name}`;
        const r = store.create(path, "folder");
        if (r.ok) selected = path;
        after(r, "made");
        expanded.add(path);
      });
    },
    { signal },
  );

  actionButtons.get("ren")?.addEventListener(
    "click",
    () => {
      if (selected === null) return;
      const from = selected;
      const base = from.slice(from.lastIndexOf("/") + 1);
      // "folder" IN THE QUESTION, because renaming one moves everything
      // under it and the two actions do not look alike afterwards.
      const what = store.isDir(from) ? `rename folder ${base}` : `rename ${base}`;
      ask.prompt(what, base, (name) => {
        const to = `${from.slice(0, from.lastIndexOf("/"))}/${name}`;
        const r = store.rename(from, to);
        // The open buffer follows its file, or it would go on saving to a
        // name nothing reads any more.
        if (r.ok && buffers.has(from)) {
          const b = buffers.get(from) as Buffer;
          buffers.delete(from);
          buffers.set(to, { path: to, session: b.session, clean: b.clean });
          if (current === from) current = to;
        }
        if (r.ok) selected = to;
        after(r, "renamed to");
        paint();
      });
    },
    { signal },
  );

  actionButtons.get("dup")?.addEventListener(
    "click",
    () => {
      if (selected === null) return;
      after(store.duplicate(selected), "copied to");
    },
    { signal },
  );

  actionButtons.get("del")?.addEventListener(
    "click",
    () => {
      if (selected === null) return;
      const path = selected;
      const base = path.slice(path.lastIndexOf("/") + 1);
      const what = store.isDir(path)
        ? `delete folder ${base} and everything in it?`
        : `delete ${base}?`;
      ask.confirm(what, "delete", () => {
        const r = store.remove(path);
        if (r.ok) {
          for (const open of [...buffers.keys()]) {
            if (open === path || open.startsWith(`${path}/`)) {
              buffers.delete(open);
              if (current === open) current = null;
            }
          }
          if (current === null) {
            editor.setSession(empty);
            editor.setReadOnly(true);
          }
          selected = null;
        }
        after(r, "deleted");
        paint();
      });
    },
    { signal },
  );

  actionButtons.get("rev")?.addEventListener(
    "click",
    () => {
      if (selected === null) return;
      const path = selected;
      ask.confirm("throw away your changes to this file?", "revert", () => {
        const r = store.revert(path);
        if (r.ok) {
          // The buffer has to be re-read, or the next save would put the
          // edit straight back.
          buffers.delete(path);
          if (current === path) {
            current = null;
            editor.setSession(empty);
            editor.setReadOnly(true);
            openFile({ name: path.split("/").pop() ?? path, path, kind: "file", presence: "here", size: null, mine: false });
          }
        }
        after(r, "reverted");
        paint();
      });
    },
    { signal },
  );

  // --- activities --------------------------------------------------------
  //
  // Two of the four, and the rail shows all four because the shape of the
  // thing is part of knowing where you are in it.
  type Activity = "edit" | "repl" | "project" | "config";
  let activity: Activity = "edit";

  const setActivity = (next: Activity): void => {
    if (next === "repl" && repl === null) return;
    if (next === "project" && project === null) return;
    activity = next;
    // A note is about the thing you were just doing, and you are not doing
    // it any more.
    note = null;
    host.dataset["activity"] = next;
    editArea.hidden = next !== "edit";
    configEl.hidden = next !== "config";
    if (project !== null) {
      project.element.hidden = next !== "project";
      project.active(open && next === "project");
    }
    if (repl !== null) {
      repl.element.hidden = next !== "repl";
      // The poll stops when nobody is looking at it.
      repl.active(open && next === "repl");
    }
    actButtons[0]?.setAttribute("aria-pressed", String(next === "edit"));
    actButtons[1]?.setAttribute("aria-pressed", String(next === "repl"));
    actButtons[2]?.setAttribute("aria-pressed", String(next === "project"));
    actButtons[3]?.setAttribute("aria-pressed", String(next === "config"));
    if (next === "edit") editor.resize(true);
    if (next === "repl") repl?.focus();
    else if (next === "edit") editor.focus();
  };

  actButtons[0]?.addEventListener("click", () => setActivity("edit"), { signal });
  actButtons[1]?.addEventListener("click", () => setActivity("repl"), { signal });
  actButtons[2]?.addEventListener("click", () => setActivity("project"), { signal });
  actButtons[3]?.addEventListener("click", () => setActivity("config"), { signal });

  /**
   * `eval`: the selection, or the line the caret is on.
   *
   * WITHOUT MAIDEN'S FLATTENING, and the reason is structural. maiden does
   * `code.replace(/--.*
/g, ';').replace(/
/g, ';')` because its REPL is
   * a pipe to a process's stdin and a multi-line selection would arrive as
   * several lines, each evaluated on its own. Here the target is
   * `host.run`, which takes a chunk — so the text goes as written, which
   * keeps line numbers in any error and does not mangle a `--[[ ]]`
   * comment into a semicolon.
   *
   * A `.sc` file goes to sclang, everything else to matron. Nothing else
   * would make sense of an engine class.
   */
  const evalSelection = (): void => {
    if (repl === null) return;
    const selected = editor.getSelectedText();
    const code = selected.trim() === "" ? editor.session.getLine(editor.getCursorPosition().row) : selected;
    if (code.trim() === "") return;
    const target = current !== null && current.endsWith(".sc") ? "sc" : "matron";
    const err = repl.send(target, code);
    say(err === null ? `sent to ${target}` : err.split(NEWLINE)[0] ?? err);
  };

  let open = false;

  function show(): void {
    if (open) return;
    open = true;
    host.hidden = false;
    drawTree();
    paint();
    // Ace measures itself on attach, and it was attached to a hidden box.
    editor.resize(true);
    if (activity === "repl") repl?.active(true);
    if (activity === "repl") repl?.focus();
    else editor.focus();
    opts.onToggle?.(true);
  }

  function hide(): void {
    if (!open) return;
    // The restart question, on the way out and only when it is owed.
    const why = opts.restart?.pending() ?? [];
    if (why.length > 0) {
      exitAsk.confirm(
        `${why.join(", ")} ${why.length === 1 ? "needs" : "need"} a restart before ${why.length === 1 ? "it runs" : "they run"}. restart now?`,
        "restart",
        () => opts.restart?.now(),
        // CANCEL IS "LATER", and later still has to let go of the panel —
        // otherwise answering "not now" traps you inside the thing you were
        // trying to leave.
        () => {
          opts.restart?.later();
          shut();
        },
      );
      return;
    }
    shut();
  }

  /** Let go of the panel, with nothing left to ask. */
  function shut(): void {
    if (!open) return;
    open = false;
    host.hidden = true;
    repl?.active(false);
    opts.onToggle?.(false);
  }

  closeButton.addEventListener(
    "click",
    () => {
      // PRESSING IT AGAIN LEAVES, which is the escape hatch this needed.
      // The close button asking a question instead of closing is already a
      // surprise; one that could somehow not be answered would be a trap,
      // and that is exactly what the hidden-sidebar bug felt like. A second
      // press means the same thing as before: go.
      if (!exitAsk.element.hidden) {
        exitAsk.close();
        opts.restart?.later();
        shut();
        return;
      }
      hide();
    },
    { signal },
  );

  void applyPrefs();
  paintConfig();
  paintActions();

  host.hidden = true;
  host.dataset["activity"] = "edit";
  // E9-110 — a narrow screen starts with the editor, not with the
  // tree over it. Wide screens are unchanged: three columns, tree shown.
  showSide(!narrow());
  if (repl !== null) repl.element.hidden = true;

  return {
    get open() {
      return open;
    },
    show,
    hide,
    toggle() {
      if (open) hide();
      else show();
    },
    async want(names, neededBy) {
      // A panel built without a `project` has no installer at all, so it
      // answers that every name is missing rather than pretending.
      if (project === null) return [...names];
      return project.want(names, neededBy);
    },
    // E9-208 — the installer's queue, for the script store to share.
    library: project?.library ?? null,
    dispose() {
      ac.abort();
      unwatch();
      repl?.dispose();
      project?.dispose();
      editor.destroy();
      host.textContent = "";
      host.classList.remove("mdn");
    },
  };
}
