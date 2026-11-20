// maiden, phase 5: the project activity.
//
// WHAT MAIDEN'S IS. Two tabs behind a switcher — `installed` and
// `available` — over a catalogue the Go server keeps
// (`web/src/project-activity.js`). The installed list offers update and
// remove per project and an update-all; the available list offers install,
// marks what is already there, and recommends SYSTEM > RESTART afterwards.
// Every destructive action asks first, and the update warning is about
// local modifications being overwritten.
//
// WHAT IT IS HERE. The same two tabs and the same actions, over the
// machinery the community panel already had: `fetchCatalog` reads
// norns.community, `search` and `tagCounts` narrow it, and
// `installFromRepo` pulls a repository file by file through a CDN. There
// is no catalogue of our own and there will not be one — two catalogue
// systems would be two.
//
// THE RESTART LINE IS NOT MAIDEN'S SUPERSTITION, it is ours and it is
// narrower. On a norns a new script needs a restart because matron has to
// see its engine; here SELECT re-reads the tree on every scan, so a script
// made of Lua is ready at once — and a script that ships its own
// SuperCollider engine is not, because the classes are injected into
// sclang at boot. So the line says that, and only that.

import {
  communityUrl,
  search,
  tagCounts,
  type Catalog,
  type CatalogEntry,
} from "../community/catalog.js";
import type { CommunityInstall } from "../community/install.js";
import { sayNeeds, type Need } from "../community/needs.js";
import { offCatalogueEntry } from "../community/off-catalogue.js";

export interface MaidenProjectOptions {
  /** The catalogue, fetched once and kept. */
  readonly catalog: () => Promise<Catalog>;
  /** What is in `code/` right now. */
  readonly installed: () => string[];
  /** Install or re-install one entry. */
  readonly install: (entry: CatalogEntry, signal: AbortSignal, onProgress: (done: number, total: number) => void) => Promise<CommunityInstall>;
  /** Install from a repository URL typed by hand. */
  readonly installUrl: (url: string, signal: AbortSignal, onProgress: (done: number, total: number) => void) => Promise<CommunityInstall>;
  /** Delete `code/<name>` and everything under it. */
  readonly remove: (name: string) => void;
  /**
   * Told which installs brought a SuperCollider class with them.
   *
   * The panel owns the restart question; this only reports the fact. A
   * module that both noticed and acted would be one that had to be given a
   * way to reload the page.
   */
  readonly onEngines?: (names: readonly string[]) => void;
  /**
   * What a freshly installed script still needs, if anything.
   *
   * E9-32. Given here rather than worked out inside, because answering it
   * means reading the dust tree and this module has no filesystem — the
   * same division that keeps `install` and `remove` outside.
   */
  readonly needs?: (
    name: string,
    entries: readonly CatalogEntry[],
    /** Answer as if these projects were not installed. E9-184. */
    absent?: readonly string[],
  ) => Need[];
  readonly log?: (line: string) => void;
}

export interface MaidenProject {
  readonly element: HTMLElement;
  /** Shown or hidden. The catalogue is fetched the first time it is shown. */
  active(on: boolean): void;
  /**
   * E9-109 — ASK FOR A SCRIPT BY NAME, from outside the panel.
   *
   * The dependency a script discovers at LOAD time is the same thing the
   * installer discovers at install time, and it deserves the same
   * treatment: a row in the strip with its own count and its own cancel,
   * behind whatever else is queued. Doing it any other way would mean a
   * second installer with no progress and nothing to stop it.
   *
   * Resolves to what it could not find, so the caller can say so: a name
   * the catalogue does not carry is not an error here, it is an answer.
   */
  want(names: readonly string[], neededBy: string): Promise<string[]>;
  dispose(): void;
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

export function createMaidenProject(opts: MaidenProjectOptions): MaidenProject {
  const ac = new AbortController();
  const signal = ac.signal;
  const log = opts.log ?? ((): void => {});

  const root = el("div", "mdn-proj");

  const bar = el("div", "mdn-proj-tabs");
  const installedTab = el("button", "mdn-proj-tab", "installed");
  installedTab.type = "button";
  const availableTab = el("button", "mdn-proj-tab", "available");
  availableTab.type = "button";
  bar.append(installedTab, availableTab);

  const toolbar = el("div", "mdn-proj-bar");
  const query = el("input", "mdn-proj-search");
  query.type = "search";
  query.placeholder = "search";
  query.spellcheck = false;
  const urlInput = el("input", "mdn-proj-url");
  urlInput.type = "text";
  urlInput.placeholder = "install from a github url";
  urlInput.spellcheck = false;
  const urlGo = el("button", "mdn-proj-go", "install");
  urlGo.type = "button";
  const updateAll = el("button", "mdn-proj-go", "update all");
  updateAll.type = "button";
  /**
   * E9-184 — SEVERAL AT ONCE, on the installed tab.
   *
   * maiden has `update all` and nothing between that and one row at a
   * time. Removing nine of eleven scripts is nine confirmations, and
   * updating a chosen handful is not possible at all: the choice is one
   * or the whole shelf.
   *
   * `update selected` goes through the SAME queue as everything else —
   * three workers, one strip of progress rows, one cancel — so picking
   * six is six parallel installs and not a new installer. `remove
   * selected` is one dialogue over a list instead of a list of
   * dialogues; the deletion itself is synchronous work in the VFS, so
   * there is nothing to run in parallel there and nothing is pretended.
   */
  const updateSel = el("button", "mdn-proj-go", "update selected");
  updateSel.type = "button";
  const removeSel = el("button", "mdn-proj-go mdn-proj-del", "remove selected");
  removeSel.type = "button";
  const removeAll = el("button", "mdn-proj-go mdn-proj-del", "remove all");
  removeAll.type = "button";
  /**
   * Give up.
   *
   * ONLY ON SCREEN WHILE SOMETHING IS RUNNING, because a cancel button
   * with nothing to cancel is a button you have to think about. An install
   * is dozens of CDN requests and some scripts carry ten megabytes of
   * samples; on a slow line that is a long time to be told only that
   * something is happening.
   */
  const cancelButton = el("button", "mdn-proj-go mdn-proj-cancel", "cancel");
  cancelButton.type = "button";
  cancelButton.hidden = true;
  toolbar.append(query, urlInput, urlGo, updateAll, removeAll, updateSel, removeSel, cancelButton);

  const list = el("div", "mdn-proj-list");
  const note = el("div", "mdn-proj-note");

  // The one dialogue, reused: every destructive thing asks through it.
  const ask = el("div", "mdn-proj-ask");
  ask.hidden = true;
  const askText = el("span", "mdn-proj-ask-text");
  const askGo = el("button", "mdn-ask-go");
  askGo.type = "button";
  const askNo = el("button", "mdn-ask-no", "cancel");
  askNo.type = "button";
  ask.append(askText, askGo, askNo);
  let accept: (() => void) | null = null;
  askGo.addEventListener("click", () => accept?.(), { signal });
  askNo.addEventListener(
    "click",
    () => {
      ask.hidden = true;
      accept = null;
    },
    { signal },
  );
  const confirm = (text: string, word: string, then: () => void): void => {
    askText.textContent = text;
    askGo.textContent = word;
    accept = () => {
      ask.hidden = true;
      accept = null;
      then();
    };
    ask.hidden = false;
  };

  /**
   * The downloads, at the top, where they stay put.
   *
   * THE ROW STATE WAS NOT ENOUGH, and the reason is the search box: queue
   * four scripts, type three letters to find a fifth, and the four you are
   * waiting for are no longer on screen — the list shows what matches, not
   * what is happening. This shows what is happening, and it does not move.
   *
   * A job that has finished stays, without a cancel button, until the next
   * batch is asked for: "did that work" is a question people ask after the
   * fact, and an empty strip is a worse answer than a list saying `done`.
   */
  const jobs = el("div", "mdn-proj-jobs");
  jobs.hidden = true;
  root.append(bar, jobs, toolbar, ask, note, list);

  /**
   * E9-110 — THE LIST MUST NOT MOVE UNDER THE FINGER.
   *
   * Reported in every version, not only on a phone (user, 2026-11-18):
   * press `install` three hundred rows down the catalogue and the row you
   * pressed walks down the screen. The strip of downloads is pinned ABOVE
   * the list and appears when the first job does, so the scroller's box
   * gets shorter from the top — and the content inside it, which keeps
   * its `scrollTop`, slides down by exactly as much. Press three in a row
   * and it happens three times, and the second press lands on a row
   * nobody chose.
   *
   * The other way out was to reserve the band whether or not anything is
   * downloading, which is a permanent cost for a rare event. This pays
   * nothing while the strip is empty.
   *
   * SYNCHRONOUSLY, AND NOT THROUGH A ResizeObserver, which is what the
   * first draft did and is why this comment can say so: an observer fires
   * after layout and after paint, so the row had already moved and the
   * correction came a frame late and short — of a 50 px shift it caught
   * 21. Measured in the panel at 375 px.
   *
   * Only when the NUMBER of rows changes. `drawJobs` runs on every
   * progress tick, several times a second, and `offsetHeight` is a forced
   * layout; the strip's height can only change when a row comes or goes.
   *
   * At `scrollTop` 0 there is nothing to give back and the list does move
   * — which is the top of the list, where there is no row to lose.
   */
  let jobRowsDrawn = 0;

  /**
   * E9-39 — what a script is known to be missing here, by name.
   *
   * Computed over the whole catalogue by `tools/build-blockers.mjs` and
   * shipped beside the page. FAILS OPEN on purpose: a script absent from
   * the table gets no note, which is right for one added since the table
   * was made. The note says what is MISSING, never whether the script is
   * any good — "needs a MIDI device connected before it starts" is a fact
   * somebody can act on, and a red cross is not.
   *
   * THE EXAMPLE THAT USED TO BE HERE WAS "the shnth library, which is not
   * in the catalogue", and E9-70 measured it: shnth is reached only with a
   * shnth plugged in, tetrabobo and tetrabotis draw the same 695 and 417
   * pixels without it, and all ten notes of that kind were wrong. What a
   * library note says now is where the library IS — the generator and the
   * install below read the same `off-catalogue.json` — so a reader is
   * never sent to a catalogue that does not have it.
   */
  let blockers: Record<string, string[]> = {};
  const loadBlockers = async (): Promise<void> => {
    try {
      const res = await fetch("/community-blockers.json");
      if (!res.ok) return;
      const body = (await res.json()) as { scripts?: Record<string, string[]> };
      blockers = body.scripts ?? {};
      draw();
    } catch {
      /* no table shipped: no notes, and nothing said */
    }
  };
  /**
   * What an install LEFT OUT, said rather than returned and dropped.
   *
   * E9-45. `installFromRepo` has always computed this list with a reason
   * per file, and nothing ever showed it: installing `amenbreak` said
   * `105 files` while twenty were left behind, one of them the
   * `install.sh` the script runs on its first tick. A count with the
   * two commonest reasons is enough to make somebody ask the right
   * question; the whole list belongs in the console, not on a row.
   */
  const leftOut = (skipped: ReadonlyArray<{ path: string; why: string }>): string => {
    if (skipped.length === 0) return "";
    const why = new Map<string, number>();
    for (const s of skipped) why.set(s.why, (why.get(s.why) ?? 0) + 1);
    const top = [...why].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([w, c]) => `${c} ${w}`);
    return ` — ${skipped.length} left out: ${top.join(", ")}`;
  };

  const blockedBy = (name: string): string[] =>
    blockers[name] ?? blockers[name.toLowerCase()] ?? [];

  let catalog: Catalog | null = null;
  let loading = false;
  let tab: "installed" | "available" = "installed";
  let busy = false;
  /**
   * Which installed projects are ticked. E9-184.
   *
   * By the name `installed()` reports, which is the directory under
   * `code/` and the only name both the catalogue and the filesystem
   * agree on. Pruned on every draw of the installed tab rather than
   * cleaned up by whatever removed something: a name that is no longer
   * on disk must not be able to sit in here and be removed again.
   */
  const selected = new Set<string>();
  /** Waiting their turn, in the order they were asked for. */
  let queue: CatalogEntry[] = [];
  /**
   * E9-107 — HOW MANY DOWNLOAD AT ONCE.
   *
   * This was one, and E9-21 gave the reasons. The reason that was about
   * SPEED turns out to have been wrong, and measuring it is what showed
   * why: an install's first act is a `data.jsdelivr.com` listing that takes
   * between 280 and 1470 ms and fetches no file at all, and while that
   * request was in the air nothing else happened. Eight catalogue scripts,
   * browser cache defeated, three runs each, median wall clock — one at a
   * time 600 ms, two 344, three 243, four 208.
   *
   * Three rather than four: the curve is nearly flat past three, every
   * extra one is another listing and another staging tree held in memory at
   * once, and `install.ts` holds all of them to ONE budget of twelve
   * requests so this number does not multiply what lands on jsDelivr.
   *
   * The reason that was NOT about speed was real, and is closed in
   * `install.ts`: two installs of one name shared a staging directory.
   */
  const PARALLEL = 3;
  /** Downloading now, by lower-cased name, each with its own cancel. */
  const running = new Map<string, { done: number; total: number; ac: AbortController }>();
  /** Set by `run()` while it drains, so `enqueue` can add a worker to it. */
  let topUp: (() => void) | null = null;
  /**
   * The action button of each row on screen, by lower-cased name.
   *
   * Kept so a progress tick can repaint ONE button. `draw()` rebuilds the
   * whole list, and doing that a hundred times during a download would take
   * the scroll position with it every time.
   */
  const rowButtons = new Map<string, HTMLButtonElement>();
  /** The URL box runs outside the queue: it is one typed thing, not a list. */
  let urlRun: AbortController | null = null;

  /** One download, as the strip at the top shows it. */
  interface Job {
    readonly name: string;
    state: "queued" | "running" | "done" | "failed" | "cancelled";
    done: number;
    total: number;
    why?: string;
    /** It brought a SuperCollider class, so a restart is owed for it. */
    engine?: boolean;
    /** The script that needed it, when it was not asked for directly. */
    needed?: string;
  }
  let jobList: Job[] = [];
  const jobFor = (name: string): Job | undefined =>
    jobList.find((j) => j.name.toLowerCase() === name.toLowerCase());

  /** Repaint the strip. Cheap: it is at most a handful of rows. */
  /**
   * Scripts installed in this session that are still short of something,
   * by name. Cleared when the button is pressed or the strip is trimmed.
   */
  const pending = new Map<string, Need[]>();

  const drawJobs = (): void => {
    // See `jobRowsDrawn` above. `pending` adds a line of its own below the
    // job rows, so the count is of what will be DRAWN, not of `jobList`.
    const willDraw = jobList.length + pending.size;
    const resizing = willDraw !== jobRowsDrawn;
    const was = resizing ? jobs.offsetHeight : 0;
    const scrolled = list.scrollTop;
    jobRowsDrawn = willDraw;

    jobs.textContent = "";
    jobs.hidden = jobList.length === 0;
    for (const job of jobList) {
      const row = el("div", "mdn-proj-job");
      row.append(
        el(
          "span",
          "mdn-proj-job-name",
          job.needed === undefined ? job.name : `${job.name} — needed by ${job.needed}`,
        ),
      );
      const state =
        job.state === "running"
          ? job.total > 0
            ? `${job.done} of ${job.total}`
            : "starting…"
          : job.state === "failed"
            ? (job.why ?? "failed")
            : job.state;
      const label = el("span", "mdn-proj-job-state", state);
      label.dataset["state"] = job.state;
      row.append(label);
      // THE CANCEL IS ONLY THERE WHILE THERE IS SOMETHING TO CANCEL, which
      // is the whole of the request: a finished download with a cancel
      // button beside it is a button that lies about what it would do.
      if (job.state === "queued" || job.state === "running") {
        const stop = el("button", "mdn-proj-job-x", "cancel");
        stop.type = "button";
        stop.addEventListener(
          "click",
          () => {
            if (job.state === "running") running.get(job.name.toLowerCase())?.ac.abort();
            else dequeue(job.name);
          },
          { signal },
        );
        row.append(stop);
      }
      jobs.append(row);
    }
    // E9-32 — what the batch still needs, under the rows that caused it.
    //
    // One line and one button. The line NAMES the libraries, because
    // "esper also needs mx.synths" is a sentence somebody can act on and
    // "unmet dependencies" is a status code; the button only appears when
    // there is something installable behind the name, which an engine
    // need has not got.
    for (const [who, list] of pending) {
      const line = sayNeeds(who, list);
      if (line === "") continue;
      const row = el("div", "mdn-proj-job mdn-proj-need");
      row.append(el("span", "mdn-proj-job-name", line));
      jobs.append(row);
      jobs.hidden = false;
    }

    // The strip has just changed height, so give the scroller back what it
    // lost from the top. Read after the rebuild and applied in the same
    // task, which is what keeps the row the finger is on where it was.
    if (resizing) {
      const delta = (jobs.hidden ? 0 : jobs.offsetHeight) - was;
      if (delta !== 0 && scrolled > 0) list.scrollTop = scrolled + delta;
    }
  };

  const say = (text: string): void => {
    note.textContent = text;
  };

  // Started once the rest of this module exists, because it repaints.
  void loadBlockers();

  /** The catalogue entry a folder in `code/` came from, if any. */
  /**
   * The catalogue entry a folder in `code/` came from, if one can be named.
   *
   * E9-71 — AND THE SIX LIBRARIES THAT ARE NOT IN THE CATALOGUE. The queue
   * installs them now, and a row for something this panel fetched itself
   * that says "not in the catalogue, so there is nothing to update it
   * from" is the panel contradicting itself: it knows exactly where
   * `shnth` came from. Same source as the install and the blockers note,
   * `off-catalogue.json`, so the three cannot disagree.
   */
  const entryFor = (name: string): CatalogEntry | null =>
    catalog?.entries.find((e) => e.name.toLowerCase() === name.toLowerCase()) ??
    offCatalogueEntry(name);

  /**
   * E9-184 — WHO ELSE IS USING THE THING YOU ARE ABOUT TO DELETE.
   *
   * Twenty-eight of the catalogue's entries are LIBRARIES for other
   * entries, installed as projects of their own and indistinguishable in
   * the list from the scripts that use them. Removing one at a time, that
   * is a mistake you make once and notice when a script stops loading.
   * Removing nine at a time with one tick each, it is a mistake you make
   * without ever seeing the name go by.
   *
   * So the question is asked the other way round — not "what does this
   * need" but "what still here needs this" — against the projects that
   * would REMAIN. `needsOf` is the same reader the installer uses, so a
   * dependency it cannot see here is one it could not see there either,
   * and the two cannot disagree about what counts as needing something.
   *
   * Returns what would be stranded, by the project that would strand it.
   * Empty when nothing would be, which is the common case and prints as
   * the plain confirmation it was before.
   */
  const strandedBy = (going: readonly string[]): Array<[string, string[]]> => {
    const needs = opts.needs;
    if (needs === undefined || catalog === null) return [];
    const gone = new Set(going.map((n) => n.toLowerCase()));
    const out: Array<[string, string[]]> = [];
    for (const name of opts.installed()) {
      if (gone.has(name.toLowerCase())) continue;
      const lost = new Set<string>();
      // `going` passed as absent: the answer is what this project would
      // be short of AFTER the deletion, which is the only form of the
      // question that can be asked before it happens.
      for (const need of needs(name, catalog.entries, going)) {
        // `entry` is the catalogue name, `want` the raw one — a need the
        // catalogue cannot name is still a need, and an off-catalogue
        // library is installed under the name it asked for.
        const by = need.entry?.name ?? need.want;
        if (gone.has(by.toLowerCase())) lost.add(by);
      }
      if (lost.size > 0) out.push([name, [...lost]]);
    }
    return out;
  };

  /**
   * The sentence that asks, with the warning folded in when there is one.
   *
   * ONE DIALOGUE, not two. A second "are you sure" after the first is a
   * thing people learn to click through, and then the warning is worth
   * less than nothing.
   */
  const askToRemove = (names: readonly string[], then: () => void): void => {
    const what =
      names.length === 1
        ? `delete ${names[0]}?`
        : `delete these ${names.length}? ${names.join(", ")}.`;
    const stranded = strandedBy(names);
    const warn =
      stranded.length === 0
        ? ""
        : (stranded.length === 1
            ? " one project that stays would lose something it uses — "
            : ` ${stranded.length} projects that stay would lose something they use — `) +
          `${stranded.map(([who, lost]) => `${who} needs ${lost.join(" and ")}`).join("; ")}.`;
    confirm(`${what}${warn} this cannot be undone.`, "delete", then);
  };

  /** Delete a list and say so once, rather than once each. */
  const removeNames = (names: readonly string[]): void => {
    for (const name of names) {
      opts.remove(name);
      selected.delete(name);
    }
    log(`maiden: removed ${names.join(", ")}`);
    say(names.length === 1 ? `removed ${names[0]}` : `removed ${names.length} projects`);
    draw();
  };

  /**
   * What one row's button says, and what pressing it would do.
   *
   * `installed` is read from the tree when the list is drawn and passed in,
   * because asking for it on every progress tick would mean listing `code/`
   * a hundred times during one download.
   */
  const paintRow = (name: string, installed?: boolean): void => {
    const key = name.toLowerCase();
    const button = rowButtons.get(key);
    if (button === undefined) return;
    const live = running.get(key);
    if (live !== undefined) {
      button.textContent = live.total > 0 ? `${live.done} of ${live.total}` : "starting…";
      button.title = "downloading — press to give up on this one";
      button.dataset["state"] = "running";
      return;
    }
    if (queue.some((q) => q.name.toLowerCase() === key)) {
      button.textContent = "queued";
      button.title = "waiting its turn — press to take it out";
      button.dataset["state"] = "queued";
      return;
    }
    const here = installed ?? button.dataset["installed"] === "yes";
    button.dataset["installed"] = here ? "yes" : "no";
    button.textContent = here ? "installed" : "install";
    button.title = here ? "fetch it again, overwriting your changes to it" : "install it";
    delete button.dataset["state"];
  };

  /**
   * One line for the whole queue: what is downloading, and how many wait.
   *
   * THREE AT A TIME NEEDS A LINE THAT CAN SAY THREE. With one running the
   * old sentence is unchanged. With more, the counts would make something
   * nobody can read at a glance — `installing a… 4 of 9 · installing b… 40
   * of 105 · installing c…` — so past the first it says how many and leaves
   * the counts to the rows, which carry their own.
   */
  const sayQueue = (): void => {
    if (running.size === 0 && queue.length === 0) return;
    const first = [...running.entries()][0];
    const head =
      first === undefined
        ? ""
        : running.size > 1
          ? `installing ${running.size} scripts…`
          : first[1].total > 0
            ? `installing ${first[0]}… ${first[1].done} of ${first[1].total}`
            : `installing ${first[0]}…`;
    const rest = queue.length === 0 ? "" : `${head === "" ? "" : " · "}${queue.length} waiting`;
    say(head + rest);
  };

  const draw = (): void => {
    rowButtons.clear();
    list.textContent = "";
    installedTab.setAttribute("aria-pressed", String(tab === "installed"));
    availableTab.setAttribute("aria-pressed", String(tab === "available"));
    query.hidden = tab !== "available";
    urlInput.hidden = tab !== "available";
    urlGo.hidden = tab !== "available";
    updateAll.hidden = tab !== "installed" || busy;
    // Hidden by default and shown again by the installed branch, so the
    // available tab cannot be left holding a selection's buttons.
    removeAll.hidden = true;
    updateSel.hidden = true;
    removeSel.hidden = true;
    cancelButton.hidden = !busy;
    cancelButton.textContent =
      queue.length + running.size > 1 ? `cancel all (${queue.length + running.size})` : "cancel";

    if (tab === "installed") {
      const names = opts.installed().sort();
      // A tick on a project that is no longer on disk would be a delete
      // of nothing, or worse an update of it.
      for (const picked of [...selected]) {
        if (!names.includes(picked)) selected.delete(picked);
      }
      const picks = names.filter((n) => selected.has(n));
      const pickedUpdatable = picks.filter((n) => entryFor(n) !== null);
      updateAll.disabled = busy || names.every((n) => entryFor(n) === null);
      removeAll.hidden = busy || names.length === 0;
      removeAll.disabled = busy;
      removeAll.textContent = `remove all (${names.length})`;
      updateSel.hidden = busy || picks.length === 0;
      updateSel.disabled = busy || pickedUpdatable.length === 0;
      updateSel.textContent = `update ${picks.length} selected`;
      updateSel.title =
        pickedUpdatable.length === picks.length
          ? "fetch them again, overwriting your changes to them"
          : `${picks.length - pickedUpdatable.length} of them are not in the catalogue, so there is nothing to update them from`;
      removeSel.hidden = busy || picks.length === 0;
      removeSel.disabled = busy;
      removeSel.textContent = `remove ${picks.length} selected`;
      for (const name of names) {
        const entry = entryFor(name);
        const row = el("div", "mdn-proj-row");
        if (selected.has(name)) row.dataset["picked"] = "1";

        // A REAL CHECKBOX, not a div that looks like one: it is what a
        // keyboard reaches with Tab and Space, what a screen reader calls
        // a checkbox, and what the pointer already knows how to hit.
        const pick = el("input", "mdn-proj-pick");
        pick.type = "checkbox";
        pick.checked = selected.has(name);
        pick.disabled = busy;
        pick.setAttribute("aria-label", `select ${name}`);
        const toggle = (on: boolean): void => {
          if (on) selected.add(name);
          else selected.delete(name);
          draw();
        };
        pick.addEventListener("change", () => toggle(pick.checked), { signal });
        row.append(pick);

        const left = el("div", "mdn-proj-left");
        left.append(el("span", "mdn-proj-name", name));
        if (entry !== null) left.append(el("span", "mdn-proj-by", entry.author));
        const short = blockedBy(entry?.name ?? name);
        if (short.length > 0) {
          left.append(el("span", "mdn-proj-short", short.join(" · ")));
        }
        // The text is part of the target too — a 13px tickbox is not a
        // phone-sized thing to aim at, and the row has nothing else to do
        // when it is clicked.
        left.addEventListener(
          "click",
          () => {
            if (busy) return;
            toggle(!selected.has(name));
          },
          { signal },
        );
        row.append(left);

        const update = el("button", "mdn-proj-act", "update");
        update.type = "button";
        update.disabled = entry === null || busy;
        update.title =
          entry === null
            ? "not in the catalogue, so there is nothing to update it from"
            : "fetch it again, overwriting your changes to it";
        update.addEventListener(
          "click",
          () => {
            if (entry === null) return;
            confirm(
              `update ${name}? anything you changed in it is overwritten.`,
              "update",
              () => enqueue([entry]),
            );
          },
          { signal },
        );

        const remove = el("button", "mdn-proj-act mdn-proj-del", "remove");
        remove.type = "button";
        remove.disabled = busy;
        remove.addEventListener(
          "click",
          // Through the same two as the selection, so one row gets the
          // same warning about what else was using it. E9-184.
          () => askToRemove([name], () => removeNames([name])),
          { signal },
        );
        row.append(update, remove);
        list.append(row);
      }
      if (names.length === 0) list.append(el("div", "mdn-proj-empty", "nothing installed yet"));
      return;
    }

    if (catalog === null) {
      list.append(el("div", "mdn-proj-empty", loading ? "reading the catalogue…" : "no catalogue"));
      return;
    }
    const here = new Set(opts.installed().map((n) => n.toLowerCase()));
    const found = search(catalog.entries, query.value);
    /**
     * E9-133 — EVERY MATCH IS DRAWN. This read `found.slice(0, 300)`.
     *
     * Written in E9-07 with no comment, when the catalogue was smaller than
     * its own limit and so the limit did nothing. The catalogue is other
     * people's and it grows: at 355 entries the last 55 — everything from
     * `splicer` to the end of the alphabet — were not in the DOM at all.
     * Reported from a Pixel as a scroll that stops, which is what it looks
     * like from the outside: the list ends, nothing says why, and the
     * scripts are not findable unless you already know a name to search
     * for.
     *
     * WHAT IT WAS WORTH, measured in the page at 412x915 rather than
     * reasoned about. A full redraw, median of fifteen:
     *
     *     116 rows   ("grid")       4.5 ms
     *     355 rows   (everything)   8.7 ms      2860 elements
     *
     * Three times the rows for twice the time, so most of a redraw is not
     * the rows at all. Cutting 355 to 300 bought on the order of a
     * millisecond out of nine — and `draw()` does run on every keystroke
     * in the search box, so it is a real millisecond, on a phone perhaps
     * several. It was still a sixth of the catalogue.
     *
     * If this list ever does need a limit, it belongs where the cost is —
     * reusing rows instead of rebuilding all of them per keystroke, which
     * is the part that does not shrink with the row count — and it has to
     * be visible on screen, which the next line is the other half of.
     */
    let shown = 0;
    for (const entry of found) {
      const row = el("div", "mdn-proj-row");
      const left = el("div", "mdn-proj-left");
      left.append(el("span", "mdn-proj-name", entry.name));
      left.append(el("span", "mdn-proj-by", entry.author));
      if (entry.description !== "") {
        left.append(el("span", "mdn-proj-desc", entry.description));
      }
      const short = blockedBy(entry.name);
      if (short.length > 0) {
        left.append(el("span", "mdn-proj-short", short.join(" · ")));
      }
      row.append(left);

      const page = communityUrl(entry.name);
      if (page !== null) {
        const a = el("a", "mdn-proj-link", "details");
        a.href = page;
        a.target = "_blank";
        a.rel = "noreferrer noopener";
        row.append(a);
      }
      const code = el("a", "mdn-proj-link", "code");
      code.href = entry.url;
      code.target = "_blank";
      code.rel = "noreferrer noopener";
      row.append(code);

      const key = entry.name.toLowerCase();
      const add = el("button", "mdn-proj-act");
      add.type = "button";
      rowButtons.set(key, add);
      // EVERY ROW CARRIES ITS OWN STATE now, which is what a queue needs to
      // be legible: one status line cannot say "downloading this, three
      // waiting, that one done". The button is also the control for
      // whichever state it is in — click a queued one to take it out,
      // click the running one to give up on it.
      add.addEventListener(
        "click",
        () => {
          const live = running.get(key);
          if (live !== undefined) live.ac.abort();
          else if (queue.some((q) => q.name.toLowerCase() === key)) dequeue(entry.name);
          else enqueue([entry]);
        },
        { signal },
      );
      row.append(add);
      list.append(row);
      shown++;
      paintRow(entry.name, here.has(key));
    }
    if (shown === 0) list.append(el("div", "mdn-proj-empty", "nothing matches"));
    else {
      const tags = tagCounts(found)
        .slice(0, 8)
        .map(([t, n]) => `${t} ${n}`)
        .join(" · ");
      // NOT WHILE SOMETHING IS DOWNLOADING. `draw()` runs on every
      // keystroke in the search box, and the catalogue summary was
      // overwriting the queue's own line — so typing while three scripts
      // were installing replaced "installing oooooo… 40 of 96 · 2 waiting"
      // with a list of tag counts, and the progress appeared to stop.
      // E9-133 — `shown`, NOT `found.length`. This line said "355 of 355"
      // while 300 rows were on screen: it counted the search result, which
      // is the one number that cannot disagree with itself. Counting what
      // was actually appended means the summary and the list are the same
      // statement, so a limit reintroduced here could not go unannounced.
      if (busy) sayQueue();
      else say(`${shown} of ${catalog.entries.length}${tags === "" ? "" : ` — ${tags}`}`);
    }
  };

  /**
   * Add to the queue, and start the pump if it is not already going.
   *
   * A QUEUE AND THREE WORKERS, which is a change of mind from E9-21, and
   * the reason is at `PARALLEL` above: the listing request is where an
   * install's time actually went, and nothing overlapped it. The hazard
   * that argued against this — two installs of one name sharing a staging
   * directory — is refused in `install.ts` now, where the destination is
   * known, rather than relied upon not to happen here.
   */
  /**
   * How far a chain of needs may pull. E9-34.
   *
   * A library can itself need another, and nothing in the catalogue says
   * where that stops. Two is past every case measured — the deepest is a
   * script wanting a library that wants nothing — and it means a cycle, or
   * a repository that grows one, cannot turn an install into a download of
   * the whole catalogue.
   *
   * E9-107 — CARRIED BY THE ENTRY RATHER THAN COUNTED PER DRAIN. It used to
   * be one counter for the whole batch, so the THIRD script you asked for
   * got no libraries at all however shallow its own chain was: the guard is
   * about how far ONE chain pulls, and a counter shared by every chain in
   * the queue cannot say that. With three installs finishing in whatever
   * order the CDN decides, it would also have made which scripts got their
   * libraries depend on the weather.
   */
  const NEED_DEPTH = 2;
  /** How deep in a chain of needs each queued name sits. */
  const needDepthOf = new Map<string, number>();

  const enqueue = (
    entries: readonly CatalogEntry[],
    neededBy?: string,
    depth = 0,
  ): void => {
    // NOTHING IS CLEARED ON A NEW REQUEST. The first draft wiped finished
    // rows whenever the queue was idle, which read as the list losing its
    // history: a small script finishes between two clicks, so every click
    // started a "new batch" and threw away the one before. The strip is
    // the record of this visit, trimmed from the front below.
    for (const e of entries) {
      const key = e.name.toLowerCase();
      if (running.has(key)) continue;
      if (queue.some((q) => q.name.toLowerCase() === key)) continue;
      queue.push(e);
      needDepthOf.set(key, depth);
      if (jobFor(e.name) === undefined) {
        const job: Job = { name: e.name, state: "queued", done: 0, total: 0 };
        if (neededBy !== undefined) job.needed = neededBy;
        jobList.push(job);
      }
    }
    drawJobs();
    draw();
    // Either start the drain, or give the one already running another worker
    // for what was just added.
    if (busy) topUp?.();
    else void run();
  };

  /** Take it out of the queue again. Only possible before it starts. */
  const dequeue = (name: string): void => {
    const key = name.toLowerCase();
    queue = queue.filter((q) => q.name.toLowerCase() !== key);
    const job = jobFor(name);
    if (job !== undefined) job.state = "cancelled";
    drawJobs();
    draw();
    sayQueue();
  };

  const run = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    let ok = 0;
    /** Filled from the strip when the queue drains; see the summary below. */
    const engines: string[] = [];
    const failed: string[] = [];
    let cancelled = false;
    // THREE WORKERS OVER ONE QUEUE, which is the whole of the change here:
    // the body below is what it always was, and `queue.shift()` is still
    // what decides the order.
    const pump = async (): Promise<void> => {
      while (queue.length > 0) {
        const entry = queue.shift()!;
        const ac = new AbortController();
        running.set(entry.name.toLowerCase(), { done: 0, total: 0, ac });
        const job = jobFor(entry.name);
        if (job !== undefined) job.state = "running";
        drawJobs();
        draw();
        sayQueue();
        try {
          const r = await opts.install(entry, ac.signal, (done, total) => {
            // THE COUNT, not a spinner. "47 of 112" is the difference between
            // waiting and wondering whether it has stopped. Only the one row
            // and the one line are repainted: redrawing the whole list a
            // hundred times would take the scroll position with it.
            const live = running.get(entry.name.toLowerCase());
            if (live !== undefined) {
              live.done = done;
              live.total = total;
            }
            if (job !== undefined) {
              job.done = done;
              job.total = total;
            }
            drawJobs();
            paintRow(entry.name);
            sayQueue();
          });
          ok++;
          if (job !== undefined) {
            job.state = "done";
            job.engine = r.needsReload;
          }
          log(`maiden: installed ${entry.name} — ${r.files} files${leftOut(r.skipped)}`);
          // E9-32. ASKED HERE, while the tree is in the state the install
          // left it, and asked with the name the INSTALLER chose: it
          // lower-cases the folder, and `needsOf` looks for that folder.
          const short = r.name;
          const needs = opts.needs?.(short, catalog?.entries ?? []) ?? [];
          if (needs.length > 0) {
            log(`maiden: ${sayNeeds(short, needs)}`);
            // E9-34 — FETCHED, NOT OFFERED.
            //
            // A library a script cannot run without is not a choice to put
            // in front of somebody: the answer is always yes, and the
            // question is only legible to a reader who already knows what
            // `mx.synths` is. So it goes into the same queue, with the
            // reason beside it in the strip, and `remove` on the installed
            // tab undoes it like anything else.
            //
            // The DEPTH is the guard rather than a confirmation: a chain
            // deeper than two is a repository that has grown a cycle, not a
            // dependency somebody meant.
            const libs = needs
              .map((n) => n.entry)
              .filter((e): e is CatalogEntry => e !== null)
              .filter((e) => !opts.installed().some((n) => n.toLowerCase() === e.name.toLowerCase()));
            const mine = needDepthOf.get(entry.name.toLowerCase()) ?? 0;
            if (libs.length > 0 && mine < NEED_DEPTH) {
              enqueue(libs, short, mine + 1);
            }
            // Whatever is left after that — an engine with no script to
            // name — stays on screen, because nothing can be done about it
            // automatically and saying so is the whole value.
            const rest = needs.filter((n) => n.entry === null);
            if (rest.length > 0) pending.set(short, rest);
            else pending.delete(short);
          } else {
            pending.delete(short);
          }
        } catch (e) {
          const err = e as Error;
          if (err.name === "AbortError") {
            // CANCEL STOPS THIS ONE, NOT THE QUEUE — unless the queue was
            // emptied too, which is what the toolbar's button does. Giving up
            // on a script that is taking too long should not throw away the
            // four you asked for after it.
            if (job !== undefined) job.state = "cancelled";
            log(`maiden: ${entry.name} cancelled`);
            if (queue.length === 0) cancelled = true;
            continue;
          }
          if (job !== undefined) {
            job.state = "failed";
            job.why = err.message;
          }
        } finally {
          running.delete(entry.name.toLowerCase());
          drawJobs();
        }
      }
    };
    // TOPPED UP RATHER THAN STARTED THREE AT A TIME, and the difference is
    // not academic. Each click enqueues ONE entry — so three workers started
    // at the first click find the queue already empty, two of them return at
    // once, and the five rows clicked after that are drained by the one
    // survivor. MEASURED exactly that way in the page before this existed:
    // six rows clicked, peak concurrency one, and a change that did nothing
    // while every test passed.
    //
    // So workers are added whenever there is work for them — here and from
    // `enqueue`, which is how a click, and a dependency discovered half way
    // through, both join the batch already running.
    const workers = new Set<Promise<void>>();
    const addWorkers = (): void => {
      while (workers.size < PARALLEL && queue.length > 0) {
        const p = pump().finally(() => void workers.delete(p));
        workers.add(p);
      }
    };
    topUp = addWorkers;
    addWorkers();
    // The drain is over when nobody is working, not when the queue is empty:
    // the last worker is still writing a script into the tree.
    while (workers.size > 0) {
      await Promise.race([...workers]);
      addWorkers();
    }
    topUp = null;
    busy = false;
    needDepthOf.clear();
    drawJobs();
    draw();
    // THE SUMMARY IS READ OFF THE STRIP, not off this call's own counters,
    // and that is a fix rather than a flourish. A drain ends the moment the
    // queue is empty — and with eight files at a time a small script can
    // finish BETWEEN two clicks, so asking for five scripts can be five
    // separate drains. Each one then reported its own tally and the last
    // word was "1 installed" while the strip above it listed five `done`.
    // Measured exactly that way in the packaged application.
    //
    // The strip is what the person is looking at, so the sentence under it
    // counts the same things.
    const summary = jobList.filter((j) => j.state !== "queued" && j.state !== "running");
    ok = summary.filter((j) => j.state === "done").length;
    engines.length = 0;
    engines.push(...summary.filter((j) => j.state === "done" && j.engine === true).map((j) => j.name));
    failed.length = 0;
    failed.push(...summary.filter((j) => j.state === "failed").map((j) => `${j.name}: ${j.why ?? "failed"}`));
    cancelled = ok === 0 && failed.length === 0 && summary.some((j) => j.state === "cancelled");

    if (ok === 0 && failed.length === 0) {
      // NOTHING WAS LEFT BEHIND, which is the thing worth saying: the
      // download lands outside `code/` and is only moved in when it is
      // whole, so a cancelled one leaves no half script to find later.
      say(cancelled ? "cancelled — nothing was installed" : "nothing to do");
      return;
    }
    if (engines.length > 0) opts.onEngines?.(engines);
    // THE RESTART LINE, AND NOW ONLY WHEN IT IS TRUE.
    //
    // maiden says it after every install because on hardware it cannot know
    // and matron re-reads more than classes. Here the installer already
    // knows: `needsReload` is set when the install wrote a `.sc` or `.scd`
    // (install.ts:273), and nothing else needs a restart — SELECT re-reads
    // the tree on every scan, so Lua is ready at once.
    //
    // It used to be shown after ANY successful install, hedged into "a
    // script with its own engine needs…", which is a sentence that makes
    // the reader do the checking. Saying it only when it applies lets it be
    // said straight, and means the times it does appear are worth reading.
    const restart =
      engines.length === 0
        ? ""
        : ` — ${engines.join(", ")} ${engines.length === 1 ? "brings" : "bring"} a SuperCollider engine: SYSTEM > RESTART before ${engines.length === 1 ? "it runs" : "they run"}`;
    say(
      failed.length === 0
        ? `${ok} installed${restart}`
        : `${ok} installed, ${failed.length} failed: ${failed[0]}`,
    );
    for (const f of failed) log(`maiden: ${f}`);

    // TRIMMED LAST, and both halves of that were learned by getting it
    // wrong. Trimming when something is ADDED dropped the oldest rows of
    // the batch being watched: queue fourteen and the first two vanished
    // while they were still the answer to "did those work". Moving it to
    // the end of the drain fixed that and broke the sentence above —
    // the summary is read off the strip, so twenty installs reported
    // "12 installed" because twelve was all that was left to count.
    //
    // So: after the drain, and after the summary.
    // A NEED THAT HAS JUST BEEN MET STOPS BEING ONE. Pressing "install
    // them" enqueues the libraries, and when that drain ends the thing
    // that was missing is in `code/` — leaving the sentence on screen
    // would have it ask for something it already has.
    for (const [who, list] of [...pending]) {
      const still = opts.needs?.(who, catalog?.entries ?? []) ?? list;
      if (still.length === 0) pending.delete(who);
      else pending.set(who, still);
    }
    while (jobList.length > 12) {
      const i = jobList.findIndex((j) => j.state !== "queued" && j.state !== "running");
      if (i < 0) break;
      jobList.splice(i, 1);
    }
    drawJobs();
  };

  installedTab.addEventListener(
    "click",
    () => {
      tab = "installed";
      say("");
      draw();
    },
    { signal },
  );
  availableTab.addEventListener(
    "click",
    () => {
      tab = "available";
      void load();
      draw();
    },
    { signal },
  );
  query.addEventListener("input", () => draw(), { signal });
  cancelButton.addEventListener(
    "click",
    () => {
      // THE TOOLBAR BUTTON CLEARS THE QUEUE TOO, which is the difference
      // between it and a row's own button: one gives up on a script, this
      // gives up on the lot.
      queue = [];
      // All of them, not the first: with three downloading, aborting one
      // would leave two running under a button that said "cancel all".
      for (const live of running.values()) live.ac.abort();
      urlRun?.abort();
      say("cancelling…");
    },
    { signal },
  );
  urlGo.addEventListener(
    "click",
    () => {
      const url = urlInput.value.trim();
      if (url === "") return;
      busy = true;
      urlRun = new AbortController();
      draw();
      say(`installing from ${url}…`);
      void opts
        .installUrl(url, urlRun.signal, (done, total) => say(`installing from ${url}… ${done} of ${total}`))
        .then((r) => {
          log(`maiden: installed ${r.name} — ${r.files} files${leftOut(r.skipped)}`);
          if (r.needsReload) opts.onEngines?.([r.name]);
          // Same rule as the catalogue install above: said only when the
          // install actually wrote a SuperCollider class.
          say(
            r.needsReload
              ? `installed ${r.name} — it brings a SuperCollider engine: SYSTEM > RESTART before it runs`
              : `installed ${r.name} — ${r.files} files, ready now`,
          );
          urlInput.value = "";
        })
        .catch((e: Error) =>
          say(e.name === "AbortError" ? "cancelled — nothing was installed" : e.message),
        )
        .finally(() => {
          urlRun = null;
          busy = false;
          draw();
        });
    },
    { signal },
  );
  updateAll.addEventListener(
    "click",
    () => {
      const entries = opts
        .installed()
        .map((n) => entryFor(n))
        .filter((e): e is CatalogEntry => e !== null);
      if (entries.length === 0) return;
      confirm(
        `update all ${entries.length}? anything you changed in them is overwritten.`,
        "update all",
        () => enqueue(entries),
      );
    },
    { signal },
  );

  // --- E9-184: the selection's three buttons -------------------------------

  updateSel.addEventListener(
    "click",
    () => {
      const entries = opts
        .installed()
        .filter((n) => selected.has(n))
        .map((n) => entryFor(n))
        .filter((e): e is CatalogEntry => e !== null);
      if (entries.length === 0) return;
      confirm(
        `update ${entries.length}? ${entries.map((e) => e.name).join(", ")} — ` +
          `anything you changed in them is overwritten.`,
        "update",
        // The ordinary queue: three at a time, one strip of progress, one
        // cancel for the lot. Nothing here knows it is a selection.
        () => enqueue(entries),
      );
    },
    { signal },
  );

  removeSel.addEventListener(
    "click",
    () => {
      const names = opts.installed().filter((n) => selected.has(n));
      if (names.length === 0) return;
      askToRemove(names, () => removeNames(names));
    },
    { signal },
  );

  removeAll.addEventListener(
    "click",
    () => {
      const names = opts.installed();
      if (names.length === 0) return;
      // NO DEPENDENCY WARNING HERE, and not because it was forgotten:
      // nothing remains to be stranded. What this one has to say instead
      // is how much is going, because `remove all` is one press away from
      // an empty `code/` and the list it empties is off screen above the
      // button.
      confirm(
        `delete all ${names.length} installed projects? ${names.join(", ")}. ` +
          `this cannot be undone.`,
        "delete all",
        () => removeNames(names),
      );
    },
    { signal },
  );

  const load = async (): Promise<void> => {
    if (catalog !== null || loading) return;
    loading = true;
    draw();
    try {
      catalog = await opts.catalog();
    } catch (e) {
      say(`the catalogue could not be read — ${(e as Error).message}`);
    }
    loading = false;
    draw();
  };

  draw();

  return {
    element: root,
    async want(names, neededBy) {
      // The catalogue may never have been opened, so this is the one place
      // it is fetched for a reason other than somebody looking at it.
      await load();
      const missed: string[] = [];
      const found: CatalogEntry[] = [];
      for (const n of names) {
        const key = n.toLowerCase();
        const entry =
          catalog?.entries.find((e) => e.name.toLowerCase() === key) ??
          offCatalogueEntry(key) ??
          undefined;
        if (entry === undefined) missed.push(n);
        else found.push(entry);
      }
      // Depth 1, not 0: this IS a dependency, and what IT needs may be
      // fetched in turn, but a chain from here is bounded like any other.
      if (found.length > 0) enqueue(found, neededBy, 1);
      return missed;
    },
    active(on) {
      if (!on) return;
      // THE CATALOGUE IS READ FOR BOTH TABS, which maiden also does on
      // mount. Waiting for the `available` tab looked right and was not:
      // `update` is only offered for a project the catalogue knows, so
      // every installed row came up disabled saying "not in the catalogue"
      // about scripts that are in it. A network read on opening the
      // activity is the price of that sentence being true.
      void load();
      draw();
    },
    dispose() {
      ac.abort();
      root.remove();
    },
  };
}
