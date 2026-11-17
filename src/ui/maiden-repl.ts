// maiden, phase 3: the two consoles, as elements.
//
// WHAT MAIDEN'S IS. Tabs across the top, one per endpoint, the active one
// below, and a narrow tool bar on the right holding a single `clear`
// (`web/src/repl-activity.js`). Underneath, each tab is a websocket onto a
// process's standard input and output — `ws-wrapper` puts matron on :5555
// and sclang on :5556, and there is no protocol: you send a line, it lands
// on stdin, and whatever the process prints comes back.
//
// WHAT IT IS HERE. The same two consoles with the same two jobs and
// nothing in between: `host.run` IS matron's stdin because the page is
// matron, and `engine.runCode` is sclang's.
//
// EVERYTHING THAT CAN BE WRONG IS IN `repl-buffer.ts`, which has no DOM in
// it and is tested. This file is tabs, a `<pre>`, an input and a scroll
// position.
//
// WHAT IS NOT MAIDEN'S: the echo of what you typed, and of the error a
// chunk raised. On hardware those come back from the process, because the
// terminal is the process's own. Here `host.run` RETURNS the error instead
// of printing it, so a console that did not echo would swallow every
// mistake you made in it.

import { ReplTab, type ReplSource } from "../editor/repl-buffer.js";

export type { ReplSource };

export interface MaidenRepl {
  readonly element: HTMLElement;
  /** Start or stop reading. Called when the activity shows or hides. */
  active(on: boolean): void;
  /** Put a line into a named tab without typing it. */
  echo(name: string, line: string): void;
  /**
   * Send to a named tab as if it had been typed there, so that an `eval`
   * from the editor leaves the same trail as a line typed here.
   */
  send(name: string, code: string): string | null;
  focus(): void;
  dispose(): void;
}

export function createMaidenRepl(sources: readonly ReplSource[]): MaidenRepl {
  const ac = new AbortController();
  const signal = ac.signal;

  const root = document.createElement("div");
  root.className = "mdn-repl";

  const bar = document.createElement("div");
  bar.className = "mdn-repl-tabs";
  const body = document.createElement("div");
  body.className = "mdn-repl-body";
  const out = document.createElement("pre");
  out.className = "mdn-repl-out";
  const line = document.createElement("div");
  line.className = "mdn-repl-line";
  const prompt = document.createElement("span");
  prompt.className = "mdn-repl-prompt";
  const input = document.createElement("input");
  input.className = "mdn-repl-input";
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  line.append(prompt, input);
  body.append(out, line);

  const tools = document.createElement("div");
  tools.className = "mdn-repl-tools";
  const clearButton = document.createElement("button");
  clearButton.className = "mdn-repl-clear";
  clearButton.type = "button";
  clearButton.textContent = "clear";
  clearButton.title = "clear this console";
  tools.append(clearButton);

  root.append(bar, body, tools);

  const tabs = sources.map((source) => new ReplTab(source));
  const buttons = tabs.map((t) => {
    const b = document.createElement("button");
    b.className = "mdn-repl-tab";
    b.type = "button";
    b.textContent = t.name;
    b.title = `show ${t.name} repl`;
    bar.append(b);
    return b;
  });

  let at = 0;
  const tab = (): ReplTab => tabs[at] as ReplTab;

  const atBottom = (): boolean => out.scrollHeight - out.scrollTop - out.clientHeight < 24;

  const render = (toBottom: boolean): void => {
    out.textContent = tab().shown.join("\n");
    if (toBottom) out.scrollTop = out.scrollHeight;
  };

  /** Every tab, so a backlog is there when you switch to it. */
  const pullAll = (): boolean => {
    let changed = false;
    for (const t of tabs) if (t.pull()) changed = true;
    return changed;
  };

  const paintTabs = (): void => {
    buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(i === at)));
    prompt.textContent = `${tab().name} >`;
  };

  const show = (i: number): void => {
    if (i < 0 || i >= tabs.length || i === at) return;
    at = i;
    paintTabs();
    render(true);
    input.focus();
  };

  buttons.forEach((b, i) => b.addEventListener("click", () => show(i), { signal }));

  clearButton.addEventListener(
    "click",
    () => {
      tab().clear();
      render(true);
      input.focus();
    },
    { signal },
  );

  input.addEventListener(
    "keydown",
    (e) => {
      const t = tab();
      if (e.key === "Enter") {
        e.preventDefault();
        const code = input.value;
        if (code.trim() === "") return;
        input.value = "";
        t.send(code, true);
        render(true);
        return;
      }
      if (e.key === "ArrowUp") {
        const prev = t.up(input.value);
        if (prev !== null) {
          input.value = prev;
          e.preventDefault();
        }
        return;
      }
      if (e.key === "ArrowDown") {
        const next = t.down();
        if (next !== null) {
          input.value = next;
          e.preventDefault();
        }
      }
    },
    { signal },
  );

  // `ReturnType`, because @types/node is in this project and makes
  // `setInterval` a Timeout rather than a number.
  let timer: ReturnType<typeof setInterval> | null = null;

  paintTabs();

  return {
    element: root,
    active(on) {
      if (on && timer === null) {
        // Catch up on everything printed while nobody was watching, then
        // keep up. 150 ms is slower than the eye and far cheaper than a
        // frame callback that runs while the panel is closed.
        pullAll();
        render(true);
        timer = globalThis.setInterval(() => {
          const bottom = atBottom();
          if (pullAll()) render(bottom);
        }, 150);
      } else if (!on && timer !== null) {
        globalThis.clearInterval(timer);
        timer = null;
      }
    },
    echo(name, text) {
      const t = tabs.find((x) => x.name === name);
      if (t === undefined) return;
      t.put(text);
      if (t === tab()) render(true);
    },
    send(name, code) {
      const t = tabs.find((x) => x.name === name);
      if (t === undefined) return `no ${name} repl`;
      const err = t.send(code, false);
      if (t === tab()) render(true);
      return err;
    },
    focus() {
      input.focus();
    },
    dispose() {
      ac.abort();
      if (timer !== null) globalThis.clearInterval(timer);
      timer = null;
      root.remove();
    },
  };
}
