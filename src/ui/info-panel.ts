// E9-277 — `info`: the loaded script's documentation and its discussion,
// over the page.
//
// What a script does with its keys and encoders is in its README and in the
// thread its author started on lines, and neither was a click away: the
// store links them, in a new tab, and only for a script being browsed. This
// shows them over the instrument, for the script that is loaded — or the
// last one asked for, which is the one somebody wants to read about when it
// has just failed to start.
//
// DOCUMENTATION is the README: the copy installed with the script when it
// has one (29 of the 35 here do), else the repository's, from
// raw.githubusercontent (CORS: yes). Rendered with `marked`, then rebuilt
// from what is allowed (sanitize.ts). Its pictures come from the script's
// own folder when they are there, else through the page's own server.
//
// DISCUSSION is the thread, a page of twenty posts at a time, through the
// page's own server (tools/info-relay.mjs): lines sends no CORS and may not
// be framed. A server without the relay (any static one) is told apart by
// the relay's header, and the sheet says so and links to the thread.

import type { CatalogEntry } from "../community/catalog.js";
import {
  INFO_PREFIX,
  README_NAMES,
  blobUrl,
  githubRepo,
  headerComment,
  inRepo,
  isAbsolute,
  linesSlug,
  linesTopic,
  onLines,
  rawUrl,
  readmeName,
  relayImage,
  searchHit,
  searchPath,
  topicPage,
  topicPath,
  type Post,
  type Repo,
} from "../community/script-info.js";
import { sanitizeInto, type Resolver } from "./sanitize.js";
import type { Vfs } from "../fs/vfs.js";

export interface InfoPanelOptions {
  readonly host: HTMLElement;
  readonly vfs: Vfs;
  /** The path of the last script asked for, or null. */
  readonly script: () => string | null;
  /** Its catalogue entry, when it has one. */
  readonly entry: (name: string) => Promise<CatalogEntry | null>;
  readonly onToggle?: (open: boolean) => void;
  readonly fetch?: typeof fetch;
}

export interface InfoPanel {
  isOpen(): boolean;
  open(tab?: Tab): void;
  close(): void;
}

type Tab = "doc" | "talk";

const RELAY_HEADER = "X-Norns-Relay";
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== "") e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function out(label: string, href: string): HTMLAnchorElement {
  const a = el("a", "st-out", label);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

/** The folder under `~/dust/code` a script path is in: the script's name. */
function nameOf(path: string | null): string | null {
  if (path === null) return null;
  const parts = path.split("/");
  const at = parts.indexOf("code");
  return at >= 0 && parts.length > at + 1 ? parts[at + 1]! : null;
}

export function createInfoPanel(opts: InfoPanelOptions): InfoPanel {
  const { host, vfs } = opts;
  const get = opts.fetch ?? ((u: RequestInfo | URL, i?: RequestInit) => fetch(u, i));
  host.classList.add("inf-host");
  host.hidden = true;

  const sheet = el("div", "inf");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "about this script");
  const top = el("div", "inf-top");
  const title = el("div", "inf-title");
  const nav = el("div", "st-nav");
  const tabDoc = el("button", "st-tab", "documentation");
  const tabTalk = el("button", "st-tab", "discussion");
  nav.append(tabDoc, tabTalk);
  const close = el("button", "inf-close", "×");
  close.title = "close (Esc)";
  close.setAttribute("aria-label", "close");
  top.append(title, nav, close);
  const body = el("div", "inf-body");
  sheet.append(top, body);
  host.append(sheet);

  let shownFor: string | null = null;
  /** Blob addresses made for the pictures in the script's own folder. */
  let blobs: string[] = [];
  /** What each tab drew last, per script, so going back is instant. */
  const drawn = new Map<string, HTMLElement>();
  let relayUp: Promise<boolean> | null = null;

  const relay = (): Promise<boolean> =>
    (relayUp ??= get(`${INFO_PREFIX}ping`)
      .then((r) => r.ok && r.headers.get(RELAY_HEADER) === "1")
      .catch(() => false));

  const say = (box: HTMLElement, text: string, cls = "inf-note"): HTMLElement => {
    const p = el("p", cls, text);
    box.append(p);
    return p;
  };

  // --- addresses --------------------------------------------------------------

  /** Pictures: the folder's own file, the relay, the host itself, or a link. */
  const picture = async (url: string): Promise<{ src: string; cors?: boolean } | { link: string } | null> => {
    const up = await relay();
    const via = relayImage(url);
    if (via !== null && up) return { src: via };
    // No relay: hosts that answer a page anonymously still show (the isolated
    // page asks them with CORS); the rest become a link.
    if (/^https:\/\/(raw\.githubusercontent\.com|cdn\.jsdelivr\.net|(l\.)?llllllll\.co\/(user_avatar|images\/emoji))\//.test(url)) {
      return { src: url, cors: true };
    }
    return /^https?:\/\//.test(url) ? { link: url } : null;
  };

  /**
   * A resolver for a README: relative paths are the repository's, or the
   * folder's. `prepare` asks where every picture comes from first, because
   * the rebuild that uses the answers is synchronous.
   */
  const readmeResolver = (dir: string | null, repo: Repo | null): Resolver & { prepare(html: string): Promise<void> } => {
    const pics = new Map<string, { src: string; cors?: boolean } | { link: string } | null>();
    return {
      link: (href) => {
        if (/^(https?:|mailto:)/i.test(href)) return href;
        if (isAbsolute(href)) return null;
        const p = inRepo(href);
        if (p === null) return null;
        return repo !== null ? blobUrl(repo, p) : null;
      },
      image: (src) => {
        if (src.startsWith("data:image/") && !src.startsWith("data:image/svg")) return { src };
        if (/^https?:\/\//i.test(src) || src.startsWith("//")) {
          const hit = pics.get(src);
          return hit === undefined ? { link: src } : hit;
        }
        const p = inRepo(src);
        if (p === null) return null;
        if (dir !== null) {
          const bytes = vfs.read(`${dir}/${p}`);
          if (bytes !== null) {
            const ext = (p.split(".").pop() ?? "").toLowerCase();
            const url = URL.createObjectURL(new Blob([bytes.slice()], { type: MIME[ext] ?? "application/octet-stream" }));
            blobs.push(url);
            return { src: url };
          }
        }
        if (repo === null) return null;
        const hit = pics.get(rawUrl(repo, p));
        return hit === undefined ? { link: blobUrl(repo, p) } : hit;
      },
      prepare: async (html: string): Promise<void> => {
        const wanted = new Set<string>();
        for (const m of html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
          const src = m[2] ?? m[3] ?? m[4] ?? "";
          if (/^https?:\/\//i.test(src) || src.startsWith("//")) wanted.add(src.startsWith("//") ? `https:${src}` : src);
          else if (repo !== null && !src.startsWith("data:")) {
            const p = inRepo(src);
            if (p !== null && (dir === null || vfs.read(`${dir}/${p}`) === null)) wanted.add(rawUrl(repo, p));
          }
        }
        await Promise.all([...wanted].map(async (u) => pics.set(u, await picture(u))));
        // The same picture under the address the HTML wrote it with.
        for (const m of html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*"(\/\/[^"]*)"/gi)) pics.set(m[1]!, pics.get(`https:${m[1]!}`) ?? null);
      },
    };
  };

  // --- documentation ------------------------------------------------------------

  const readmeText = async (dir: string, repo: Repo | null): Promise<{ text: string; from: string } | null> => {
    const local = readmeName(vfs.list(dir).filter((e) => !e.isDir).map((e) => e.name));
    if (local !== null) {
      const t = vfs.readText(`${dir}/${local}`);
      if (t !== null && t.trim() !== "") return { text: t, from: "the copy installed with the script" };
    }
    if (repo === null) return null;
    for (const name of README_NAMES) {
      try {
        const r = await get(rawUrl(repo, name));
        if (r.ok) return { text: await r.text(), from: `${repo.owner}/${repo.repo} on GitHub` };
      } catch {
        return null;
      }
    }
    return null;
  };

  const drawDoc = async (name: string, box: HTMLElement): Promise<void> => {
    const dir = `/home/we/dust/code/${name}`;
    say(box, "reading the README…");
    const entry = await opts.entry(name).catch(() => null);
    const repo = githubRepo(entry?.url);
    const got = await readmeText(dir, repo);
    box.replaceChildren();
    const head = el("div", "inf-head");
    // The catalogue's one line, when there is no README to say more (a README
    // nearly always opens with the same line).
    if (got === null && entry !== null && entry.description !== "") head.append(el("p", "inf-desc", entry.description));
    const links = el("div", "st-d-links");
    if (entry?.documentation && !(repo !== null && githubRepo(entry.documentation)?.repo === repo.repo)) {
      links.append(out("documentation ↗", entry.documentation));
    }
    if (repo !== null) links.append(out("source ↗", `https://github.com/${repo.owner}/${repo.repo}`));
    if (links.childElementCount > 0) head.append(links);
    if (head.childElementCount > 0) box.append(head);
    if (got === null) {
      // No README anywhere: the comment at the top of the script is what
      // norns itself shows in SELECT, and it is often the whole manual.
      const path = opts.script();
      const source = path !== null && nameOf(path) === name ? vfs.readText(path) : null;
      const header = source === null ? null : headerComment(source);
      if (header !== null) {
        box.append(el("pre", "inf-header", header));
        box.append(el("p", "inf-from", `no README — this is the comment at the top of ${path!.split("/").pop()}, as norns shows it in SELECT`));
        return;
      }
      say(box, entry === null ? `${name} has no README here, and is not in the catalogue.` : `no README was found for ${name}.`);
      return;
    }
    const doc = el("div", "inf-doc");
    // Loaded the first time a README is shown, not with the page.
    const { marked } = await import("marked");
    const html = await marked.parse(got.text, { gfm: true, async: true });
    const resolver = readmeResolver(dir, repo);
    await resolver.prepare(html);
    sanitizeInto(html, resolver, doc);
    box.append(doc, el("p", "inf-from", `README — ${got.from}`));
  };

  // --- discussion ---------------------------------------------------------------

  const drawPosts = async (posts: readonly Post[], into: HTMLElement): Promise<void> => {
    const up = await relay();
    for (const p of posts) {
      const art = el("article", "inf-post");
      const meta = el("div", "inf-post-meta");
      if (p.avatar !== null) {
        const via = relayImage(p.avatar);
        const img = el("img", "inf-avatar");
        img.alt = "";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        if (via !== null && up) img.src = via;
        else {
          img.crossOrigin = "anonymous";
          img.src = p.avatar;
        }
        meta.append(img);
      }
      meta.append(el("strong", "", p.name || p.username));
      if (p.name !== "" && p.username !== "") meta.append(el("span", "inf-dim", `@${p.username}`));
      meta.append(el("span", "inf-dim", `#${p.number} · ${p.created.slice(0, 10)}`));
      const content = el("div", "inf-doc inf-post-body");
      const imgs = new Map<string, { src: string; cors?: boolean } | { link: string } | null>();
      const wanted = new Set<string>();
      for (const m of p.html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*"([^"]*)"/gi)) wanted.add(onLines(m[1]!));
      await Promise.all([...wanted].map(async (u) => imgs.set(u, await picture(u))));
      sanitizeInto(
        p.html,
        {
          link: (href) => {
            const u = onLines(href);
            return /^(https?:|mailto:)/i.test(u) ? u : null;
          },
          image: (src) => imgs.get(onLines(src)) ?? { link: onLines(src) },
        },
        content,
      );
      art.append(meta, content);
      into.append(art);
    }
  };

  const drawTalk = async (name: string, box: HTMLElement): Promise<void> => {
    say(box, "reading the discussion…");
    const entry = await opts.entry(name).catch(() => null);
    const number = linesTopic(entry?.discussion);
    const slug = linesSlug(entry?.discussion);
    box.replaceChildren();
    if (number === null && slug === null) {
      if (entry?.discussion) {
        say(box, "the discussion for this script is not on lines, so it opens where it is:");
        box.append(out("discussion ↗", entry.discussion));
      } else say(box, `no discussion is listed for ${name} in the catalogue.`);
      return;
    }
    const thread = entry!.discussion!;
    if (!(await relay())) {
      say(box, "lines does not let a page read it directly, and the server this page came from has no relay for it:");
      box.append(out("open the discussion on lines ↗", thread));
      return;
    }
    // By number when the link has one; by name when it does not, and by a
    // search of titles when lines does not know the name either (the short
    // links' names were the shortener's own, not the thread's).
    let topic: number | string = number ?? slug!;
    let found: string | null = null;
    if (number === null) {
      const byName = await get(topicPath(slug!, 1)).catch(() => null);
      if (byName === null || !byName.ok) {
        const search = await get(searchPath(slug!)).catch(() => null);
        const hit = search !== null && search.ok ? searchHit(await search.json().catch(() => null), slug!) : null;
        if (hit === null) {
          say(box, `the catalogue's link for this discussion (${thread}) leads nowhere now, and lines has no thread by that name:`);
          box.append(out("search lines ↗", `https://llllllll.co/search?q=${encodeURIComponent(slug!.replace(/-/g, " "))}`));
          return;
        }
        topic = hit.id;
        found = slug!.replace(/-/g, " ");
      }
    }
    const list = el("div", "inf-posts");
    const foot = el("div", "inf-foot");
    let page = 1;
    let shown = 0;
    let total = 0;
    const more = async (): Promise<void> => {
      foot.replaceChildren(el("span", "inf-dim", "loading…"));
      let res: Response;
      try {
        res = await get(topicPath(topic, page));
      } catch (e) {
        foot.replaceChildren(el("span", "inf-note", `lines could not be reached: ${(e as Error).message}`), out("open on lines ↗", thread));
        return;
      }
      if (!res.ok) {
        const why = (await res.text().catch(() => "")).slice(0, 200);
        foot.replaceChildren(el("span", "inf-note", `lines answered ${res.status}${why ? ` (${why})` : ""}`), out("open on lines ↗", thread));
        return;
      }
      const t = topicPage(await res.json());
      if (page === 1) {
        total = t.postsCount;
        // The next pages by number, whatever found the first.
        if (t.id > 0) topic = t.id;
        const at = t.id > 0 ? `https://llllllll.co/t/${t.id}` : thread;
        const head = el("div", "inf-head");
        head.append(el("h2", "inf-topic", t.title || name));
        if (found !== null) {
          head.append(el("p", "inf-note", `the catalogue's link no longer leads anywhere; this is the thread a search of lines' titles found for “${found}”.`));
        }
        const links = el("div", "st-d-links");
        links.append(out(`${total} posts on lines ↗`, at));
        head.append(links);
        box.prepend(head);
      }
      await drawPosts(t.posts, list);
      shown += t.posts.length;
      page++;
      foot.replaceChildren();
      if (t.posts.length > 0 && shown < total) {
        const b = el("button", "st-out inf-more", `more (${total - shown} left)`);
        b.addEventListener("click", () => void more());
        foot.append(b);
      }
    };
    box.append(list, foot);
    await more();
  };

  // --- the sheet --------------------------------------------------------------------

  const show = (which: Tab): void => {
    tabDoc.setAttribute("aria-pressed", String(which === "doc"));
    tabTalk.setAttribute("aria-pressed", String(which === "talk"));
    const name = nameOf(opts.script());
    if (name === null) {
      title.textContent = "info";
      body.replaceChildren(el("p", "inf-note", "no script is loaded. choose one in SELECT, or in scripts."));
      return;
    }
    title.replaceChildren(el("strong", "", name));
    if (shownFor !== name) {
      for (const b of blobs) URL.revokeObjectURL(b);
      blobs = [];
      drawn.clear();
      shownFor = name;
    }
    const key = `${which}`;
    let box = drawn.get(key);
    if (box === undefined) {
      box = el("div", "inf-pane");
      drawn.set(key, box);
      const target = box;
      const work = which === "doc" ? drawDoc(name, target) : drawTalk(name, target);
      void work.catch((e: unknown) => {
        target.replaceChildren(el("p", "inf-note", `could not be shown: ${(e as Error)?.message ?? String(e)}`));
        drawn.delete(key);
      });
    }
    body.replaceChildren(box);
    body.scrollTop = 0;
  };

  const panel: InfoPanel = {
    isOpen: () => !host.hidden,
    open(which: Tab = "doc") {
      host.hidden = false;
      show(which);
      opts.onToggle?.(true);
      close.focus({ preventScroll: true });
    },
    close() {
      if (host.hidden) return;
      host.hidden = true;
      opts.onToggle?.(false);
    },
  };

  tabDoc.addEventListener("click", () => show("doc"));
  tabTalk.addEventListener("click", () => show("talk"));
  close.addEventListener("click", () => panel.close());
  // The backdrop closes it; the sheet does not.
  host.addEventListener("mousedown", (e) => {
    if (e.target === host) panel.close();
  });
  host.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      panel.close();
    }
  });
  // A README's own anchors scroll the sheet, under the names sanitize.ts gave them.
  body.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.("a[href^='#']");
    if (a === null || a === undefined) return;
    e.preventDefault();
    const id = decodeURIComponent((a.getAttribute("href") ?? "").slice(1)).toLowerCase();
    body.querySelector(`#inf-${CSS.escape(id)}`)?.scrollIntoView({ block: "start" });
  });
  return panel;
}
