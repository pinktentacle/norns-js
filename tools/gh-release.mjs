// E9-227 — a GitHub release file, fetched by the server the page came from.
//
// mx.samples downloads its instruments, and moonraker's README its sample
// pack, from GitHub RELEASES. A page cannot fetch those: github.com answers
// with a redirect and no `Access-Control-Allow-Origin`, and so does the
// host it redirects to. E9-226 asks a person for the file instead. This
// asks the page's OWN server, which is under no such rule: the page asks
// its own origin for `/gh-release/<owner>/<repo>/releases/…`, and the
// server fetches that one GitHub URL and streams the answer back.
//
// ONE MODULE, FOUR CALLERS, so they cannot drift: the Cloudflare Pages
// Function (`functions/gh-release/`), the portable copy's server and the
// desktop shell (both through `tools/serve.mjs` / `desktop/main.js`), and
// the dev server (`vite.config.ts`). No imports: it has to bundle for
// Cloudflare's runtime as well as run in Node and Electron. `fetch` is
// handed in, because each of them has its own.
//
// NOT AN OPEN PROXY. Only the two shapes of a release download are relayed
// — `releases/download/<tag>/<file>` and `releases/latest/download/<file>`
// on github.com — GET or HEAD only, with no cookie and no header from the
// asker passed on, and the answer has to come from GitHub's own hosts. A
// browser says where a request came from (`Sec-Fetch-Site`); one from
// another site, or typed into the address bar, is refused, so the relay
// cannot be hot-linked. A request with no such header (curl) is served: it
// could fetch github.com itself just as well.

export const RELAY_PREFIX = "/gh-release/";

/** Marks an answer as the relay's, so the page can tell it from an SPA fallback. */
export const RELAY_HEADER = "X-Norns-Relay";

const OWNER = /^[A-Za-z0-9_.-]+$/;
/** Where GitHub sends a release download, and the only hosts an answer may come from. */
const GITHUB_HOST = /^(github\.com|([a-z0-9-]+\.)*githubusercontent\.com)$/;

/** One path segment: percent-encoded as it came, never `.`/`..`, never a slash once decoded. */
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
 * The github.com URL a relay path stands for, or null when it is not a
 * release download. `/gh-release/schollz/moonraker/releases/download/
 * samplepack1/moonraker.zip` → `https://github.com/schollz/moonraker/
 * releases/download/samplepack1/moonraker.zip`.
 */
export function releaseTarget(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith(RELAY_PREFIX)) return null;
  const s = pathname.slice(RELAY_PREFIX.length).split("/");
  if (s.length !== 6) return null;
  const [owner, repo, releases, a, b, file] = s;
  if (!OWNER.test(owner) || !OWNER.test(repo) || owner === "." || owner === ".." || repo === "." || repo === "..") {
    return null;
  }
  if (releases !== "releases" || !segment(file)) return null;
  const tagged = a === "download" && segment(b);
  const latest = a === "latest" && b === "download";
  if (!tagged && !latest) return null;
  return `https://github.com/${owner}/${repo}/releases/${a}/${b}/${file}`;
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/**
 * Answer one relay request, as a web `Response`.
 *
 *   fetch   — the runtime's own (wrapped: Cloudflare's refuses to be
 *             called detached from its global)
 *   method  — the request's
 *   site    — its `Sec-Fetch-Site` header, or null
 */
export async function relayRelease(pathname, { fetch, method = "GET", site = null }) {
  const say = (status, text) =>
    new Response(text, {
      status,
      headers: { [RELAY_HEADER]: "1", "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });

  if (method !== "GET" && method !== "HEAD") return say(405, "only GET");
  if (site !== null && site !== undefined && site !== "" && site !== "same-origin") {
    return say(403, "only the page this server serves may ask");
  }
  const target = releaseTarget(pathname);
  if (target === null) return say(404, "not a GitHub release download");

  let res;
  try {
    res = await fetch(target, {
      method,
      redirect: "follow",
      headers: { "User-Agent": "norns-js", Accept: "application/octet-stream" },
    });
  } catch (e) {
    return say(502, `github could not be reached: ${e?.message ?? e}`);
  }
  const from = res.url ? hostOf(res.url) : null;
  if (from !== null && !GITHUB_HOST.test(from)) {
    await res.body?.cancel().catch(() => {});
    return say(502, `github sent the download somewhere else (${from})`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return say(res.status === 404 ? 404 : 502, `github answered ${res.status} for ${target}`);
  }

  const headers = new Headers({
    [RELAY_HEADER]: "1",
    // The bytes land in the page's own storage; a second copy in the
    // browser's HTTP cache would only take the room twice.
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream",
  });
  // A length only when the body is passed on as it came: a decoded body
  // is not the length the header says.
  const length = res.headers.get("Content-Length");
  if (length !== null && res.headers.get("Content-Encoding") === null) headers.set("Content-Length", length);
  for (const h of ["Last-Modified", "ETag"]) {
    const v = res.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  return new Response(method === "HEAD" ? null : res.body, { status: 200, headers });
}
