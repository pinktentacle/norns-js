// E9-277 — what the `info` sheet needs to know about a script, without a page.
//
// The sheet (src/ui/info-panel.ts) shows the script's README and its thread
// on lines. Everything here is a decision about addresses — which repository,
// which topic, where a relative picture lives, which pictures go through the
// page's own server (tools/info-relay.mjs) — kept apart so it can be tested
// in node.

import { INFO_PREFIX, infoTarget } from "../../tools/info-relay.mjs";

export { INFO_PREFIX };

export interface Repo {
  readonly owner: string;
  readonly repo: string;
}

/** `https://github.com/schollz/makebreakbeat(.git)(/…)` → owner and repository. */
export function githubRepo(url: string | null | undefined): Repo | null {
  if (!url) return null;
  const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(url.trim());
  if (m === null) return null;
  const [, owner, repo] = m as unknown as [string, string, string];
  if ([owner, repo].some((s) => s === "." || s === "..")) return null;
  return { owner, repo };
}

/**
 * The topic number of a lines thread: `https://llllllll.co/t/makebreakbeat/53301`,
 * `…/t/53301`, `…/t/slug/53301/12` (a post in it), and the `l.llllllll.co`
 * spelling twelve catalogue entries use.
 */
export function linesTopic(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = /^https?:\/\/(?:l\.)?llllllll\.co\/t\/(?:[^/?#]+\/)?(\d+)(?:\/\d+)?\/?(?:[?#].*)?$/.exec(url.trim());
  return m === null ? null : Number(m[1]);
}

/**
 * A lines thread named without its number, as 41 catalogue links are:
 * `llllllll.co/t/bitters-norns` (lines redirects it), or the short link
 * `l.llllllll.co/cheat-codes-2`, whose host no longer answers (its
 * certificate has expired) — found by searching titles instead.
 */
export function linesSlug(url: string | null | undefined): string | null {
  if (!url || linesTopic(url) !== null) return null;
  const m = /^https?:\/\/(?:(?:l\.)?llllllll\.co\/t|l\.llllllll\.co)\/([A-Za-z0-9][A-Za-z0-9-]*)\/?(?:[?#].*)?$/.exec(url.trim());
  if (m === null) return null;
  const slug = m[1]!.toLowerCase();
  return slug.length <= 120 ? slug : null;
}

/** One page of a topic, through the page's own server: by number, or by name. */
export function topicPath(topic: number | string, page: number): string {
  return typeof topic === "number" ? `${INFO_PREFIX}lines/${topic}/${page}.json` : `${INFO_PREFIX}lines/s/${topic}/${page}.json`;
}

/** A search of lines' topic titles for these words (a slug's), through the page's own server. */
export function searchPath(slug: string): string {
  return `${INFO_PREFIX}lines/q/${slug.slice(0, 80).replace(/-+$/, "")}.json`;
}

/**
 * The topic a title search found for a slug: one whose own slug starts with
 * it (`cheat-codes-2` → `cheat-codes-2-rev-250929-lts13-3`), else the first.
 */
export function searchHit(json: unknown, slug: string): { id: number; title: string } | null {
  const root = (json ?? {}) as Record<string, unknown>;
  const topics = (Array.isArray(root["topics"]) ? root["topics"] : []) as Array<Record<string, unknown>>;
  const ok = topics.filter((t) => typeof t["id"] === "number" && typeof t["slug"] === "string");
  const best = ok.find((t) => (t["slug"] as string).startsWith(slug)) ?? ok[0];
  return best === undefined ? null : { id: best["id"] as number, title: typeof best["title"] === "string" ? (best["title"] as string) : "" };
}

/** The README among a folder's files, `.md` first. Null when there is none. */
export function readmeName(files: readonly string[]): string | null {
  const hits = files.filter((f) => /^readme(\.(md|markdown|txt))?$/i.test(f));
  if (hits.length === 0) return null;
  return hits.find((f) => /\.(md|markdown)$/i.test(f)) ?? hits[0]!;
}

/**
 * A script's opening comment: the lines norns shows in SELECT, and for a
 * script with no README (awake has none) the only manual there is — its
 * keys and encoders, written by its author at the top of the file. The
 * leading `--` lines, without the dashes; null when there are none.
 */
export function headerComment(source: string): string | null {
  const lines: string[] = [];
  for (const raw of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (lines.length === 0 && line.trim() === "") continue;
    const m = /^\s*--(?!\[\[)(.*)$/.exec(line);
    if (m === null) break;
    lines.push(m[1]!.replace(/^ /, ""));
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.length === 0 ? null : lines.join("\n");
}

/** The names a README is fetched under from a repository, in order. */
export const README_NAMES = ["README.md", "readme.md", "Readme.md", "README.markdown", "README"] as const;

/** A file of the repository's default branch, as raw bytes (CORS: yes). */
export function rawUrl(r: Repo, path: string): string {
  return `https://raw.githubusercontent.com/${r.owner}/${r.repo}/HEAD/${path.replace(/^\/+/, "")}`;
}

/** The same file's page on GitHub, for a link. */
export function blobUrl(r: Repo, path: string): string {
  return `https://github.com/${r.owner}/${r.repo}/blob/HEAD/${path.replace(/^\/+/, "")}`;
}

/** Is this a link that stays where it is: an anchor, or a scheme of its own? */
const absolute = (u: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("//");

/**
 * A README's relative address made whole: the folder it sits in, inside the
 * repository. `docs/a.png` from `README.md` is `docs/a.png`; `../x` cannot
 * leave the repository.
 */
export function inRepo(relative: string): string | null {
  const clean = relative.split(/[?#]/)[0]!;
  const parts: string[] = [];
  for (const seg of clean.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length === 0 ? null : parts.join("/");
}

/**
 * The page's own address for a picture, or null when the relay does not take
 * it. One list, the relay's own (`infoTarget`), so the two cannot disagree.
 */
export function relayImage(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.startsWith("//") ? `https:${url}` : url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const path = `${INFO_PREFIX}img/${u.hostname}${u.pathname}`;
  return infoTarget(path) === null ? null : path;
}

/** An address on lines, made whole: `/u/x` and `//llllllll.co/…` both happen in a post. */
export function onLines(href: string): string {
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `https://llllllll.co${href}`;
  return href;
}

export { absolute as isAbsolute };

export interface Post {
  readonly number: number;
  readonly name: string;
  readonly username: string;
  /** The avatar, whole, at 90 pixels. */
  readonly avatar: string | null;
  /** ISO date and time. */
  readonly created: string;
  /** Discourse's own HTML for the post ("cooked"); sanitized where it is shown. */
  readonly html: string;
}

export interface TopicPage {
  /** Its number: a topic found by name is paged by number after the first page. */
  readonly id: number;
  readonly title: string;
  readonly postsCount: number;
  readonly posts: readonly Post[];
}

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** One page of Discourse's topic JSON, as the sheet shows it. Someone else's file: every field checked. */
export function topicPage(json: unknown): TopicPage {
  const root = (json ?? {}) as Record<string, unknown>;
  const stream = (root["post_stream"] ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(stream["posts"]) ? (stream["posts"] as unknown[]) : [];
  const posts: Post[] = [];
  for (const item of raw) {
    const p = (item ?? {}) as Record<string, unknown>;
    if (n(p["post_type"]) > 1 && n(p["post_type"]) !== 4) continue; // moderator actions, small notices
    const tpl = s(p["avatar_template"]);
    posts.push({
      number: n(p["post_number"]),
      name: s(p["name"]),
      username: s(p["username"]),
      avatar: tpl === "" ? null : onLines(tpl.replace("{size}", "90")),
      created: s(p["created_at"]),
      html: s(p["cooked"]),
    });
  }
  return { id: n(root["id"]), title: s(root["title"]), postsCount: n(root["posts_count"]), posts };
}
