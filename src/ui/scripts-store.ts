// E9-208 — the script store.
//
// What maiden's project panel does — install, update, remove, several at
// once — in the shape people already know how to use: a front page of
// shelves, categories, a search, a library, and a page per script with one
// button that says `get` and then says `open`.
//
// IT IS A VIEW AND NOTHING ELSE. The queue is the project panel's
// (`CommunityLibrary`), so a script started here shows its progress there
// and the three downloads at a time are shared between them. The pictures
// come from `CoverStore`, which keeps them. What is shown is decided in
// `scripts-model.ts`, where it can be tested without a page.
//
// ONE PAGE IS BUILT AT A TIME and thrown away for the next: 355 cards are a
// few milliseconds of DOM, and a page that is rebuilt cannot drift out of
// step with what it is showing. What does NOT get rebuilt is what changes
// while you watch — a button counting files — which is repainted in place.
//
// E9-209 — THREE THINGS IT DID NOT HAVE.
//
//   charts     popular, new and recently updated, as shelves and as the
//              order of any list. From `MetaStore`; without one, or with
//              one that knows nothing, the store is sorted by name as it
//              was and says nothing about it.
//   standing   a script that will not work here is on the shelves like any
//              other, with a band across its picture saying so.
//   ahead      the catalogue it opens on is the one on disk from last
//              time, and a page's pictures are asked for when the page is
//              drawn, not when each scrolls into view.

import type { CatalogEntry } from "../community/catalog.js";
import { OWN_TAG } from "../community/own-scripts.js";
import type { CoverStore } from "../community/covers.js";
import type { MetaStore, ScriptMeta } from "../community/meta.js";
import { standing, type Standing } from "../community/verdicts.js";
import type { CommunityLibrary, LibraryState } from "./maiden-project.js";
import {
  agoLabel,
  browse,
  countLabel,
  dayOf,
  frontPage,
  metaLabel,
  monthLabel,
  SORTS,
  starsLabel,
  tagRows,
  withLocals,
  type BrowseQuery,
  type SortBy,
  type StoreView,
  type TagMatch,
} from "./scripts-model.js";

export interface ScriptsStoreOptions {
  readonly host: HTMLElement;
  readonly library: CommunityLibrary;
  readonly covers: CoverStore;
  /** Load an installed script now. False when it has nothing to run. */
  readonly run: (name: string) => boolean;
  /** Names whose SuperCollider classes are on disk and not yet compiled. */
  readonly restartOwed?: () => readonly string[];
  readonly restart?: () => void;
  readonly onToggle?: (open: boolean) => void;
  readonly today?: () => Date;
  /** Stars and dates, for the charts and the sort. Without it: by name. */
  readonly meta?: MetaStore;
  /** False to fetch only the pictures that are looked at. */
  readonly ahead?: () => boolean;
  /**
   * E9-211 — put a sample pack the person downloaded into `~/dust/audio`.
   * Resolves true when something was written.
   */
  readonly addSamples?: (bytes: Uint8Array, name: string) => Promise<boolean>;
  /**
   * E9-227 — fetch a sample pack for the person: through the page's own
   * server when it is a GitHub release. Null when it could not be fetched
   * here, and the by-hand steps are what is left.
   */
  readonly fetchSamples?: (url: string, onProgress: (got: number, total: number | null) => void) => Promise<Uint8Array | null>;
}

export interface ScriptsStore {
  readonly open: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
  dispose(): void;
}

type Attrs = Record<string, string | boolean | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text?: string,
  attrs: Attrs = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls !== "") node.className = cls;
  if (text !== undefined) node.textContent = text;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    node.setAttribute(k, v === true ? "" : v);
  }
  return node;
}

const ICON = {
  search: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="M15.5 15.5 20 20"/></g></svg>',
  close: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M14 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  out: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M9 6h9v9M18 6 7 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M12 4 21 19H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4M12 16.6v.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  no: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M6 18 18 6"/></g></svg>',
  info: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.4v.4"/></g></svg>',
} as const;

const iconFor = (st: Standing): string =>
  st.verdict === "gone" || st.verdict === "no" ? ICON.no : st.verdict === "needs" ? ICON.info : ICON.warn;

/** What an action button is showing, and what a press of it does. */
type Act = "get" | "cancel" | "open" | "restart" | "retry" | "none";

function actOf(
  state: LibraryState,
  owed: boolean,
  /** Why there is nothing to fetch, when there is nothing to fetch. */
  gone: string | null,
): { act: Act; label: string; title: string; progress: number } {
  if (state.job === "running") {
    const label = state.total > 0 ? `${state.done} / ${state.total}` : "starting";
    return {
      act: "cancel",
      label,
      title: "downloading — press to give up on this one",
      progress: state.total > 0 ? state.done / state.total : 0.03,
    };
  }
  if (state.job === "queued") return { act: "cancel", label: "queued", title: "waiting its turn — press to take it out", progress: 0 };
  if (state.job === "failed" && !state.installed) {
    return { act: "retry", label: "retry", title: state.why ?? "the last attempt failed", progress: 0 };
  }
  if (state.installed) {
    if (owed) {
      return {
        act: "restart",
        label: "restart",
        title: "it brought a SuperCollider engine, which is compiled at start — restart to finish",
        progress: 0,
      };
    }
    return { act: "open", label: "open", title: "load it on the norns now", progress: 0 };
  }
  if (gone !== null) return { act: "none", label: "unavailable", title: gone, progress: 0 };
  return { act: "get", label: "get", title: "install it", progress: 0 };
}

export function createScriptsStore(opts: ScriptsStoreOptions): ScriptsStore {
  const { host, library, covers } = opts;
  const ac = new AbortController();
  const { signal } = ac;
  const today = opts.today ?? (() => new Date());

  let open = false;
  let view: StoreView = "discover";
  let text = "";
  let tags: string[] = [];
  let match: TagMatch = "all";
  let sort: SortBy = "name";
  let selected: string | null = null;
  let confirming: string | null = null;
  let entries: CatalogEntry[] | null = null;
  let failed: string | null = null;
  let loading = false;
  let asked = false;

  // The shipped table and the kept one are read now, while nobody is
  // looking: by the time the store is opened the charts are simply there.
  void opts.meta?.ready();
  const metaOf = (name: string): ScriptMeta | null => opts.meta?.get(name) ?? null;
  const standingOf = (name: string): Standing | null => standing(name, library.state(name).notes);
  const facts = (m: ScriptMeta): string =>
    `${starsLabel(m.stars)} star${m.stars === 1 ? "" : "s"} on GitHub · published ${monthLabel(m.created)} · ` +
    `changed ${agoLabel(m.pushed, today())}`;

  // --- the frame, built once ---------------------------------------------

  host.classList.add("st-host");
  const root = h("div", "st", undefined, { role: "dialog", "aria-label": "scripts" });
  const top = h("header", "st-top");
  const brand = h("div", "st-brand", "scripts");
  const nav = h("nav", "st-nav");
  const tabs = new Map<StoreView, HTMLButtonElement>();
  for (const [v, label] of [
    ["discover", "discover"],
    ["browse", "browse"],
    ["installed", "library"],
  ] as const) {
    const b = h("button", "st-tab", label, { type: "button", "data-view": v });
    b.addEventListener(
      "click",
      () => {
        // A tab is a fresh start: a search left over from another one
        // would make the library look empty for no reason it shows.
        text = "";
        searchInput.value = "";
        tags = [];
        go(v);
      },
      { signal },
    );
    tabs.set(v, b);
    nav.append(b);
  }
  const libraryCount = h("span", "st-count");
  tabs.get("installed")!.append(libraryCount);

  const searchBox = h("label", "st-search");
  searchBox.innerHTML = ICON.search;
  const searchInput = h("input", "", undefined, {
    type: "search",
    placeholder: "search scripts, authors, tags",
    "aria-label": "search scripts",
    spellcheck: "false",
    autocomplete: "off",
  });
  searchBox.append(searchInput);

  const queuePill = h("div", "st-queue");
  queuePill.hidden = true;
  const closeButton = h("button", "st-icon", undefined, { type: "button", "aria-label": "close", title: "close" });
  closeButton.innerHTML = ICON.close;
  top.append(brand, nav, searchBox, queuePill, closeButton);

  const body = h("div", "st-body");
  const page = h("main", "st-page");
  const detail = h("aside", "st-detail");
  detail.hidden = true;
  body.append(page, detail);
  root.append(top, body);
  host.append(root);

  // --- pictures, asked for as they come into view ------------------------

  const paintCover = (box: HTMLElement, name: string, url: string | null): void => {
    if (url === null || box.dataset["name"] !== name) return;
    const img = h("img", "", undefined, { alt: "", draggable: "false", decoding: "async" });
    img.src = url;
    // The name goes; the band across it, if it has one, stays on top.
    box.querySelector(".st-cover-name")?.remove();
    box.prepend(img);
    box.dataset["has"] = "yes";
  };
  const wantCover = (box: HTMLElement): void => {
    const name = box.dataset["name"];
    if (name === undefined || box.dataset["asked"] === "yes") return;
    box.dataset["asked"] = "yes";
    void covers.url(name).then((url) => paintCover(box, name, url));
  };
  const watcher =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (seen) => {
            for (const s of seen) {
              if (!s.isIntersecting) continue;
              watcher?.unobserve(s.target);
              wantCover(s.target as HTMLElement);
              // On a shelf, the next few along as well: they are clipped by
              // the shelf and not by the window, so the margin below never
              // reaches them and each would appear a frame after its card.
              let next = s.target.closest(".st-card-tile")?.nextElementSibling ?? null;
              for (let i = 0; i < 4 && next !== null; i++, next = next.nextElementSibling) {
                const box = next.querySelector<HTMLElement>(".st-cover");
                if (box === null || box.dataset["asked"] === "yes") continue;
                watcher?.unobserve(box);
                wantCover(box);
              }
            }
          },
          { root: null, rootMargin: "600px 400px" },
        )
      : null;

  /**
   * Every picture this page has, then every picture there is.
   *
   * A card that scrolls into view asks for its own, and that request goes
   * to the front; this is what makes the answer usually "already here".
   * Sideways scrolling is why it matters most: a shelf's hidden cards are
   * clipped by the shelf, where the watcher's margin does not reach.
   */
  let warming: ReturnType<typeof setTimeout> | null = null;
  const warmSoon = (): void => {
    if (warming !== null || opts.ahead?.() === false) return;
    warming = setTimeout(() => {
      warming = null;
      if (!open) return;
      const names: string[] = [];
      for (const box of page.querySelectorAll<HTMLElement>(".st-cover")) {
        const n = box.dataset["name"];
        if (n !== undefined) names.push(n);
      }
      for (const e of entries ?? []) names.push(e.name);
      covers.warm(names);
    }, 250);
  };

  /** How a script stands here, said across its picture or in its corner. */
  const band = (st: Standing, name: string): HTMLElement => {
    const b = h("div", st.veiled ? "st-band" : "st-tag", undefined, {
      "data-verdict": st.verdict,
      title: st.measured !== "" ? st.measured : library.state(name).notes.join(" · "),
    });
    b.innerHTML = iconFor(st);
    b.append(h("span", "", st.label));
    return b;
  };

  /** A script's picture, or its name where the picture will be. */
  const cover = (name: string, cls = "st-cover"): HTMLElement => {
    const box = h("div", cls, undefined, { "data-name": name });
    box.append(h("span", "st-cover-name", name));
    const st = standingOf(name);
    if (st !== null) {
      box.dataset["standing"] = st.verdict;
      box.append(band(st, name));
    }
    const known = covers.peek(name);
    if (known !== undefined) {
      box.dataset["asked"] = "yes";
      paintCover(box, name, known);
    } else if (watcher !== null) watcher.observe(box);
    else wantCover(box);
    return box;
  };

  // --- the buttons that change while you watch ---------------------------

  const owed = (name: string): boolean =>
    (opts.restartOwed?.() ?? []).some((n) => n.toLowerCase() === name.toLowerCase());

  /** Every action button on the page, so progress repaints without a rebuild. */
  let live: Array<{ name: string; button: HTMLButtonElement; remove: HTMLButtonElement | null }> = [];

  const paintAction = (name: string, button: HTMLButtonElement, remove: HTMLButtonElement | null): void => {
    const state = library.state(name);
    const st = standingOf(name);
    const a = actOf(state, owed(name), st?.verdict === "gone" ? st.measured : null);
    button.disabled = a.act === "none";
    button.dataset["act"] = a.act;
    button.dataset["state"] = state.job ?? (state.installed ? "installed" : "none");
    button.title = a.title;
    button.style.setProperty("--p", String(a.progress));
    const label = button.querySelector(".st-act-label");
    if (label !== null) label.textContent = a.label;
    if (remove !== null) remove.hidden = !state.installed || state.job !== null;
  };

  const press = (name: string, act: string | undefined): void => {
    const entry = library.entry(name);
    if (act === "cancel") library.cancel(name);
    else if (act === "open") {
      if (opts.run(name)) hide();
    } else if (act === "restart") opts.restart?.();
    else if (entry !== null && entry.url !== "") library.install([entry]);
  };

  const action = (name: string, big = false): HTMLButtonElement => {
    const b = h("button", big ? "st-act st-act-big" : "st-act", undefined, { type: "button" });
    b.append(h("span", "st-act-label"));
    b.addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        press(name, b.dataset["act"]);
      },
      { signal },
    );
    return b;
  };

  // --- cards --------------------------------------------------------------

  const openDetail = (name: string): void => {
    selected = name;
    confirming = null;
    drawDetail();
  };

  const tagChip = (tag: string, cls = "st-chip"): HTMLButtonElement => {
    const b = h("button", cls, tag, { type: "button" });
    b.addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        tags = [tag];
        match = "all";
        selected = null;
        go("browse");
      },
      { signal },
    );
    return b;
  };

  /** `by`: which number a card shows in its corner — the one it is sorted by. */
  const card = (e: CatalogEntry, cls = "st-card", by: SortBy = "name"): HTMLElement => {
    const box = h("article", cls, undefined, { "data-entry": e.name });
    const main = h("button", "st-card-main", undefined, { type: "button", "aria-label": `${e.name} — details` });
    const textBox = h("div", "st-card-text");
    const title = h("div", "st-name", e.name);
    const line = h("div", "st-by");
    line.append(h("span", "st-author", e.author === "" ? "—" : e.author));
    const m = metaOf(e.name);
    if (m !== null) line.append(h("span", "st-meta", metaLabel(m, by, today()), { title: facts(m) }));
    textBox.append(title, line, h("p", "st-desc", e.description));
    main.append(cover(e.name), textBox);
    main.addEventListener("click", () => openDetail(e.name), { signal });

    const foot = h("div", "st-card-foot");
    const chips = h("div", "st-chips");
    for (const t of e.tags.slice(0, 3)) chips.append(tagChip(t));
    const remove = h("button", "st-x", undefined, {
      type: "button",
      title: `uninstall ${e.name}`,
      "aria-label": `uninstall ${e.name}`,
    });
    remove.innerHTML = ICON.close;
    remove.addEventListener(
      "click",
      (ev) => {
        ev.stopPropagation();
        selected = e.name;
        confirming = e.name;
        drawDetail();
      },
      { signal },
    );
    const act = action(e.name);
    foot.append(chips, remove, act);
    box.append(main, foot);
    live.push({ name: e.name, button: act, remove });
    paintAction(e.name, act, remove);
    return box;
  };

  // --- pages ---------------------------------------------------------------

  const query = (): BrowseQuery => ({ text, tags, match, sort, installedOnly: view === "installed" });
  const installedSet = (): Set<string> => new Set(library.installedNames().map((n) => n.toLowerCase()));

  const note = (textContent: string, cls = "st-note"): HTMLElement => h("p", cls, textContent);

  const drawDiscover = (all: CatalogEntry[]): void => {
    const front = frontPage(all, dayOf(today()), (name) => library.state(name).notes.length > 0, 14, metaOf);
    if (front.pick !== null) {
      const p = front.pick;
      const hero = h("section", "st-hero", undefined, { "data-entry": p.name });
      const art = h("button", "st-hero-art", undefined, { type: "button", "aria-label": `${p.name} — details` });
      art.append(cover(p.name, "st-cover st-cover-hero"));
      art.addEventListener("click", () => openDetail(p.name), { signal });
      const words = h("div", "st-hero-text");
      const chips = h("div", "st-chips");
      for (const t of p.tags.slice(0, 5)) chips.append(tagChip(t));
      const act = action(p.name, true);
      const more = h("button", "st-link", "details", { type: "button" });
      more.addEventListener("click", () => openDetail(p.name), { signal });
      const row = h("div", "st-hero-row");
      row.append(act, more);
      words.append(
        h("div", "st-eyebrow", "today's pick"),
        h("h2", "st-hero-name", p.name),
        h("div", "st-author", `by ${p.author}`),
        h("p", "st-hero-desc", p.description),
        chips,
        row,
      );
      hero.append(art, words);
      page.append(hero);
      live.push({ name: p.name, button: act, remove: null });
      paintAction(p.name, act, null);
    }

    const shelf = (
      title: string,
      more: string,
      onMore: () => void,
      list: readonly CatalogEntry[],
      by: SortBy,
    ): void => {
      const section = h("section", "st-shelf");
      const head = h("div", "st-shelf-head");
      const all2 = h("button", "st-link", more, { type: "button" });
      all2.addEventListener("click", onMore, { signal });
      head.append(h("h3", "st-shelf-title", title), all2);
      const row = h("div", "st-row");
      for (const e of list) row.append(card(e, "st-card st-card-tile", by));
      const nudge = (dir: number): HTMLButtonElement => {
        const b = h("button", `st-nudge ${dir < 0 ? "st-nudge-l" : "st-nudge-r"}`, dir < 0 ? "‹" : "›", {
          type: "button",
          "aria-label": dir < 0 ? "scroll back" : "scroll on",
          tabindex: "-1",
        });
        b.addEventListener("click", () => row.scrollBy({ left: dir * row.clientWidth * 0.8, behavior: "smooth" }), { signal });
        return b;
      };
      const rail = h("div", "st-row-wrap");
      rail.append(nudge(-1), row, nudge(1));
      section.append(head, rail);
      page.append(section);
    };

    // E9-213 — the scripts made for norns-js, first: they are on no chart,
    // having no stars to rank by, and nowhere else would they be found.
    const own = all.filter((e) => e.tags.includes(OWN_TAG));
    if (own.length > 0) {
      shelf(
        "made for norns-js",
        "see all",
        () => {
          tags = [OWN_TAG];
          match = "all";
          go("browse");
        },
        own,
        "name",
      );
    }

    // What everybody has, what has just arrived, what is being worked on.
    for (const c of front.charts) {
      shelf(
        c.title,
        "see all",
        () => {
          sort = c.sort;
          tags = [];
          match = "all";
          go("browse");
        },
        c.entries,
        c.sort,
      );
    }
    for (const s of front.shelves) {
      shelf(
        s.title,
        `see all ${s.total}`,
        () => {
          tags = [s.tag];
          match = "all";
          go("browse");
        },
        s.entries,
        "name",
      );
    }

    // Every tag, for whoever knows the word they are after.
    const cats = h("section", "st-shelf");
    cats.append(h("h3", "st-shelf-title", "all categories"));
    const grid = h("div", "st-cats");
    for (const r of tagRows(all, { text: "", tags: [], match: "all" }, new Set())) {
      const b = tagChip(r.tag, "st-cat");
      b.append(h("span", "st-cat-n", String(r.total)));
      grid.append(b);
    }
    cats.append(grid);
    page.append(cats);
  };

  const drawBrowse = (all: CatalogEntry[]): void => {
    const have = installedSet();
    const q = query();
    const found = browse(all, q, have, metaOf);

    if (view === "installed") {
      const owing = opts.restartOwed?.() ?? [];
      if (owing.length > 0 && opts.restart !== undefined) {
        const bar = h("div", "st-banner");
        const go2 = h("button", "st-act st-act-big", undefined, { type: "button", "data-act": "restart" });
        go2.append(h("span", "st-act-label", "restart"));
        go2.addEventListener("click", () => opts.restart?.(), { signal });
        bar.append(
          note(
            `${owing.join(", ")} brought ${owing.length === 1 ? "a SuperCollider engine" : "SuperCollider engines"}, ` +
              "compiled when the norns starts. restart to finish.",
            "",
          ),
          go2,
        );
        page.append(bar);
      }
    }

    const filter = h("div", "st-filter");
    const chosen = h("div", "st-chosen");
    for (const t of tags) {
      const b = h("button", "st-chip st-chip-on", t, { type: "button", title: `stop filtering by ${t}` });
      b.append(h("span", "st-chip-x", "×"));
      b.addEventListener(
        "click",
        () => {
          tags = tags.filter((x) => x !== t);
          draw();
        },
        { signal },
      );
      chosen.append(b);
    }
    if (tags.length > 1) {
      const m = h("button", "st-link", match === "all" ? "matching all — switch to any" : "matching any — switch to all", {
        type: "button",
      });
      m.addEventListener(
        "click",
        () => {
          match = match === "all" ? "any" : "all";
          draw();
        },
        { signal },
      );
      chosen.append(m);
    }
    if (tags.length > 0 || text !== "") {
      const clear = h("button", "st-link", "clear", { type: "button" });
      clear.addEventListener(
        "click",
        () => {
          tags = [];
          text = "";
          searchInput.value = "";
          draw();
        },
        { signal },
      );
      chosen.append(clear);
    }
    filter.append(h("div", "st-found", countLabel(found.length, view === "installed")), chosen);
    // An order is only offered when there is something to order by.
    if ((opts.meta?.size() ?? 0) > 0) {
      const sorter = h("div", "st-sort", undefined, { role: "group", "aria-label": "order" });
      for (const [s, label, title] of SORTS) {
        const b = h("button", "st-sort-b", label, { type: "button", title, "aria-pressed": String(s === sort) });
        b.addEventListener(
          "click",
          () => {
            sort = s;
            draw();
          },
          { signal },
        );
        sorter.append(b);
      }
      filter.append(sorter);
    }
    page.append(filter);

    const tagBar = h("div", "st-tags");
    for (const r of tagRows(all, q, have)) {
      if (r.chosen) continue;
      // A tag that leads nowhere from here is noise in a list of fifty.
      if (r.leads === 0) continue;
      const b = h("button", "st-chip", r.tag, { type: "button", title: `${r.leads} with ${r.tag}` });
      b.append(h("span", "st-chip-n", String(r.leads)));
      b.addEventListener(
        "click",
        () => {
          tags = [...tags, r.tag];
          draw();
        },
        { signal },
      );
      tagBar.append(b);
    }
    page.append(tagBar);

    if (found.length === 0) {
      page.append(
        note(
          view === "installed" && have.size === 0
            ? "nothing is installed yet. the scripts are in discover and browse."
            : "nothing matches. fewer words, or one tag less.",
          "st-empty",
        ),
      );
      return;
    }
    const grid = h("div", "st-grid");
    for (const e of found) grid.append(card(e, "st-card", sort));
    page.append(grid);
  };

  const draw = (): void => {
    live = [];
    page.textContent = "";
    for (const [v, b] of tabs) b.setAttribute("aria-pressed", String(v === view));
    root.dataset["view"] = view;
    if (entries === null) {
      page.append(
        note(
          failed !== null ? `the catalogue could not be read — ${failed}` : "reading the catalogue…",
          "st-empty",
        ),
      );
      if (failed !== null) {
        const again = h("button", "st-link", "try again", { type: "button" });
        again.addEventListener("click", () => void load(), { signal });
        page.append(again);
      }
      return;
    }
    const all = withLocals(entries, library.installedNames());
    if (view === "discover") drawDiscover(entries);
    else drawBrowse(view === "installed" ? all : entries);
    page.scrollTop = 0;
    warmSoon();
  };

  // --- the page of one script ---------------------------------------------

  const link = (label: string, url: string | null): HTMLElement | null => {
    if (url === null || url === "") return null;
    const a = h("a", "st-out", label, { href: url, target: "_blank", rel: "noopener noreferrer" });
    a.insertAdjacentHTML("beforeend", ICON.out);
    return a;
  };

  let detailAct: { name: string; button: HTMLButtonElement } | null = null;

  const drawDetail = (): void => {
    detailAct = null;
    detail.textContent = "";
    if (selected === null) {
      detail.hidden = true;
      root.dataset["detail"] = "no";
      return;
    }
    const name = selected;
    const e = library.entry(name) ?? withLocals(entries ?? [], library.installedNames()).find((x) => x.name === name);
    if (e === undefined) {
      selected = null;
      detail.hidden = true;
      return;
    }
    const state = library.state(name);
    detail.hidden = false;
    root.dataset["detail"] = "yes";

    const bar = h("div", "st-d-bar");
    const back = h("button", "st-icon", undefined, { type: "button", "aria-label": "back", title: "back" });
    back.innerHTML = ICON.back;
    back.addEventListener(
      "click",
      () => {
        selected = null;
        confirming = null;
        drawDetail();
      },
      { signal },
    );
    bar.append(back, h("span", "st-d-crumb", "scripts"));

    const hero = cover(name, "st-cover st-cover-detail");
    const head = h("div", "st-d-head");
    const titles = h("div", "st-d-titles");
    titles.append(h("h2", "st-d-name", e.name), h("div", "st-author", e.author === "" ? "—" : `by ${e.author}`));
    const m = metaOf(name);
    if (m !== null) {
      const asOf = opts.meta?.asOf() ?? null;
      const f = h("div", "st-d-facts", undefined, {
        title: `of its repository, from GitHub${asOf === null ? "" : `, as of ${asOf}`}`,
      });
      f.append(
        h("span", "st-d-stars", `★ ${starsLabel(m.stars)}`),
        h("span", "", `published ${monthLabel(m.created)}`),
        h("span", "", `changed ${agoLabel(m.pushed, today())}`),
      );
      titles.append(f);
    }
    const act = action(name, true);
    head.append(titles, act);
    detailAct = { name, button: act };
    paintAction(name, act, null);

    const second = h("div", "st-d-second");
    if (state.installed && state.job === null && e.url !== "") {
      const again = h("button", "st-link", "update", { type: "button", title: "fetch it again, overwriting your changes to it" });
      again.addEventListener("click", () => library.install([e]), { signal });
      second.append(again);
    }
    if (state.installed && state.job === null) {
      const remove = h("button", "st-link st-link-danger", "uninstall", { type: "button" });
      remove.addEventListener(
        "click",
        () => {
          confirming = name;
          drawDetail();
        },
        { signal },
      );
      second.append(remove);
    }

    const parts: HTMLElement[] = [bar, hero, head, second];

    if (confirming === name && state.installed) {
      const stranded = library.stranded([name]);
      const box = h("div", "st-confirm");
      const warn =
        stranded.length === 0
          ? ""
          : ` ${stranded.map(([who, lost]) => `${who} needs ${lost.join(" and ")}`).join("; ")} — ` +
            (stranded.length === 1 ? "it would lose that." : "they would lose that.");
      box.append(note(`delete ${name} and everything in its folder?${warn} this cannot be undone.`, ""));
      const yes = h("button", "st-act st-act-danger", undefined, { type: "button" });
      yes.append(h("span", "st-act-label", "delete"));
      yes.addEventListener(
        "click",
        () => {
          confirming = null;
          library.remove([name]);
          if (view === "installed") selected = null;
          draw();
          drawDetail();
        },
        { signal },
      );
      const no = h("button", "st-link", "keep it", { type: "button" });
      no.addEventListener(
        "click",
        () => {
          confirming = null;
          drawDetail();
        },
        { signal },
      );
      const row = h("div", "st-confirm-row");
      row.append(yes, no);
      box.append(row);
      parts.push(box);
    }

    if (state.job === "failed" && state.why !== undefined) parts.push(note(`the last attempt failed — ${state.why}`, "st-d-fail"));
    if (owed(name)) {
      parts.push(note("installed. it brought a SuperCollider engine, which is compiled when the norns starts: restart to finish.", "st-d-info"));
    }

    // How it stands here comes BEFORE what it is: it is the first thing
    // somebody about to press `get` needs to have read.
    const st = standingOf(name);
    if (st !== null) {
      const box = h("div", "st-d-notes", undefined, { "data-verdict": st.verdict });
      const head2 = h("div", "st-d-notes-head");
      head2.innerHTML = iconFor(st);
      head2.append(h("span", "", st.label));
      box.append(head2);
      if (st.measured !== "") box.append(note(st.measured, "st-d-measured"));
      const list = h("ul", "");
      for (const n of state.notes) list.append(h("li", "", n));
      box.append(note("what this build is missing for it:", "st-d-small"), list);
      if (st.verdict === "note") {
        box.append(note("some of these stop a script starting; some only take a part of it away.", "st-d-small"));
      }
      if (st.samples !== null && opts.addSamples !== undefined) box.append(samplesSteps(name, st.samples));
      parts.push(box);
    }

    parts.push(h("p", "st-d-desc", e.description));

    if (e.tags.length > 0) {
      const chips = h("div", "st-chips st-d-chips");
      for (const t of e.tags) chips.append(tagChip(t));
      parts.push(chips);
    }

    const links = h("div", "st-d-links");
    // E9-213 — one of the scripts made for norns-js has no repository yet:
    // its folder on this page has no index, so the link is its README.
    const own = e.tags.includes(OWN_TAG);
    for (const l of [
      link("documentation", e.documentation),
      link("discussion", e.discussion),
      own ? link("readme", `${e.url.replace(/\/*$/, "/")}README.md`) : link("source", e.url),
    ]) {
      if (l !== null) links.append(l);
    }
    if (links.childElementCount > 0) parts.push(links);

    detail.append(...parts);
    detail.scrollTop = 0;
  };

  /**
   * E9-211 — the two things a person does that a page may not: download the
   * pack from where its README says, and hand it over. The second is the
   * `unzip` into `~/dust/audio`; when it lands, the script has what it
   * needs, and its band and this box go.
   */
  const samplesSteps = (name: string, s: NonNullable<Standing["samples"]>): HTMLElement => {
    const box = h("div", "st-samples");
    // Decimal, as the note and a download manager say it.
    const mb = s.bytes > 0 ? `${Math.round(s.bytes / 1e6)} MB` : "";
    // E9-227 — and when this page's server can fetch it, one button does both.
    if (opts.fetchSamples !== undefined) {
      const fetchSamples = opts.fetchSamples;
      const auto = h("div", "st-step");
      const get = h("button", "st-act", undefined, { type: "button", "data-act": "get" });
      const getLabel = h("span", "st-act-label", "get it here");
      get.append(getLabel);
      const said = h("span", "st-d-small", mb === "" ? "from the author's release" : `${mb}, from the author's release`);
      get.addEventListener(
        "click",
        () => {
          get.disabled = true;
          getLabel.textContent = "downloading…";
          void (async () => {
            let ok = false;
            try {
              const bytes = await fetchSamples(s.url, (got, total) => {
                getLabel.textContent =
                  total !== null ? `downloading… ${Math.floor((got * 100) / total)}%` : `downloading… ${Math.round(got / 1e6)} MB`;
              });
              if (bytes !== null) {
                getLabel.textContent = "adding…";
                ok = (await opts.addSamples?.(bytes, s.file)) === true;
              }
            } catch {
              ok = false;
            }
            get.disabled = false;
            getLabel.textContent = ok ? "added" : "get it here";
            if (!ok) said.textContent = "it could not be fetched here — download it and add it by hand, below";
            if (ok && selected === name) {
              draw();
              drawDetail();
            }
          })();
        },
        { signal },
      );
      auto.append(get, said);
      box.append(auto, note("or by hand:", "st-d-small"));
    }
    const one = h("div", "st-step");
    one.append(h("span", "st-step-n", "1"));
    const dl = h("a", "st-out", `download ${s.file}`, { href: s.url, target: "_blank", rel: "noopener noreferrer" });
    dl.insertAdjacentHTML("beforeend", ICON.out);
    one.append(dl, h("span", "st-d-small", mb === "" ? "from the author's release" : `${mb}, from the author's release`));
    const two = h("div", "st-step");
    two.append(h("span", "st-step-n", "2"));
    const add = h("button", "st-act", undefined, { type: "button", "data-act": "get" });
    const label = h("span", "st-act-label", "add it here");
    add.append(label);
    const picker = h("input", "", undefined, { type: "file", accept: ".zip,application/zip", hidden: true });
    add.addEventListener("click", () => picker.click(), { signal });
    picker.addEventListener(
      "change",
      () => {
        const file = picker.files?.[0];
        if (file === undefined) return;
        add.disabled = true;
        label.textContent = "adding…";
        void (async () => {
          let ok = false;
          try {
            ok = (await opts.addSamples?.(new Uint8Array(await file.arrayBuffer()), file.name)) === true;
          } finally {
            picker.value = "";
            add.disabled = false;
            label.textContent = ok ? "added" : "add it here";
          }
          if (ok && selected === name) {
            draw();
            drawDetail();
          }
        })();
      },
      { signal },
    );
    two.append(add, picker, h("span", "st-d-small", "it goes into ~/dust/audio, where its README unzips it"));
    box.append(one, two);
    return box;
  };

  // --- keeping up ----------------------------------------------------------

  let lastInstalled = "";
  let scheduled = false;
  const refresh = (): void => {
    if (scheduled) return;
    scheduled = true;
    const run = (): void => {
      scheduled = false;
      if (!open) return;
      const now = [...library.installedNames()].sort().join("\n");
      const changed = now !== lastInstalled;
      lastInstalled = now;
      libraryCount.textContent = String(library.installedNames().length);
      const busy = library.busy();
      queuePill.hidden = busy.running + busy.waiting === 0;
      queuePill.textContent =
        `installing ${busy.running}` + (busy.waiting > 0 ? ` · ${busy.waiting} waiting` : "");
      // What is installed decides what the library shows and what a
      // removed script's page says: those are rebuilt. A count going up
      // is not: the buttons are repainted where they are.
      if (changed && view === "installed") draw();
      else for (const a of live) paintAction(a.name, a.button, a.remove);
      if (changed || confirming !== null) drawDetail();
      else if (detailAct !== null) paintAction(detailAct.name, detailAct.button, null);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else run();
  };
  const unwatch = library.onChange(refresh);
  // Numbers that arrive while the page is being read do not reshuffle it
  // under the reader: they are simply there the next time it is drawn.
  const unmeta = opts.meta?.onChange(() => {
    if (open && selected === null && page.scrollTop === 0) draw();
  });

  const sameList = (a: readonly CatalogEntry[] | null, b: readonly CatalogEntry[]): boolean =>
    a !== null &&
    a.length === b.length &&
    a.every((e, i) => e.name === b[i]!.name && e.url === b[i]!.url && e.description === b[i]!.description);

  /**
   * The catalogue, from the network — behind the copy from last time.
   *
   * When there IS a copy from last time the page is already drawn from it,
   * and this redraws only if what arrives is different: nearly never. When
   * the network does not answer, the copy is what the store goes on with,
   * which is the store working with no network at all.
   */
  const load = async (): Promise<void> => {
    if (loading) return;
    loading = true;
    failed = null;
    if (entries === null) draw();
    const charted = opts.meta?.size() ?? 0;
    let fresh = false;
    try {
      const [c] = await Promise.all([library.load(), opts.meta?.ready()]);
      if (c === null) {
        if (entries === null) failed = "see the log";
      } else if (!sameList(entries, c.entries)) {
        entries = [...c.entries];
        fresh = true;
      }
    } catch (e) {
      if (entries === null) failed = (e as Error).message;
    }
    loading = false;
    if (fresh || entries === null || (opts.meta?.size() ?? 0) !== charted) draw();
    refresh();
    if (entries !== null) void opts.meta?.refresh(entries);
  };

  function go(v: StoreView): void {
    view = v;
    selected = null;
    confirming = null;
    drawDetail();
    draw();
  }

  // --- the frame's own controls -------------------------------------------

  searchInput.addEventListener(
    "input",
    () => {
      text = searchInput.value;
      // Typing on the front page is asking for results, not for shelves.
      if (view === "discover" && text.trim() !== "") view = "browse";
      draw();
    },
    { signal },
  );
  closeButton.addEventListener("click", () => hide(), { signal });
  // A click on the dark outside the sheet puts it away, as a store's does.
  host.addEventListener(
    "pointerdown",
    (e) => {
      if (e.target === host) hide();
    },
    { signal },
  );
  globalThis.addEventListener(
    "keydown",
    (e) => {
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (confirming !== null) {
          confirming = null;
          drawDetail();
        } else if (selected !== null) {
          selected = null;
          drawDetail();
        } else if (document.activeElement === searchInput && searchInput.value !== "") {
          searchInput.value = "";
          text = "";
          draw();
        } else hide();
      } else if (e.key === "/" && document.activeElement !== searchInput) {
        e.preventDefault();
        searchInput.focus();
      }
    },
    { signal, capture: true },
  );

  function show(): void {
    if (open) return;
    open = true;
    host.hidden = false;
    opts.onToggle?.(true);
    lastInstalled = [...library.installedNames()].sort().join("\n");
    if (entries === null) {
      const kept = library.kept();
      if (kept !== null && kept.entries.length > 0) entries = [...kept.entries];
    }
    if (entries !== null) draw();
    // Once a session, or again after a failure with nothing to show.
    if (!asked || entries === null) {
      asked = true;
      void load();
    }
    drawDetail();
    refresh();
  }

  function hide(): void {
    if (!open) return;
    open = false;
    host.hidden = true;
    selected = null;
    confirming = null;
    opts.onToggle?.(false);
  }

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
    dispose() {
      ac.abort();
      unwatch();
      unmeta?.();
      if (warming !== null) clearTimeout(warming);
      watcher?.disconnect();
      root.remove();
      host.classList.remove("st-host");
    },
  };
}
