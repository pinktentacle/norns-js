// E9-227 — a GitHub release file, asked of the page's own server.
//
// github.com answers a page's fetch of a release download with a redirect
// and no CORS header, so the browser refuses it (E9-226 then asks a person
// for the file). The server this page came from has no such rule: it
// relays `/gh-release/<owner>/<repo>/releases/…` (tools/gh-release.mjs —
// Cloudflare, the portable copy, the desktop shell and the dev server all
// answer it). Here is the page's half: which URLs go that way, and the
// fetch that tries the relay first.
//
// A SERVER WITHOUT THE RELAY IS EXPECTED, not an error: somebody serving
// `dist/` with any static server, or the Steam Deck's Python one. It may
// answer 404, or answer 200 with index.html (an SPA fallback), so only an
// answer carrying the relay's own header counts; anything else and the
// URL is fetched as it is — which fails for GitHub exactly as before, and
// the person is asked for the file as before.

export const RELAY_PREFIX = "/gh-release/";
export const RELAY_HEADER = "X-Norns-Relay";

const RELEASE =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/(download\/[^/?#]+|latest\/download)\/([^/?#]+)$/;

/** The same-origin path that relays `url`, or null when it is not a GitHub release download. */
export function relayPath(url: string): string | null {
  const m = RELEASE.exec(url.trim());
  if (m === null) return null;
  const [, owner, repo, which, file] = m;
  if ([owner, repo].some((s) => s === "." || s === "..")) return null;
  return `${RELAY_PREFIX}${owner}/${repo}/releases/${which}/${file}`;
}

export interface RelayFetchOptions {
  readonly fetch: (url: string) => Promise<Response>;
  /** Bytes so far, and the whole when the answer said. */
  readonly onProgress?: (got: number, total: number | null) => void;
}

export interface Fetched {
  readonly ok: boolean;
  readonly status: number;
  readonly bytes: Uint8Array;
  /** True when the page's server fetched it. */
  readonly relayed: boolean;
}

/** Read a body, saying how far it has got. */
async function readAll(res: Response, onProgress?: RelayFetchOptions["onProgress"]): Promise<Uint8Array> {
  const total = Number(res.headers.get("Content-Length") ?? "");
  const whole = Number.isFinite(total) && total > 0 ? total : null;
  if (res.body === null || onProgress === undefined) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, whole);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Fetch `url`, through the page's own server when it is a GitHub release
 * download and that server relays. Throws what `fetch` throws (a browser's
 * CORS refusal is a TypeError), as a plain fetch would.
 */
export async function fetchFile(url: string, opts: RelayFetchOptions): Promise<Fetched> {
  const path = relayPath(url);
  if (path !== null) {
    let res: Response | null = null;
    try {
      res = await opts.fetch(path);
    } catch {
      res = null; // no relay to talk to: fetched as it is, below
    }
    if (res !== null && res.headers.get(RELAY_HEADER) !== null) {
      if (!res.ok) return { ok: false, status: res.status, bytes: new Uint8Array(), relayed: true };
      return { ok: true, status: res.status, bytes: await readAll(res, opts.onProgress), relayed: true };
    }
    await res?.body?.cancel().catch(() => {});
  }
  const res = await opts.fetch(url);
  if (!res.ok) return { ok: false, status: res.status, bytes: new Uint8Array(), relayed: false };
  return { ok: true, status: res.status, bytes: await readAll(res, opts.onProgress), relayed: false };
}

/** A progress reporter that speaks every quarter, not every chunk. */
export function quarters(say: (line: string) => void, what: string): (got: number, total: number | null) => void {
  let told = 0;
  return (got, total) => {
    if (total === null || total < 4 * 1048576) return; // small files arrive before anyone wonders
    const q = Math.floor((got / total) * 4);
    if (q <= told || q >= 4) return;
    told = q;
    say(`fetch: ${what} — ${(got / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB`);
  };
}
