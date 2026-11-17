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
  readonly needs?: (name: string, entries: readonly CatalogEntry[]) => Need[];
  readonly log?: (line: string) => void;
}

export interface MaidenProject {
  readonly element: HTMLElement;
  /** Shown or hidden. The catalogue is fetched the first time it is shown. */
  active(on: boolean): void;
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
  toolbar.append(query, urlInput, urlGo, updateAll, cancelButton);

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
  /** Waiting their turn, in the order they were asked for. */
  let queue: CatalogEntry[] = [];
  /** The one being downloaded, with the handle its cancel button pulls. */
  let current: { key: string; done: number; total: number; ac: AbortController } | null = null;
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
            if (job.state === "running") current?.ac.abort();
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
    if (current?.key === key) {
      button.textContent = current.total > 0 ? `${current.done} of ${current.total}` : "starting…";
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

  /** One line for the whole queue: what is downloading, and how many wait. */
  const sayQueue = (): void => {
    if (current === null && queue.length === 0) return;
    const head =
      current === null
        ? ""
        : current.total > 0
          ? `installing ${current.key}… ${current.done} of ${current.total}`
          : `installing ${current.key}…`;
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
    cancelButton.hidden = !busy;
    cancelButton.textContent = queue.length > 0 ? `cancel all (${queue.length + 1})` : "cancel";

    if (tab === "installed") {
      const names = opts.installed().sort();
      updateAll.disabled = busy || names.every((n) => entryFor(n) === null);
      for (const name of names) {
        const entry = entryFor(name);
        const row = el("div", "mdn-proj-row");
        const left = el("div", "mdn-proj-left");
        left.append(el("span", "mdn-proj-name", name));
        if (entry !== null) left.append(el("span", "mdn-proj-by", entry.author));
        const short = blockedBy(entry?.name ?? name);
        if (short.length > 0) {
          left.append(el("span", "mdn-proj-short", short.join(" · ")));
        }
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
          () => {
            confirm(`delete ${name}? this cannot be undone.`, "delete", () => {
              opts.remove(name);
              log(`maiden: removed ${name}`);
              say(`removed ${name}`);
              draw();
            });
          },
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
    for (const entry of found.slice(0, 300)) {
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
          if (current?.key === key) current.ac.abort();
          else if (queue.some((q) => q.name.toLowerCase() === key)) dequeue(entry.name);
          else enqueue([entry]);
        },
        { signal },
      );
      row.append(add);
      list.append(row);
      paintRow(entry.name, here.has(key));
    }
    if (found.length === 0) list.append(el("div", "mdn-proj-empty", "nothing matches"));
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
      if (busy) sayQueue();
      else say(`${found.length} of ${catalog.entries.length}${tags === "" ? "" : ` — ${tags}`}`);
    }
  };

  /**
   * Install or update, one at a time and saying which one.
   *
   * SEQUENTIAL, not parallel: each install is dozens of file requests
   * through a CDN, and twenty at once is how a page gets itself rate
   * limited into failing all of them.
   */
  /**
   * Add to the queue and start it if it is not already going.
   *
   * A QUEUE AND NOT PARALLEL INSTALLS, which was the question and this is
   * the answer. Running them at once would buy little — they all come from
   * one CDN, and the concurrency that matters is already inside a single
   * install (`install.ts`, eight files at a time, measured) — and it would
   * cost real things: two installs of the same name share one staging
   * directory, and the first to finish would sweep it while the second was
   * still writing. One at a time also hands you the FIRST script while the
   * rest are still arriving, which parallel never does.
   */
  /**
   * How far a chain of needs may pull. E9-34.
   *
   * A library can itself need another, and nothing in the catalogue says
   * where that stops. Two is past every case measured — the deepest is a
   * script wanting a library that wants nothing — and it means a cycle, or
   * a repository that grows one, cannot turn an install into a download of
   * the whole catalogue.
   */
  const NEED_DEPTH = 2;
  let needDepth = 0;

  const enqueue = (entries: readonly CatalogEntry[], neededBy?: string): void => {
    // NOTHING IS CLEARED ON A NEW REQUEST. The first draft wiped finished
    // rows whenever the queue was idle, which read as the list losing its
    // history: a small script finishes between two clicks, so every click
    // started a "new batch" and threw away the one before. The strip is
    // the record of this visit, trimmed from the front below.
    for (const e of entries) {
      const key = e.name.toLowerCase();
      if (current?.key === key) continue;
      if (queue.some((q) => q.name.toLowerCase() === key)) continue;
      queue.push(e);
      if (jobFor(e.name) === undefined) {
        const job: Job = { name: e.name, state: "queued", done: 0, total: 0 };
        if (neededBy !== undefined) job.needed = neededBy;
        jobList.push(job);
      }
    }
    drawJobs();
    draw();
    if (!busy) void run();
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
    while (queue.length > 0) {
      const entry = queue.shift()!;
      const ac = new AbortController();
      current = { key: entry.name.toLowerCase(), done: 0, total: 0, ac };
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
          if (current !== null) {
            current.done = done;
            current.total = total;
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
          if (libs.length > 0 && needDepth < NEED_DEPTH) {
            needDepth++;
            enqueue(libs, short);
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
        current = null;
        drawJobs();
      }
    }
    busy = false;
    needDepth = 0;
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
      current?.ac.abort();
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
