// E9-277 — what the `info` sheet shows about a script, fetched by the
// server the page came from.
//
// The sheet shows a script's README and its discussion on lines. The README
// a page can read itself (raw.githubusercontent and jsDelivr send CORS). The
// discussion it cannot: llllllll.co's topic JSON comes with no
// `Access-Control-Allow-Origin`, and the thread itself may not be framed
// (`frame-ancestors 'self'`) — nor could it be, in a page that is
// cross-origin isolated. Pictures are the same story: a README's screenshots
// are on user-images.githubusercontent.com, which sends neither CORS nor
// CORP, so an isolated page may not show them; the desktop shell's policy
// allows no outside image at all.
//
// So, like the release relay (gh-release.mjs), the page asks its OWN server:
//
//   /info-relay/lines/<topic id>/<page>.json   one page of a lines topic
//   /info-relay/lines/s/<slug>/<page>.json     the same, by its name: 41
//                                              catalogue links have no number
//   /info-relay/lines/q/<words>.json           a search of topic titles, for
//                                              the l.llllllll.co short links
//                                              (that host's certificate has
//                                              expired: they lead nowhere)
//   /info-relay/img/<host>/<path>              one picture, from a short list
//
// ONE MODULE, FOUR CALLERS — the Cloudflare Pages Function
// (`functions/info-relay/`), the portable copy's server and the desktop
// shell, and the dev server — so they cannot drift. No imports.
//
// NOT AN OPEN PROXY. Only those two shapes; GET or HEAD; no cookie and no
// header from the asker passed on; a topic is a number and a page a small
// one; a picture comes from one of the hosts below, by the paths they keep
// pictures under, and has to come back as an image, from one of them. A
// browser says where a request came from (`Sec-Fetch-Site`): one from
// another site, or typed into the address bar, is refused.
export const INFO_PREFIX = "/info-relay/";
/** Marks an answer as the relay's, so the page can tell it from an SPA fallback. */
export const INFO_HEADER = "X-Norns-Relay";

const LINES = "https://llllllll.co";
const LINES_HOST = /^(l\.)?llllllll\.co$/;

/**
 * Where pictures may be asked for: host, and the paths it keeps them under.
 * github.com only for a repository's `raw` / `blob` files and attachments,
 * which it redirects to its content hosts.
 */
const IMAGE_SOURCES = [
  [/^(user-images|raw|camo|avatars|private-user-images)\.githubusercontent\.com$/, /^\/.+/],
  [/^github\.com$/, /^\/(user-attachments\/assets\/[0-9a-fA-F-]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(raw|blob)\/.+)$/],
  [/^cdn\.jsdelivr\.net$/, /^\/gh\/.+/],
  [LINES_HOST, /^\/(uploads|user_avatar|images\/emoji|letter_avatar_proxy|letter_avatar)\/.+/],
  // The pictures of a link preview in a post: a video's still, a repository's card.
  [/^(i\.ytimg\.com|img\.youtube\.com)$/, /^\/vi\/.+/],
  [/^i\.vimeocdn\.com$/, /^\/video\/.+/],
  [/^opengraph\.githubassets\.com$/, /^\/.+/],
];
/** Where an answer may come from, after redirects. */
const LANDING =
  /^((([a-z0-9-]+\.)*githubusercontent\.com)|github\.com|cdn\.jsdelivr\.net|(l\.)?llllllll\.co|i\.ytimg\.com|img\.youtube\.com|i\.vimeocdn\.com|opengraph\.githubassets\.com)$/;

const TOPIC_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MAX_BYTES = 12 * 1024 * 1024;

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** One path segment, never `.`/`..`, never a slash or a backslash once decoded. */
function segment(s) {
  if (s === undefined || s === "" || s === "." || s === ".." || /[?#\\]/.test(s)) return false;
  try {
    const d = decodeURIComponent(s);
    return d !== "." && d !== ".." && !/[/\\]/.test(d);
  } catch {
    return false;
  }
}

/**
 * What a relay path stands for: `{ kind: "lines", url }`, `{ kind: "img", url }`,
 * `{ kind: "ping" }`, or null when it is none of them.
 */
export function infoTarget(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith(INFO_PREFIX)) return null;
  const rest = pathname.slice(INFO_PREFIX.length);
  if (rest === "ping") return { kind: "ping" };
  const t = /^lines\/(\d{1,9}|s\/[a-z0-9][a-z0-9-]{0,119})\/(\d{1,3})\.json$/.exec(rest);
  if (t !== null) {
    const page = Number(t[2]);
    if (page < 1) return null;
    const topic = t[1].startsWith("s/") ? t[1].slice(2) : t[1];
    return { kind: "lines", url: `${LINES}/t/${topic}.json${page > 1 ? `?page=${page}` : ""}` };
  }
  const q = /^lines\/q\/([a-z0-9][a-z0-9-]{0,79})\.json$/.exec(rest);
  if (q !== null) {
    const words = q[1].split("-").filter(Boolean).join(" ");
    return { kind: "lines", url: `${LINES}/search.json?q=${encodeURIComponent(`${words} in:title`)}` };
  }
  const m = /^img\/([a-z0-9.-]+)(\/.+)$/.exec(rest);
  if (m === null) return null;
  const [, host, path] = m;
  if (!path.split("/").slice(1).every(segment)) return null;
  const allowed = IMAGE_SOURCES.some(([h, p]) => h.test(host) && p.test(path));
  if (!allowed) return null;
  // A file on github.com's `blob` page is the page; `?raw=true` is the file.
  const raw = host === "github.com" && /^\/[^/]+\/[^/]+\/blob\//.test(path) ? "?raw=true" : "";
  return { kind: "img", url: `https://${host}${path}${raw}` };
}

/** Read at most `max` bytes of a body, or null when it is longer. */
async function readCapped(res, max) {
  const length = Number(res.headers.get("Content-Length") ?? "0");
  if (length > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length > max ? null : buf;
}

/**
 * Answer one relay request, as a web `Response`.
 *
 *   fetch   — the runtime's own (wrapped: Cloudflare's refuses to be called
 *             detached from its global)
 *   method  — the request's
 *   site    — its `Sec-Fetch-Site` header, or null
 */
export async function relayInfo(pathname, { fetch, method = "GET", site = null }) {
  const say = (status, text) =>
    new Response(text, {
      status,
      headers: { [INFO_HEADER]: "1", "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });

  if (method !== "GET" && method !== "HEAD") return say(405, "only GET");
  if (site !== null && site !== undefined && site !== "" && site !== "same-origin") {
    return say(403, "only the page this server serves may ask");
  }
  const target = infoTarget(pathname);
  if (target === null) return say(404, "not something the info sheet shows");
  if (target.kind === "ping") return say(200, "info relay");

  let res;
  try {
    res = await fetch(target.url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "norns-js",
        Accept: target.kind === "lines" ? "application/json" : "image/*",
      },
    });
  } catch (e) {
    return say(502, `${hostOf(target.url)} could not be reached: ${e?.message ?? e}`);
  }
  const from = res.url ? hostOf(res.url) : null;
  if (from !== null && !LANDING.test(from)) {
    await res.body?.cancel().catch(() => {});
    return say(502, `the answer came from somewhere else (${from})`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return say(res.status === 404 ? 404 : 502, `${hostOf(target.url)} answered ${res.status}`);
  }
  const type = (res.headers.get("Content-Type") ?? "").toLowerCase();
  if (target.kind === "lines" ? !type.startsWith("application/json") : !type.startsWith("image/")) {
    await res.body?.cancel().catch(() => {});
    return say(502, `${hostOf(target.url)} answered with ${type || "no type"}`);
  }
  const body = await readCapped(res, target.kind === "lines" ? TOPIC_MAX_BYTES : IMAGE_MAX_BYTES);
  if (body === null) return say(502, "too large to show");

  const headers = new Headers({
    [INFO_HEADER]: "1",
    "Content-Type": type,
    // A thread changes; a picture does not.
    "Cache-Control": target.kind === "lines" ? "public, max-age=300" : "public, max-age=86400",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    // An SVG is an image in an <img>, and a DOCUMENT of this origin if
    // anything ever navigated to it: sandboxed, it can run nothing.
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Content-Length": String(body.length),
  });
  return new Response(method === "HEAD" ? null : body, { status: 200, headers });
}
